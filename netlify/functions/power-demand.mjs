import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows, latest } from "./eia.mjs";

const SIGNALS = ["gas_generation", "total_load", "wind_generation", "solar_generation", "generation_outages", "load_forecast"];
const store = () => getStore("natgas-power-demand");

async function state() {
  const s = (await store().get("state", { type: "json" })) || { observations: [], usage: {}, lastRun: null, source: "EIA" };
  if (s.source !== "EIA") return { observations: [], usage: {}, lastRun: null, source: "EIA" };
  return s;
}
async function save(s) { await store().setJSON("state", s); }
function hourET(now = new Date()) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(now)); }
function due(now = new Date()) {
  const h = hourET(now), d = new Set();
  if ((h >= 6 && h < 18) || h % 3 === 0) { d.add("gas_generation"); d.add("total_load"); }
  if ([8, 12, 16].includes(h)) d.add("solar_generation");
  if (now.getUTCHours() % 6 === 0) { d.add("wind_generation"); d.add("generation_outages"); d.add("load_forecast"); }
  return d;
}
function add(s, signal, x) {
  if (!x) return;
  if (!s.observations.some(o => o.signal === signal && o.at === x.at)) s.observations.push({ signal, value: x.value, at: x.at, unit: "MWh" });
}
function parseAt(x) {
  const s = String(x);
  if (s.endsWith("Z")) return Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}
function history(s, signal, at) {
  const target = parseAt(at) - 24 * 3600000;
  const c = s.observations.filter(o => o.signal === signal && Number.isFinite(parseAt(o.at)) && parseAt(o.at) <= target);
  return c.length ? c.reduce((a, b) => Math.abs(parseAt(a.at) - target) <= Math.abs(parseAt(b.at) - target) ? a : b) : null;
}
function report(s) {
  const names = { gas_generation: "🔥 Gas Generation", total_load: "⚡ Total Load", wind_generation: "🌬️ Wind", solar_generation: "☀️ Solar", generation_outages: "🚨 Generation Outage", load_forecast: "🔮 Load Forecast" };
  const m = {};
  for (const signal of SIGNALS) {
    const a = s.observations.filter(o => o.signal === signal).at(-1);
    const b = a ? history(s, signal, a.at) : null;
    m[signal] = a ? { ...a, pct: b && b.value ? (a.value / b.value - 1) * 100 : null, delta: b ? a.value - b.value : null } : null;
  }
  const p = [];
  if (m.gas_generation?.pct != null) p.push(m.gas_generation.pct);
  if (m.total_load?.pct != null) p.push(m.total_load.pct * 0.7);
  if (m.wind_generation?.pct != null) p.push(-m.wind_generation.pct * 0.35);
  if (m.solar_generation?.pct != null) p.push(-m.solar_generation.pct * 0.35);
  const score = p.length ? p.reduce((a, b) => a + b, 0) / p.length : null;
  const v = score == null ? ["⚪ UNKNOWN", "→ INSUFFICIENT DATA", "Not enough validated observations yet."] : score >= 2 ? ["🟢 HIGH", "↑ MORE GAS BURN", "Higher load and/or weaker renewable supply is increasing gas-burn pressure."] : score <= -2 ? ["🔴 LOW", "↓ LESS GAS BURN", "Lower load and/or stronger renewable supply is reducing gas-burn pressure."] : ["🟡 MODERATE", "→ MIXED", "Power-sector inputs are mixed; gas-demand pressure is not decisive."];
  const lines = ["🔥 U.S. POWER → NATGAS", ""];
  for (const x of SIGNALS) {
    const z = m[x];
    const val = z ? (x === "generation_outages" && z.delta != null ? `${z.delta >= 0 ? "+" : ""}${z.delta.toFixed(0)} MWh vs 24h` : z.pct != null ? `${z.pct >= 0 ? "+" : ""}${z.pct.toFixed(1)}% vs 24h` : `${z.value.toFixed(0)} MWh`) : "N/A";
    lines.push(`${names[x].padEnd(22)} ${val}`);
  }
  lines.push("", `Demand Pressure: ${v[0]}`, `Direction:        ${v[1]}`, "", "Reason:", v[2], "", "🚨 Outages: N/A — EIA-930 does not provide a validated all-generator U.S. outage series.", "Source: U.S. Energy Information Administration (EIA)");
  return lines.join("\n");
}
async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_ID, text }) });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

export default async () => {
  if (!process.env.EIA_API_KEY || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_ID) throw new Error("Missing EIA_API_KEY, TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID");
  const s = await state(), now = new Date(), d = due(now), start = new Date(now.getTime() - 3 * 3600000);
  const common = { frequency: "hourly", "data[]": "value", start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13), "sort[0][column]": "period", "sort[0][direction]": "desc", length: 5000 };
  if (d.has("total_load") || d.has("load_forecast")) {
    const p = await fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D", "DF"] }, s), r = dataRows(p);
    add(s, "total_load", latest(r, x => x.type === "D"));
    add(s, "load_forecast", latest(r, x => x.type === "DF"));
  }
  if (d.has("gas_generation") || d.has("wind_generation") || d.has("solar_generation")) {
    // EIA generation is published with a lag, unlike demand. Pull a 72-hour window.
    // One call still covers NG/WND/SUN and stays well within the monthly budget.
    const fuelStart = new Date(now.getTime() - 72 * 3600000);
    const fuelCommon = { ...common, start: fuelStart.toISOString().slice(0, 13) };
    const p = await fetchEIA("/electricity/rto/fuel-type-data/data/", { ...fuelCommon, "facets[respondent][]": "US48" }, s), r = dataRows(p);
    add(s, "gas_generation", latest(r, x => x.fueltype === "NG"));
    add(s, "wind_generation", latest(r, x => x.fueltype === "WND"));
    add(s, "solar_generation", latest(r, x => x.fueltype === "SUN"));
  }
  s.observations = s.observations.slice(-10000);
  s.lastRun = now.toISOString();
  await save(s);
  if (d.size) await telegram(report(s));
  return new Response(JSON.stringify({ ok: true, source: "EIA", due: [...d], unavailable: ["generation_outages"], usage: s.usage }), { headers: { "content-type": "application/json" } });
};
export const config = { schedule: "@hourly" };
