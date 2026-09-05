import pg from "pg";

const { Pool } = pg;
const EIA_BASE = "https://api.eia.gov/v2";
const CPC_BASE = "https://ftp.cpc.ncep.noaa.gov/htdocs/degree_days/weighted";
const START = "2021-09-05";
const END = "2026-09-05";

function monthChunks(start = START, end = END) {
  const out = [];
  let d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d < stop) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const e = next < stop ? next : stop;
    out.push([d.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]);
    d = next;
  }
  return out;
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
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = [];
    const placeholders = batch.map((r, j) => {
      const p = j * 6;
      values.push("EIA", r.metric, "US48", new Date(r.at), r.value, "MWh");
      return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},'{}'::jsonb)`;
    });
    const q = `INSERT INTO observations (source,metric,region,observed_at,value,unit,metadata) VALUES ${placeholders.join(",")} ON CONFLICT (source,metric,region,observed_at) DO NOTHING`;
    n += (await client.query(q, values)).rowCount || 0;
  }
  return n;
}

async function backfillEia(client) {
  for (const [start, end] of monthChunks()) {
    const params = {
      frequency: "hourly",
      "data[]": "value",
      "facets[respondent][]": "US48",
      start,
      end,
      "sort[0][column]": "period",
      "sort[0][direction]": "asc"
    };

    const load = await eiaAll("/electricity/rto/region-data/data/", { ...params, "facets[type][]": "D" });
    const fuel = await eiaAll("/electricity/rto/fuel-type-data/data/", params);
    const rows = [];
    for (const r of load) {
      const at = String(r.period || "");
      const value = Number(r.value);
      if (Number.isFinite(value)) rows.push({ metric: "total_load", at, value });
    }
    const byPeriod = new Map();
    for (const r of fuel) {
      const at = String(r.period || ""), value = Number(r.value), fueltype = String(r.fueltype || "").toUpperCase();
      if (!Number.isFinite(value)) continue;
      if (!byPeriod.has(at)) byPeriod.set(at, {});
      const x = byPeriod.get(at);
      if (fueltype === "NG") x.gas_generation = value;
      if (fueltype === "WND") x.wind_generation = value;
      if (fueltype === "SUN") x.solar_generation = value;
      if (fueltype === "ALL") x.total_generation = value;
    }
    for (const [at, x] of byPeriod) for (const metric of ["gas_generation","wind_generation","solar_generation","total_generation"]) if (Number.isFinite(x[metric])) rows.push({ metric, at, value: x[metric] });
    const written = await upsertObservations(client, rows);
    await client.query(`INSERT INTO backfill_progress(dataset,start_date,end_date,cursor_date,status,updated_at,rows_written,error) VALUES ('eia-5y',$1,$2,$3,'running',now(),$4,NULL) ON CONFLICT(dataset) DO UPDATE SET cursor_date=EXCLUDED.cursor_date,status='running',updated_at=now(),rows_written=backfill_progress.rows_written+EXCLUDED.rows_written,error=NULL`, [START, END, end, written]);
  }
  await client.query(`UPDATE backfill_progress SET status='complete',cursor_date=$1,updated_at=now() WHERE dataset='eia-5y'`, [END]);
}

function parseCpc(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.find(x => x.startsWith("Region|"));
  const conus = lines.find(x => x.startsWith("CONUS|"));
  if (!head || !conus) return [];
  const dates = head.split("|").slice(1), vals = conus.split("|").slice(1), out = [];
  for (let i = 0; i < dates.length; i++) {
    const v = Number(vals[i]);
    if (/^\d{8}$/.test(dates[i]) && Number.isFinite(v) && v >= 0) out.push({ date: `${dates[i].slice(0,4)}-${dates[i].slice(4,6)}-${dates[i].slice(6)}`, value: v });
  }
  return out;
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "natgas-power-demand-backfill" } });
  if (!r.ok) throw new Error(`CPC ${r.status}`);
  return r.text();
}

async function backfillWeather(client) {
  for (let year = 2021; year <= 2026; year++) {
    const [ct, ht] = await Promise.all([
      getText(`${CPC_BASE}/daily_data/${year}/Population.Cooling.txt`),
      getText(`${CPC_BASE}/daily_data/${year}/Population.Heating.txt`)
    ]);
    const c = new Map(parseCpc(ct).map(x => [x.date, x.value]));
    const h = new Map(parseCpc(ht).map(x => [x.date, x.value]));
    const rows = [...new Set([...c.keys(), ...h.keys()])].filter(date => date >= START && date <= END).map(date => [date, h.get(date) ?? null, c.get(date) ?? null]);
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500), values = [], placeholders = batch.map((r, j) => { const p = j * 3; values.push(r[0], r[1], r[2]); return `($${p+1},$${p+2},$${p+3},COALESCE($${p+2},0)+COALESCE($${p+3},0),'NOAA/CPC')`; });
      await client.query(`INSERT INTO weather_daily(date,hdd,cdd,tdd,source) VALUES ${placeholders.join(",")} ON CONFLICT(date) DO UPDATE SET hdd=EXCLUDED.hdd,cdd=EXCLUDED.cdd,tdd=EXCLUDED.tdd,source=EXCLUDED.source`, values);
    }
  }
  await client.query(`INSERT INTO backfill_progress(dataset,start_date,end_date,cursor_date,status,updated_at) VALUES ('weather-5y',$1,$2,$2,'complete',now()) ON CONFLICT(dataset) DO UPDATE SET cursor_date=EXCLUDED.cursor_date,status='complete',updated_at=now()`, [START, END]);
}

export default async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await backfillEia(client);
    await backfillWeather(client);
    await client.query("COMMIT");
    return new Response(JSON.stringify({ ok: true, start: START, end: END }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); await pool.end(); }
};

export const config = { schedule: false };