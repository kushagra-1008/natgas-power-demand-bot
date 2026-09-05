import { getStore } from "@netlify/blobs";
import pg from "pg";

const { Pool } = pg;
const store = () => getStore("natgas-power-demand");
const metrics = new Set(["gas_generation", "total_load", "wind_generation", "solar_generation", "total_generation"]);

function parseAt(value) {
  const s = String(value ?? "").trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function syncObservations(client, observations) {
  const rows = observations.filter(o => metrics.has(o?.signal) && Number.isFinite(Number(o?.value)) && Number.isFinite(parseAt(o?.at)));
  if (!rows.length) return 0;

  const maxResult = await client.query(`
    SELECT metric, MAX(observed_at) AS max_at
    FROM observations
    WHERE source = 'EIA' AND region = 'US48'
    GROUP BY metric
  `);
  const maxByMetric = new Map(maxResult.rows.map(r => [r.metric, r.max_at ? new Date(r.max_at).getTime() : -Infinity]));
  const newRows = rows.filter(o => parseAt(o.at) > (maxByMetric.get(o.signal) ?? -Infinity));

  let inserted = 0;
  for (const batch of chunks(newRows, 500)) {
    const values = [];
    const placeholders = batch.map((o, i) => {
      const n = i * 6;
      values.push("EIA", o.signal, "US48", new Date(parseAt(o.at)), Number(o.value), o.unit || "MWh");
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, '{}'::jsonb)`;
    });
    const result = await client.query(
      `INSERT INTO observations (source, metric, region, observed_at, value, metadata)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (source, metric, region, observed_at) DO NOTHING`,
      values
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

async function syncForecasts(client, observations, issuedAt) {
  const rows = observations.filter(o => o?.signal === "load_forecast" && Number.isFinite(Number(o?.value)) && Number.isFinite(parseAt(o?.at)));
  if (!rows.length) return 0;

  let inserted = 0;
  for (const batch of chunks(rows, 500)) {
    const values = [];
    const placeholders = batch.map((o, i) => {
      const n = i * 8;
      const targetAt = new Date(parseAt(o.at));
      const horizonHours = Math.round((targetAt.getTime() - issuedAt.getTime()) / 3600000);
      values.push("EIA", "load_forecast", "US48", issuedAt, targetAt, Number(o.value), horizonHours);
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, '{}'::jsonb)`;
    });
    const result = await client.query(
      `INSERT INTO forecasts (source, metric, region, issued_at, target_at, value, horizon_hours, metadata)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (source, metric, region, issued_at, target_at) DO NOTHING`,
      values
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

export default async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");

  const state = (await store().get("state", { type: "json" })) || {};
  const observations = Array.isArray(state.observations) ? state.observations : [];
  const issuedAt = new Date();
  const pool = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const observationCount = await syncObservations(client, observations);
      const forecastCount = await syncForecasts(client, observations, issuedAt);
      await client.query("COMMIT");

      await store().setJSON("db-sync-state", {
        syncedAt: issuedAt.toISOString(),
        observationCount,
        forecastCount,
      });

      return new Response(JSON.stringify({ ok: true, observationCount, forecastCount }), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

export const config = { schedule: "@hourly" };
