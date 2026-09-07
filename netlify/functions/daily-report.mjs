import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const MODEL = "nvidia/nemotron-3-super-120b-a12b";
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
  return `${get("year")}-${get("month")}-${get("day")}-${String(get("hour")).padStart(2, "0")}`;
}
function latest(rows, predicate) {
  return rows.filter(predicate)
    .map(r => ({ value: Number(r.value), at: String(r.period || "") }))
    .filter(x => Number.isFinite(x.value) && Number.isFinite(parseAt(x.at)))
    .sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null;
}
function nearest(rows, targetMs, predicate, tolerance = 2 * 3600000) {
  let best = null, dist = Infinity;
  for (const r of rows) {
    if (!predicate(r)) continue;
    const ms = parseAt(r.period), d = Math.abs(ms - targetMs);
    if (Number.isFinite(ms) && d <= tolerance && d < dist) { best = r; dist = d; }
  }
  return best;
}
function avgSameHour(rows, anchor, days, predicate) {
  const ms = parseAt(anchor), hour = sameHourKey(anchor)?.slice(-2);
  if (!Number.isFinite(ms) || !hour) return null;
  const vals = [];
  for (let d = 1; d <= days; d++) {
    const r = nearest(rows, ms - d * 86400000, predicate);
    if (r && sameHourKey(r.period)?.slice(-2) === hour && Number.isFinite(Number(r.value))) vals.push(Number(r.value));
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function pct(a, b) { return b != null && b !== 0 ? (a / b - 1) * 100 : null; }
function round(v) { return v == null ? null : Math.round(v); }

async function getFacts() {
  const state = (await store().get("state", { type: "json" })) || { weather: {} };
  const now = new Date();
  const start = new Date(now.getTime() - 8 * 86400000);
  const common = { frequency: "hourly", "data[]": "value", start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13), "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000 };

  const [fuelPayload, loadPayload] = await Promise.all([
    fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, state),
    fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D"] }, state)
  ]);
  const fuel = dataRows(fuelPayload), loadRows = dataRows(loadPayload);
  const load = latest(loadRows, r => String(r.type) === "D");
  const anchor = load?.at || latest(fuel, () => true)?.at;
  if (!anchor) throw new Error("No current EIA anchor data");
  const key = sameHourKey(anchor);
  const atFuel = fuel.filter(r => sameHourKey(r.period) === key);
  const byFuel = new Map(atFuel.map(r => [String(r.fueltype || "").toUpperCase(), Number(r.value)]));
  const gas = Number.isFinite(byFuel.get("NG")) ? byFuel.get("NG") : null;
  const wind = Number.isFinite(byFuel.get("WND")) ? byFuel.get("WND") : null;
  const solar = Number.isFinite(byFuel.get("SUN")) ? byFuel.get("SUN") : null;
  const total = Number.isFinite(byFuel.get("ALL")) ? byFuel.get("ALL") : null;
  const residual = load && wind != null && solar != null ? load.value - wind - solar : null;
  const gasShare = gas != null && total > 0 ? gas / total * 100 : null;
  const renewableShare = wind != null && solar != null && total > 0 ? (wind + solar) / total * 100 : null;
  const metric = (value, predicate, rows = loadRows) => ({ value: round(value), vs24h_pct: value != null ? pct(value, Number(nearest(rows, parseAt(anchor) - 86400000, predicate)?.value)) : null, vs3d_pct: value != null ? pct(value, avgSameHour(rows, anchor, 3, predicate)) : null, vs7d_pct: value != null ? pct(value, avgSameHour(rows, anchor, 7, predicate)) : null });
  const gasP = r => String(r.fueltype || "").toUpperCase() === "NG";
  const windP = r => String(r.fueltype || "").toUpperCase() === "WND";
  const solarP = r => String(r.fueltype || "").toUpperCase() === "SUN";
  const allP = r => String(r.fueltype || "").toUpperCase() === "ALL";
  const residual24 = (() => { const l = nearest(loadRows, parseAt(anchor) - 86400000, r => String(r.type) === "D"), w = nearest(fuel, parseAt(anchor) - 86400000, windP), s = nearest(fuel, parseAt(anchor) - 86400000, solarP); return l && w && s ? Number(l.value) - Number(w.value) - Number(s.value) : null; })();
  const residual3 = (() => { const l = avgSameHour(loadRows, anchor, 3, r => String(r.type) === "D"), w = avgSameHour(fuel, anchor, 3, windP), s = avgSameHour(fuel, anchor, 3, solarP); return l != null && w != null && s != null ? l - w - s : null; })();
  const residual7 = (() => { const l = avgSameHour(loadRows, anchor, 7, r => String(r.type) === "D"), w = avgSameHour(fuel, anchor, 7, windP), s = avgSameHour(fuel, anchor, 7, solarP); return l != null && w != null && s != null ? l - w - s : null; })();
  return {
    anchor_time: anchor,
    load: metric(load.value, r => String(r.type) === "D"),
    gas_generation: metric(gas, gasP, fuel),
    wind_generation: metric(wind, windP, fuel),
    solar_generation: metric(solar, solarP, fuel),
    total_generation: metric(total, allP, fuel),
    residual_load: { value: round(residual), vs24h_pct: pct(residual, residual24), vs3d_pct: pct(residual, residual3), vs7d_pct: pct(residual, residual7) },
    gas_share_pct: gasShare == null ? null : Number(gasShare.toFixed(1)),
    renewable_share_pct: renewableShare == null ? null : Number(renewableShare.toFixed(1)),
    weather_block: state.weather?.telegramBlock || "Weather data unavailable.",
    source: "EIA electricity data + NOAA/CPC weather data"
  };
}

async function callNemotron(facts, apiKey) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a U.S. power-market natural-gas demand analyst. Use ONLY the supplied facts. Do not invent numbers or causes. Interpret load, gas generation, renewables, residual load, and weather together. Write a concise Telegram-ready daily intelligence report. Structure: 1) one-line headline, 2) 4-6 short bullets, 3) one final line beginning 'Power-sector gas demand:'. Focus on whether U.S. power-sector gas demand is strengthening, weakening, or mixed and why. No natural-gas price forecast. No buy/sell advice. Do not mention being an AI or the prompt." },
      { role: "user", content: JSON.stringify(facts) }
    ],
    temperature: 1.0,
    top_p: 0.95,
    reasoning_effort: "low",
    max_tokens: 2200,
    stream: false
  };
  const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`NVIDIA ${r.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data?.choices?.[0]?.message?.content?.trim() || "No model response.";
}

async function telegram(text, token, chatId) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

export default async () => {
  const eiaKey = Netlify.env.get("EIA_API_KEY");
  const nvidiaKey = Netlify.env.get("NVIDIA_API_KEY");
  const telegramToken = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const telegramGroup = Netlify.env.get("TELEGRAM_GROUP_ID");
  if (!eiaKey || !nvidiaKey || !telegramToken || !telegramGroup) throw new Error("Missing required environment variable");
  const facts = await getFacts();
  const note = await callNemotron(facts, nvidiaKey);
  const text = `🇺🇸 U.S. POWER + GAS DEMAND — DAILY\n\n${note}\n\n🕐 Data anchor: ${facts.anchor_time}\n📡 ${facts.source}`;
  await telegram(text, telegramToken, telegramGroup);
  return new Response(JSON.stringify({ ok: true, model: MODEL, anchor_time: facts.anchor_time, sent: true }, null, 2), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 11 * * *" };
