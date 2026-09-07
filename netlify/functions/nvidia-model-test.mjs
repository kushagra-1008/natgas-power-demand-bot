import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const MODELS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", reasoning: "high" },
  { id: "deepseek-ai/deepseek-v4-pro-0813", reasoning: "high" },
  { id: "moonshotai/kimi-k3", reasoning: "high" },
  { id: "deepseek-ai/deepseek-v4-flash-0731", reasoning: "high" }
];

const store = () => getStore("natgas-power-demand");

function parseAt(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}
function sameHourKey(iso) {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return null;
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = t => p.find(x => x.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}`;
}
function pct(a, b) { return b != null && b !== 0 ? (a / b - 1) * 100 : null; }
function latest(rows, predicate) {
  return rows.filter(predicate).map(r => ({ value: Number(r.value), at: String(r.period || "") }))
    .filter(x => Number.isFinite(x.value) && Number.isFinite(parseAt(x.at)))
    .sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null;
}
function averageSameHour(rows, targetAt, days, predicate) {
  const target = parseAt(targetAt), hour = sameHourKey(targetAt)?.slice(-2), values = [];
  if (!Number.isFinite(target) || !hour) return null;
  for (let d = 1; d <= days; d++) {
    const targetMs = target - d * 24 * 3600000;
    const row = latest(rows, r => predicate(r) && Math.abs(parseAt(r.period) - targetMs) <= 2 * 3600000 && sameHourKey(r.period)?.slice(-2) === hour);
    if (row) values.push(row.value);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

async function liveFacts() {
  const state = (await store().get("state", { type: "json" })) || { observations: [], weather: {} };
  const now = new Date();
  const start = new Date(now.getTime() - 8 * 24 * 3600000);
  const common = { frequency: "hourly", "data[]": "value", start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13), "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000 };

  const [fuelPayload, loadPayload] = await Promise.all([
    fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, state),
    fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": "D" }, state)
  ]);
  const fuel = dataRows(fuelPayload), loadRows = dataRows(loadPayload);
  const load = latest(loadRows, r => String(r.type) === "D");
  const anchor = load?.at || latest(fuel, () => true)?.at || null;
  const anchorMs = parseAt(anchor);

  // Fuel rows use the same EIA period timestamp as load. Match the exact
  // normalized timestamp first; fall back to the nearest row within one hour.
  const atFuel = fuel.filter(r => {
    const ms = parseAt(r.period);
    return Number.isFinite(anchorMs) && Number.isFinite(ms) && Math.abs(ms - anchorMs) < 3600000;
  });
  const byFuel = new Map();
  for (const r of atFuel) {
    const key = String(r.fueltype || "").trim().toUpperCase();
    const value = Number(r.value);
    if (key && Number.isFinite(value)) byFuel.set(key, value);
  }

  const gas = Number.isFinite(byFuel.get("NG")) ? byFuel.get("NG") : null;
  const wind = Number.isFinite(byFuel.get("WND")) ? byFuel.get("WND") : null;
  const solar = Number.isFinite(byFuel.get("SUN")) ? byFuel.get("SUN") : null;
  const all = Number.isFinite(byFuel.get("ALL")) ? byFuel.get("ALL") : null;
  const residual = load && wind != null && solar != null ? load.value - wind - solar : null;
  const gasShare = gas != null && all > 0 ? gas / all * 100 : null;
  const renewableShare = wind != null && solar != null && all > 0 ? (wind + solar) / all * 100 : null;
  const metric = (value, rows, predicate) => ({ value, vs24h_pct: value != null ? pct(value, averageSameHour(rows, anchor, 1, predicate)) : null, vs3d_pct: value != null ? pct(value, averageSameHour(rows, anchor, 3, predicate)) : null, vs7d_pct: value != null ? pct(value, averageSameHour(rows, anchor, 7, predicate)) : null });

  const weather = state.weather?.telegramBlock || "No weather block available.";
  return {
    anchor_time: anchor,
    latest: {
      total_load: metric(load?.value ?? null, loadRows, r => String(r.type) === "D"),
      gas_generation_mwh: gas,
      wind_generation_mwh: wind,
      solar_generation_mwh: solar,
      total_generation_mwh: all,
      residual_load_mwh: residual,
      gas_share_pct: gasShare,
      renewable_share_pct: renewableShare
    },
    weather_block: weather,
    note: "These are live EIA/NOAA-derived facts. Do not invent missing values. Analyze U.S. power-sector natural-gas demand only. Do not give buy/sell recommendations."
  };
}

async function callModel(model, facts, apiKey) {
  const started = Date.now();
  const body = {
    model: model.id,
    messages: [
      {
        role: "system",
        content: "You are a U.S. power-market and natural-gas demand analyst. Analyze only the supplied facts. Do not invent data, causes, prices, or missing values. Distinguish electricity load from actual gas generation and account for renewable generation. Return a concise Telegram-ready intelligence note with: headline, 3-5 key observations, and a final assessment of U.S. power-sector natural-gas demand. No buy/sell advice."
      },
      { role: "user", content: JSON.stringify(facts) }
    ],
    temperature: 1.0,
    top_p: 0.95,
    reasoning_effort: model.reasoning,
    max_tokens: 2500,
    stream: false
  };

  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result).slice(0, 800)}`);
  return { model: model.id, ms: Date.now() - started, text: result?.choices?.[0]?.message?.content || "" };
}

export default async () => {
  const apiKey = Netlify.env.get("NVIDIA_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ ok: false, error: "Missing NVIDIA_API_KEY" }), { status: 500, headers: { "content-type": "application/json" } });
  try {
    const facts = await liveFacts();
    const results = await Promise.all(MODELS.map(async model => {
      try { return await callModel(model, facts, apiKey); }
      catch (error) { return { model: model.id, error: String(error.message || error) }; }
    }));
    return new Response(JSON.stringify({ ok: true, facts, results }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error.message || error) }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
  }
};
