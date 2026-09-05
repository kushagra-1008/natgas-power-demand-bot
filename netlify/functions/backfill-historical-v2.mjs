import pg from "pg";

const { Pool } = pg;
const EIA_BASE = "https://api.eia.gov/v2";
const CPC_BASE = "https://ftp.cpc.ncep.noaa.gov/htdocs/degree_days/weighted";
const START = "2021-09-05";
const END = "2026-09-05";
const CHUNK_DAYS = 30;

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let ms = Date.parse(s);
  if (!Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) {
    ms = Date.parse(`${s}:00:00Z`);
  }
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function eia(path, params) {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("Missing EIA_API_KEY");
  const url = new URL(`${EIA_BASE}${path}`);
  url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
    else url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`EIA ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function eiaAll(path, params) {
  const all = [];
  let offset = 0;
  while (true) {
    const payload = await eia(path, { ...params, offset, length: 5000 });
    const rows = payload?.response?.data || [];
    all.push(...rows);
    const total = Number(payload?.response?.total || 0);
    if (!rows.length || all.length >= total || rows.length < 5000) break;
    offset += rows.length;
  }
  return all;
}

async function upsertObservations(client, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = [];
    const placeholders = batch.map((r, j) => {
      const p = j * 6;
      values.push("EIA", r.metric, "US48", r.at, r.value, "MWh");
      return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},'{}'::jsonb)`;
    });
    const result = await client.query(
      `INSERT INTO observations (source,metric,region,observed_at,value,unit,metadata)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (source,metric,region,observed_at) DO NOTHING`,
      values
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

async function runEiaChunk(client, start, end) {
  const common = {
    frequency: "hourly",
    "data[]": "value",
    "facets[respondent][]": "US48",
    start,
    end,
    "sort[0][column]": "period",
    "sort[0][direction]": "asc"
  };
  const [load, fuel] = await Promise.all([
    eiaAll("/electricity/rto/region-data/data/", { ...common, "facets[type][]": "D" }),
    eiaAll("/electricity/rto/fuel-type-data/data/", common)
  ]);

  const rows = [];
  for (const r of load) {
    const value = Number(r.value);
    const at = parseTimestamp(r.period);
    if (Number.isFinite(value) && at) rows.push({ metric: "total_load", at, value });
  }

  const byPeriod = new Map();
  for (const r of fuel) {
    const value = Number(r.value);
    const at = parseTimestamp(r.period);
    if (!Number.isFinite(value) || !at) continue;
    const key = at.toISOString();
    const fueltype = String(r.fueltype || "").toUpperCase();
    if (!byPeriod.has(key)) byPeriod.set(key, {});
    const x = byPeriod.get(key);
    if (fueltype === "NG") x.gas_generation = value;
    if (fueltype === "WND") x.wind_generation = value;
    if (fueltype === "SUN") x.solar_generation = value;
    if (fueltype === "ALL") x.total_generation = value;
  }
  for (const [at, x] of byPeriod) {
    for (const metric of ["gas_generation", "wind_generation", "solar_generation", "total_generation"]) {
      if (Number.isFinite(x[metric])) rows.push({ metric, at: new Date(at), value: x[metric] });
    }
  }
  return upsertObservations(client, rows);
}

function parseCpc(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.find(x => x.startsWith("Region|"));
  const conus = lines.find(x => x.startsWith("CONUS|"));
  if (!head || !conus) return [];
  const dates = head.split("|").slice(1);
  const vals = conus.split("|").slice(1);
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const v = Number(vals[i]);
    if (/^\d{8}$/.test(dates[i]) && Number.isFinite(v) && v >= 0) {
      out.push({ date: `${dates[i].slice(0, 4)}-${dates[i].slice(4, 6)}-${dates[i].slice(6)}`, value: v });
    }
  }
  return out;
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "natgas-power-demand-backfill" } });
  if (!r.ok) throw new Error(`CPC ${r.status}`);
  return r.text();
}

async function runWeatherYear(client, year) {
  const [ct, ht] = await Promise.all([
    getText(`${CPC_BASE}/daily_data/${year}/Population.Cooling.txt`),
    getText(`${CPC_BASE}/daily_data/${year}/Population.Heating.txt`)
  ]);
  const c = new Map(parseCpc(ct).map(x => [x.date, x.value]));
  const h = new Map(parseCpc(ht).map(x => [x.date, x.value]));
  const rows = [...new Set([...c.keys(), ...h.keys()])]
    .filter(date => date >= START && date <= END)
    .map(date => [date, h.get(date) ?? null, c.get(date) ?? null]);

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = [];
    const placeholders = batch.map((r, j) => {
      const p = j * 3;
      values.push(r[0], r[1], r[2]);
      return `($${p + 1},$${p + 2},$${p + 3},COALESCE($${p + 2},0)+COALESCE($${p + 3},0),'NOAA/CPC')`;
    });
    await client.query(
      `INSERT INTO weather_daily(date,hdd,cdd,tdd,source)
       VALUES ${placeholders.join(",")}
       ON CONFLICT(date) DO UPDATE SET hdd=EXCLUDED.hdd,cdd=EXCLUDED.cdd,tdd=EXCLUDED.tdd,source=EXCLUDED.source`,
      values
    );
  }
}

async function progress(client, dataset) {
  const r = await client.query(`SELECT cursor_date,status FROM backfill_progress WHERE dataset=$1`, [dataset]);
  return r.rows[0] || null;
}

export default async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    const e = await progress(client, "eia-5y");
    if (!e || e.status !== "complete") {
      const start = e?.cursor_date || START;
      const end = addDays(start, CHUNK_DAYS) < END ? addDays(start, CHUNK_DAYS) : END;
      const written = await runEiaChunk(client, start, end);
      await client.query(
        `INSERT INTO backfill_progress(dataset,start_date,end_date,cursor_date,status,updated_at,rows_written,error)
         VALUES ('eia-5y',$1,$2,$3,$4,now(),$5,NULL)
         ON CONFLICT(dataset) DO UPDATE SET cursor_date=EXCLUDED.cursor_date,status=EXCLUDED.status,updated_at=now(),rows_written=backfill_progress.rows_written+EXCLUDED.rows_written,error=NULL`,
        [START, END, end, end >= END ? "complete" : "running", written]
      );
      return new Response(JSON.stringify({ ok: true, phase: "eia", start, end, written }), { headers: { "content-type": "application/json" } });
    }

    const w = await progress(client, "weather-5y");
    const year = w?.cursor_date ? Number(String(w.cursor_date).slice(0, 4)) + 1 : 2021;
    if (!w || w.status !== "complete") {
      if (year <= 2026) {
        await runWeatherYear(client, year);
        const complete = year === 2026;
        await client.query(
          `INSERT INTO backfill_progress(dataset,start_date,end_date,cursor_date,status,updated_at,rows_written,error)
           VALUES ('weather-5y',$1,$2,$3,$4,now(),0,NULL)
           ON CONFLICT(dataset) DO UPDATE SET cursor_date=EXCLUDED.cursor_date,status=EXCLUDED.status,updated_at=now(),error=NULL`,
          [START, END, `${year}-12-31`, complete ? "complete" : "running"]
        );
        return new Response(JSON.stringify({ ok: true, phase: "weather", year, complete }), { headers: { "content-type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ ok: true, phase: "complete", start: START, end: END }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500, headers: { "content-type": "application/json" } });
  } finally {
    client.release();
    await pool.end();
  }
};

export const config = { schedule: "*/5 * * * *" };