import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const store = () => getStore("natgas-power-demand");
const ET = "America/New_York";

function parseAt(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}
function etParts(iso) {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return null;
  const p = new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = t => p.find(x => x.type === t)?.value;
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}
function fmtTime(iso, tz = ET) {
  const ms = parseAt(iso);
  return Number.isFinite(ms) ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(ms)) : "N/A";
}
function sameHourKey(iso) {
  const p = etParts(iso);
  return p ? `${p.year}-${p.month}-${p.day}-${p.hour}` : null;
}
function latest(rows, predicate) {
  return rows.filter(predicate)
    .map(r => ({ ...r, value: Number(r.value), at: String(r.period || "") }))
    .filter(r => Number.isFinite(r.value) && Number.isFinite(parseAt(r.at)))
    .sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null;
}
function nearest(rows, targetMs, predicate, tolerance = 90 * 60 * 1000) {
  let best = null, dist = Infinity;
  for (const r of rows) {
    if (!predicate(r)) continue;
    const ms = parseAt(r.period), d = Math.abs(ms - targetMs);
    if (Number.isFinite(ms) && d <= tolerance && d < dist) { best = r; dist = d; }
  }
  return best;
}
function pct(a, b) { return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? (a / b - 1) * 100 : null; }
function pp(a, b) { return Number.isFinite(a) && Number.isFinite(b) ? a - b : null; }
function avg(values) { const v = values.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function sum(values) { const v = values.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) : null; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function signed(v, digits = 1) { return v == null ? "N/A" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`; }
function signedPp(v) { return v == null ? "N/A" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} pp`; }
function mwh(v) { return v == null ? "N/A" : `${Math.round(v).toLocaleString("en-US")} MWh`; }
function num(v, d = 1) { return v == null ? "N/A" : Number(v).toFixed(d); }
function arrow(v) { return v == null ? "•" : v > 1 ? "↑" : v < -1 ? "↓" : "→"; }
function icon(v, positiveSupport = true) { if (v == null) return "⚪"; const x = positiveSupport ? v : -v; return x > 1 ? "🟢" : x < -1 ? "🔴" : "🟡"; }
function stats(value, prior24, avg3, avg7, priorYear) {
  return { value, p24: pct(value, prior24), p3: pct(value, avg3), p7: pct(value, avg7), yoy: pct(value, priorYear) };
}
function historicalSameHour(rows, anchorMs, predicate, days) {
  const anchorKey = sameHourKey(new Date(anchorMs).toISOString());
  const values = [];
  for (let d = 1; d <= days; d++) {
    const r = nearest(rows, anchorMs - d * 86400000, predicate, 2 * 3600000);
    if (r && sameHourKey(r.period) === anchorKey) values.push(Number(r.value));
  }
  return avg(values);
}
function priorYearDate(anchorAt) {
  const p = etParts(anchorAt);
  if (!p) return null;
  return `${Number(p.year) - 1}-${p.month}-${p.day}`;
}

function fuelAt(fuelRows, targetMs) {
  const get = code => nearest(fuelRows, targetMs, r => String(r.fueltype || "").toUpperCase() === code, 90 * 60 * 1000);
  const ng = get("NG"), wnd = get("WND"), sun = get("SUN"), all = get("ALL");
  return {
    gas: ng ? Number(ng.value) : null,
    wind: wnd ? Number(wnd.value) : null,
    solar: sun ? Number(sun.value) : null,
    total: all ? Number(all.value) : null
  };
}

async function getPriorYear(eiaState, anchorAt, signals) {
  const date = priorYearDate(anchorAt);
  if (!date) return {};
  const p = etParts(anchorAt);
  const common = { frequency: "hourly", "data[]": "value", start: `${date}T00`, end: `${date}T23`, "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000 };
  const out = {};
  const loadPayload = await fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D"] }, eiaState);
  const loadRows = dataRows(loadPayload);
  const targetKey = `${date}-${p.hour}`;
  const load = loadRows.find(r => String(r.type) === "D" && sameHourKey(r.period) === targetKey);
  if (load && signals.includes("total_load")) out.total_load = Number(load.value);
  const fuelPayload = await fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, eiaState);
  const f = dataRows(fuelPayload).filter(r => sameHourKey(r.period) === targetKey);
  const mix = fuelAt(f, parseAt(`${date}T${p.hour}:00:00Z`));
  if (signals.includes("gas_generation")) out.gas_generation = mix.gas;
  if (signals.includes("wind_generation")) out.wind_generation = mix.wind;
  if (signals.includes("solar_generation")) out.solar_generation = mix.solar;
  if (signals.includes("total_generation")) out.total_generation = mix.total;
  return out;
}

function weatherFacts(state) {
  const w = state.weather || {};
  const actual = Array.isArray(w.actual) ? w.actual.filter(x => Number.isFinite(Number(x.hdd)) && Number.isFinite(Number(x.cdd))) : [];
  const forecast = Array.isArray(w.forecast) ? w.forecast.filter(x => Number.isFinite(Number(x.hdd)) && Number.isFinite(Number(x.cdd))) : [];
  const a = actual.at(-1), prior = actual.at(-2);
  const a3 = actual.slice(-3), a7 = actual.slice(-7);
  const dd = x => x ? Number(x.hdd || 0) + Number(x.cdd || 0) : null;
  const f = n => ({ hdd: sum(forecast.slice(0, n).map(x => Number(x.hdd))), cdd: sum(forecast.slice(0, n).map(x => Number(x.cdd))), tdd: sum(forecast.slice(0, n).map(dd)) });
  const recent = {
    hdd: a ? Number(a.hdd) : null, cdd: a ? Number(a.cdd) : null, tdd: dd(a),
    priorHdd: prior ? Number(prior.hdd) : null, priorCdd: prior ? Number(prior.cdd) : null, priorTdd: dd(prior),
    hdd3: avg(a3.map(x => Number(x.hdd))), cdd3: avg(a3.map(x => Number(x.cdd))), tdd3: avg(a3.map(dd)),
    hdd7: avg(a7.map(x => Number(x.hdd))), cdd7: avg(a7.map(x => Number(x.cdd))), tdd7: avg(a7.map(dd))
  };
  return { actualDate: a?.date || null, recent, forecast: { d1: f(1), d3: f(3), d7: f(7), through: forecast.at(-1)?.date || null, source: forecast.length ? "NOAA/CPC NDFD 7-day" : null } };
}

function classify(load, gas, residual, renewableDelta, forecastSurprise, completeness) {
  const drivers = [gas, residual, load, renewableDelta == null ? null : -renewableDelta].filter(Number.isFinite);
  if (completeness < 0.75 || drivers.length < 2) return { state: "INSUFFICIENT DATA", confidence: "LOW", score: null };
  const score = drivers.reduce((a, b) => a + clamp(b, -20, 20), 0) / drivers.length;
  const agreement = [gas, residual, load].filter(Number.isFinite);
  const pos = agreement.filter(x => x > 1).length, neg = agreement.filter(x => x < -1).length;
  let state = score >= 2 ? "STRONGER" : score <= -2 ? "WEAKER" : "MIXED";
  if (gas != null && residual != null && gas > 1 && residual < -1) state = "MIXED";
  if (gas != null && residual != null && gas < -1 && residual > 1) state = "MIXED";
  const confidence = completeness >= 0.95 && (pos === 0 || neg === 0 || Math.max(pos, neg) >= 2) ? "HIGH" : completeness >= 0.9 ? "MEDIUM" : "LOW";
  return { state, confidence, score, forecastSurprise };
}

async function buildFacts() {
  const state = (await store().get("state", { type: "json" })) || { weather: {}, usage: {} };
  const now = new Date();
  const start = new Date(now.getTime() - 8 * 86400000);
  const common = { frequency: "hourly", "data[]": "value", start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13), "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000 };
  const [fuelPayload, loadPayload] = await Promise.all([
    fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, state),
    fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D", "DF"] }, state)
  ]);
  const fuelRows = dataRows(fuelPayload), loadRows = dataRows(loadPayload);
  const loadRow = latest(loadRows, r => String(r.type) === "D");
  if (!loadRow) throw new Error("No current EIA load observation");
  const anchorAt = loadRow.at, anchorMs = parseAt(anchorAt), mix = fuelAt(fuelRows, anchorMs);
  const residual = loadRow.value != null && mix.wind != null && mix.solar != null ? loadRow.value - mix.wind - mix.solar : null;
  const priorLoad = nearest(loadRows, anchorMs - 86400000, r => String(r.type) === "D");
  const load3 = historicalSameHour(loadRows, anchorMs, r => String(r.type) === "D", 3);
  const load7 = historicalSameHour(loadRows, anchorMs, r => String(r.type) === "D", 7);
  const gas24 = nearest(fuelRows, anchorMs - 86400000, r => String(r.fueltype || "").toUpperCase() === "NG");
  const wind24 = nearest(fuelRows, anchorMs - 86400000, r => String(r.fueltype || "").toUpperCase() === "WND");
  const solar24 = nearest(fuelRows, anchorMs - 86400000, r => String(r.fueltype || "").toUpperCase() === "SUN");
  const residual24 = priorLoad && wind24 && solar24 ? Number(priorLoad.value) - Number(wind24.value) - Number(solar24.value) : null;
  const wind3 = historicalSameHour(fuelRows, anchorMs, r => String(r.fueltype || "").toUpperCase() === "WND", 3);
  const wind7 = historicalSameHour(fuelRows, anchorMs, r => String(r.fueltype || "").toUpperCase() === "WND", 7);
  const solar3 = historicalSameHour(fuelRows, anchorMs, r => String(r.fueltype || "").toUpperCase() === "SUN", 3);
  const solar7 = historicalSameHour(fuelRows, anchorMs, r => String(r.fueltype || "").toUpperCase() === "SUN", 7);
  const gas3 = historicalSameHour(fuelRows, anchorMs, r => String(r.fueltype || "").toUpperCase() === "NG", 3);
  const gas7 = historicalSameHour(fuelRows, anchorMs, r => String(r.fueltype || "").toUpperCase() === "NG", 7);
  const residual3 = load3 != null && wind3 != null && solar3 != null ? load3 - wind3 - solar3 : null;
  const residual7 = load7 != null && wind7 != null && solar7 != null ? load7 - wind7 - solar7 : null;
  const total = mix.total;
  const gasShare = gas => gas != null && total > 0 ? gas / total * 100 : null;
  const renewableShare = (w, s, t) => w != null && s != null && t > 0 ? (w + s) / t * 100 : null;
  const currentGasShare = gasShare(mix.gas);
  const currentRenewShare = renewableShare(mix.wind, mix.solar, total);
  const priorRenewShare = wind24 && solar24 && total > 0 ? (Number(wind24.value) + Number(solar24.value)) / total * 100 : null;
  const renewableDelta = pp(currentRenewShare, priorRenewShare);

  const forecastRows = loadRows.filter(r => String(r.type) === "DF" && Number.isFinite(Number(r.value)) && parseAt(r.period) > anchorMs).sort((a, b) => parseAt(a.period) - parseAt(b.period));
  const f1 = avg(forecastRows.slice(0, 1).map(r => Number(r.value))), f3 = avg(forecastRows.slice(0, 3).map(r => Number(r.value))), f7 = avg(forecastRows.slice(0, 7).map(r => Number(r.value)));
  const sameHourForecast = nearest(forecastRows, anchorMs, r => true, 90 * 60 * 1000);
  const forecastSurprise = sameHourForecast ? pct(loadRow.value, Number(sameHourForecast.value)) : null;

  const priorYear = await getPriorYear(state, anchorAt, ["total_load", "gas_generation", "wind_generation", "solar_generation", "total_generation"]);
  const weather = weatherFacts(state);
  const completenessValues = [loadRow.value, mix.gas, mix.wind, mix.solar, mix.total, residual, forecastRows.length ? f3 : null, weather.actualDate ? 1 : null];
  const completeness = completenessValues.filter(Number.isFinite).length / completenessValues.length;
  const signal = classify(pct(mix.gas, gas24?.value), pct(residual, residual24), pct(loadRow.value, priorLoad?.value), renewableDelta, forecastSurprise, completeness);

  const gasStats = stats(mix.gas, gas24?.value, gas3, gas7, priorYear.gas_generation);
  const loadStats = stats(loadRow.value, priorLoad?.value, load3, load7, priorYear.total_load);
  const windStats = stats(mix.wind, wind24?.value, wind3, wind7, priorYear.wind_generation);
  const solarStats = stats(mix.solar, solar24?.value, solar3, solar7, priorYear.solar_generation);
  const residualStats = { value: residual, p24: pct(residual, residual24), p3: pct(residual, residual3), p7: pct(residual, residual7), yoy: priorYear.total_load != null && priorYear.wind_generation != null && priorYear.solar_generation != null ? pct(residual, priorYear.total_load - priorYear.wind_generation - priorYear.solar_generation) : null };

  return {
    anchorAt,
    anchorDisplay: fmtTime(anchorAt),
    load: loadStats,
    gas: gasStats,
    wind: windStats,
    solar: solarStats,
    totalGeneration: { value: total, yoy: pct(total, priorYear.total_generation) },
    residual: residualStats,
    gasShare: currentGasShare,
    renewableShare: currentRenewShare,
    renewableDeltaPp: renewableDelta,
    forecast: { currentActual: loadRow.value, next1h: sameHourForecast ? Number(sameHourForecast.value) : null, next1d: f1, next3d: f3, next7d: f7, surprise: forecastSurprise, through: forecastRows.at(-1)?.period || null },
    weather,
    signal,
    dataQuality: { completeness, fuelAlignment: mix.gas != null && mix.wind != null && mix.solar != null && Math.abs(parseAt(nearest(fuelRows, anchorMs, r => ["NG", "WND", "SUN", "ALL"].includes(String(r.fueltype || "").toUpperCase()))?.period) - anchorMs) < 3600000, priorYearAvailable: Object.keys(priorYear).length >= 3, forecastHours: forecastRows.length, weatherActual: Boolean(weather.actualDate), weatherForecastDays: weather.forecast.d7?.tdd != null ? 7 : 0 },
    source: "EIA electricity data; NOAA/CPC weather"
  };
}

function deterministicSection(f) {
  const s = f.signal;
  return [
    `🎯 POWER-SECTOR GAS DEMAND: ${s.state} [${s.confidence} CONFIDENCE]`,
    `Composite direction score: ${s.score == null ? "N/A" : `${s.score >= 0 ? "+" : ""}${s.score.toFixed(1)}`} (directional, not a price signal)`,
    `Gas burn          ${mwh(f.gas.value)}   ${arrow(f.gas.p24)} ${signed(f.gas.p24)} vs 24h`,
    `Residual load     ${mwh(f.residual.value)}   ${arrow(f.residual.p24)} ${signed(f.residual.p24)} vs 24h`,
    `Power load        ${mwh(f.load.value)}   ${arrow(f.load.p24)} ${signed(f.load.p24)} vs 24h`,
    `Renewables share  ${num(f.renewableShare)}%   ${f.renewableDeltaPp == null ? "N/A" : `${f.renewableDeltaPp >= 0 ? "+" : ""}${f.renewableDeltaPp.toFixed(1)} pp`} vs 24h`,
    `Gas share         ${num(f.gasShare)}% of generation`
  ].join("\n");
}

function dataTable(f) {
  const row = (name, x) => `${name.padEnd(10)} ${mwh(x?.value).padStart(16)} ${signed(x?.p24).padStart(8)} ${signed(x?.p3).padStart(8)} ${signed(x?.p7).padStart(8)} ${signed(x?.yoy).padStart(8)}`;
  return [
    "📊 CORE POWER FUNDAMENTALS",
    "Metric          Current      vs24h    vs3D     vs7D     vsLY",
    row("Load", f.load), row("Gas", f.gas), row("Wind", f.wind), row("Solar", f.solar), row("Residual", f.residual),
    `Total gen   ${mwh(f.totalGeneration.value).padStart(16)}                       ${signed(f.totalGeneration.yoy).padStart(8)}`
  ].join("\n");
}

function forecastSection(f) {
  const x = f.forecast;
  return [
    "🔮 LOAD EXPECTATION",
    `Actual at anchor       ${mwh(x.currentActual)}`,
    `Forecast same hour     ${mwh(x.next1h)}`,
    `Actual vs forecast     ${arrow(x.surprise)} ${signed(x.surprise)}`,
    `Next 1D avg forecast   ${mwh(x.next1d)}`,
    `Next 3D avg forecast   ${mwh(x.next3d)}`,
    `Next 7D avg forecast   ${mwh(x.next7d)}`,
    `Forecast through       ${x.through ? fmtTime(x.through) : "N/A"}`
  ].join("\n");
}

function weatherSection(f) {
  const w = f.weather;
  const a = w.recent;
  const z = w.forecast;
  return [
    "🌡️ WEATHER → POWER",
    `Actual date            ${w.actualDate || "N/A"}`,
    `HDD / CDD / TDD        ${num(a.hdd)} / ${num(a.cdd)} / ${num(a.tdd)} °F-days`,
    `Prior day              ${num(a.priorHdd)} / ${num(a.priorCdd)} / ${num(a.priorTdd)} °F-days`,
    `7D actual avg         ${num(a.hdd7)} / ${num(a.cdd7)} / ${num(a.tdd7)} °F-days`,
    `Forecast next 1D       ${num(z.d1?.hdd)} / ${num(z.d1?.cdd)} / ${num(z.d1?.tdd)} °F-days`,
    `Forecast next 3D       ${num(z.d3?.hdd)} / ${num(z.d3?.cdd)} / ${num(z.d3?.tdd)} °F-days`,
    `Forecast next 7D       ${num(z.d7?.hdd)} / ${num(z.d7?.cdd)} / ${num(z.d7?.tdd)} °F-days`,
    `Through                ${z.through || "N/A"}`,
    `Source                 ${z.source || "N/A"}`
  ].join("\n");
}

function qualitySection(f) {
  const q = f.dataQuality;
  return [
    "🧪 DATA QUALITY / CONTROL",
    `Completeness          ${(q.completeness * 100).toFixed(0)}%`,
    `Fuel timestamp align   ${q.fuelAlignment ? "PASS" : "CHECK"}`,
    `YoY same-hour data     ${q.priorYearAvailable ? "AVAILABLE" : "PARTIAL"}`,
    `Load forecast rows     ${q.forecastHours}`,
    `Weather actual         ${q.weatherActual ? "AVAILABLE" : "MISSING"}`,
    `Weather forecast       ${q.weatherForecastDays ? `${q.weatherForecastDays}D` : "MISSING"}`,
    "Method                 Directional composite + deterministic facts; AI narrative cannot override source facts"
  ].join("\n");
}

async function callNemotron(facts, apiKey) {
  const system = `You are the senior power-market analyst for an institutional natural-gas trading and risk team. Produce a concise, evidence-first U.S. power-sector gas-demand intelligence note from the supplied JSON only.

Rules:
- Never invent, estimate, round differently, or fill missing data.
- Treat the deterministic POWER-SECTOR GAS DEMAND state and confidence as authoritative. Do not change it.
- Distinguish observed data from forecasts.
- Explain the causal chain: load -> renewables -> residual load -> gas generation.
- Use YoY, 3D and 7D comparisons when materially informative.
- Use weather only as context for power demand; do not claim weather caused a move unless the supplied data supports that inference.
- Explicitly flag divergence when gas burn and residual load disagree.
- Mention forecast surprise when material.
- Mention data-quality limitations when confidence is LOW/MEDIUM or fields are missing.
- No natural-gas price target, price forecast, trade recommendation, or buy/sell language.
- No generic market filler.
- Maximum 5 bullets. Each bullet should contain a concrete number or a clearly stated data relationship.
- Finish with exactly one line: `Desk takeaway: ...` summarizing the power-sector gas-demand implication only.`;
  const payload = JSON.stringify(facts);
  const body = { model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: payload }], temperature: 0.2, top_p: 0.9, reasoning_effort: "low", max_tokens: 1600, stream: false };
  const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`NVIDIA ${r.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data?.choices?.[0]?.message?.content?.trim() || "Narrative unavailable.";
}

async function telegram(text, token, chatId) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

export default async () => {
  const nvidiaKey = Netlify.env.get("NVIDIA_API_KEY");
  const telegramToken = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const telegramGroup = Netlify.env.get("TELEGRAM_GROUP_ID");
  if (!nvidiaKey || !telegramToken || !telegramGroup) throw new Error("Missing required environment variable");

  const facts = await buildFacts();
  let narrative;
  try { narrative = await callNemotron(facts, nvidiaKey); }
  catch (e) { console.error(e); narrative = "⚠️ AI narrative unavailable; deterministic sections below remain valid."; }

  const text = [
    "🇺🇸 U.S. POWER + GAS DEMAND — INSTITUTIONAL DAILY",
    `🕐 Anchor: ${facts.anchorDisplay}`,
    "",
    deterministicSection(facts),
    "",
    dataTable(facts),
    "",
    forecastSection(facts),
    "",
    weatherSection(facts),
    "",
    "🧠 ANALYST SYNTHESIS",
    narrative,
    "",
    qualitySection(facts),
    "",
    `📡 Sources: ${facts.source}`
  ].join("\n");

  await telegram(text, telegramToken, telegramGroup);
  return new Response(JSON.stringify({ ok: true, model: MODEL, anchor_time: facts.anchorAt, state: facts.signal.state, confidence: facts.signal.confidence, completeness: facts.dataQuality.completeness, sent: true }, null, 2), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 11 * * *" };
