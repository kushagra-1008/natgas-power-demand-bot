import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const CORE_SIGNALS = ["gas_generation", "total_load", "wind_generation", "solar_generation"];
const ALL_SIGNALS = [...CORE_SIGNALS, "total_generation", "load_forecast"];
const store = () => getStore("natgas-power-demand");

async function state() {
  const s = (await store().get("state", { type: "json" })) || { observations: [], usage: {}, lastRun: null, source: "EIA" };
  if (s.source !== "EIA") return { observations: [], usage: {}, lastRun: null, source: "EIA" };
  return s;
}
async function save(s) { await store().setJSON("state", s); }

function parseAt(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}
function etParts(iso) {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = type => parts.find(p => p.type === type)?.value;
  const year = get("year"), month = get("month"), day = get("day"), hour = get("hour");
  return year && month && day && hour ? { year, month, day, hour } : null;
}
function sameHourKey(iso) {
  const p = etParts(iso);
  return p ? `${p.year}-${p.month}-${p.day}-${String(p.hour).padStart(2, "0")}` : null;
}
function hourET(now = new Date()) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(now)); }
function formatTime(iso, timeZone, locale = "en-US") {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return "N/A";
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(ms));
}
function formatET(iso) { return formatTime(iso, "America/New_York", "en-US"); }
function formatIndia(iso) { return formatTime(iso, "Asia/Kolkata", "en-IN"); }

function due(now = new Date()) {
  const h = hourET(now), d = new Set();
  if ((h >= 6 && h < 18) || h % 3 === 0) { d.add("gas_generation"); d.add("total_load"); }
  if ([8, 12, 16].includes(h)) d.add("solar_generation");
  if (now.getUTCHours() % 6 === 0) { d.add("wind_generation"); d.add("load_forecast"); }
  return d;
}

function addObservation(s, signal, row) {
  const value = Number(row?.value), at = String(row?.period || "");
  if (!Number.isFinite(value) || !at || !Number.isFinite(parseAt(at))) return;
  if (!s.observations.some(o => o.signal === signal && o.at === at)) s.observations.push({ signal, value, at, unit: "MWh" });
}
function addSeries(s, signal, rows, predicate) { for (const row of rows) if (predicate(row)) addObservation(s, signal, row); }
function addFuelMix(s, rows) {
  const byPeriod = new Map();
  for (const row of rows) {
    const at = String(row?.period || ""), value = Number(row?.value);
    if (!at || !Number.isFinite(value) || !Number.isFinite(parseAt(at))) continue;
    const fuel = String(row?.fueltype || "").toUpperCase();
    if (!byPeriod.has(at)) byPeriod.set(at, { sum: 0, all: null, count: 0 });
    const g = byPeriod.get(at);
    if (fuel === "ALL") g.all = value; else { g.sum += value; g.count++; }
  }
  for (const [at, g] of byPeriod) {
    const total = g.all != null ? g.all : (g.count ? g.sum : null);
    if (total != null && total > 0) addObservation(s, "total_generation", { period: at, value: total });
  }
}
function rowsFor(s, signal) { return s.observations.filter(o => o.signal === signal && Number.isFinite(parseAt(o.at))); }
function latest(s, signal) { return rowsFor(s, signal).sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null; }
function exactAt(s, signal, at) { return rowsFor(s, signal).find(r => r.at === at) || null; }
function nearestAt(s, signal, targetMs, toleranceMs = 90 * 60 * 1000) {
  if (!Number.isFinite(targetMs)) return null;
  let best = null, bestDist = Infinity;
  for (const row of rowsFor(s, signal)) {
    const dist = Math.abs(parseAt(row.at) - targetMs);
    if (dist <= toleranceMs && dist < bestDist) { best = row; bestDist = dist; }
  }
  return best;
}
function sameHourAverage(s, signal, anchorAt, days) {
  const anchorMs = parseAt(anchorAt), key = sameHourKey(anchorAt);
  if (!Number.isFinite(anchorMs) || !key) return null;
  const hour = key.slice(-2), values = [];
  for (let d = 1; d <= days; d++) {
    const row = nearestAt(s, signal, anchorMs - d * 24 * 3600000, 2 * 3600000);
    if (row && sameHourKey(row.at)?.slice(-2) === hour) values.push(row.value);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function pct(a, b) { return b != null && b !== 0 ? (a / b - 1) * 100 : null; }
function comparison(s, signal, anchorAt, value) {
  const ms = parseAt(anchorAt);
  if (!Number.isFinite(ms)) return { value, p24: null, p3: null, p7: null };
  const one = nearestAt(s, signal, ms - 24 * 3600000), avg3 = sameHourAverage(s, signal, anchorAt, 3), avg7 = sameHourAverage(s, signal, anchorAt, 7);
  return { value, p24: one ? pct(value, one.value) : null, p3: avg3 != null ? pct(value, avg3) : null, p7: avg7 != null ? pct(value, avg7) : null };
}
function latestCommon(s, signals) {
  for (const candidate of rowsFor(s, signals[0]).sort((a, b) => parseAt(b.at) - parseAt(a.at))) {
    if (signals.every(signal => exactAt(s, signal, candidate.at))) return candidate.at;
  }
  return null;
}
function valueAt(s, signal, at) { return exactAt(s, signal, at)?.value ?? null; }
function arrow(p) { return p == null ? "•" : p > 1 ? "↑" : p < -1 ? "↓" : "→"; }
function signedPct(p) { return p == null ? "N/A" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`; }
function fmtMWh(v) { return v == null ? "N/A" : `${Math.round(v).toLocaleString("en-US")} MWh`; }
function directionIcon(p, positiveIsSupportive = true) { if (p == null) return "⚪"; const x = positiveIsSupportive ? p : -p; return x > 1 ? "🟢" : x < -1 ? "🔴" : "🟡"; }
function ageHours(at, anchorAt) {
  const a = parseAt(at), b = parseAt(anchorAt);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 3600000) : null;
}
function ageLabel(at, anchorAt) {
  const h = ageHours(at, anchorAt);
  if (h == null) return "N/A";
  if (h < 1) return "<1h";
  return `${h.toFixed(h < 10 ? 1 : 0)}h`;
}
function sourceLabel(row, anchorAt) {
  if (!row) return "N/A";
  const age = ageLabel(row.at, anchorAt);
  return `${formatET(row.at)} (${age} old)`;
}

async function lastYearValues(anchorAt, signals, stateObj) {
  const anchor = etParts(anchorAt);
  if (!anchor) return {};
  const priorYear = String(Number(anchor.year) - 1);
  const targetDate = `${priorYear}-${anchor.month}-${anchor.day}`;
  const start = `${targetDate}T00`;
  const end = `${targetDate}T23`;
  const common = { frequency: "hourly", "data[]": "value", start, end, "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000 };
  const out = {};

  const loadPayload = await fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D"] }, stateObj);
  for (const row of dataRows(loadPayload)) {
    const key = sameHourKey(row.period);
    if (key !== `${targetDate}-${String(anchor.hour).padStart(2, "0")}`) continue;
    if (String(row.type) === "D" && signals.includes("total_load")) out.total_load ??= Number(row.value);
  }

  const fuelSignals = signals.filter(x => ["gas_generation", "wind_generation", "solar_generation", "total_generation"].includes(x));
  if (fuelSignals.length) {
    const fuelPayload = await fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, stateObj);
    const rows = dataRows(fuelPayload).filter(row => sameHourKey(row.period) === `${targetDate}-${String(anchor.hour).padStart(2, "0")}`);
    const total = rows.find(row => String(row.fueltype || "").toUpperCase() === "ALL");
    const byFuel = new Map(rows.map(row => [String(row.fueltype || "").toUpperCase(), Number(row.value)]));
    if (fuelSignals.includes("gas_generation") && Number.isFinite(byFuel.get("NG"))) out.gas_generation = byFuel.get("NG");
    if (fuelSignals.includes("wind_generation") && Number.isFinite(byFuel.get("WND"))) out.wind_generation = byFuel.get("WND");
    if (fuelSignals.includes("solar_generation") && Number.isFinite(byFuel.get("SUN"))) out.solar_generation = byFuel.get("SUN");
    if (fuelSignals.includes("total_generation") && Number.isFinite(Number(total?.value))) out.total_generation = Number(total.value);
  }
  return out;
}

async function yearOverYear(anchorAt, current, stateObj) {
  const metrics = ["total_load", "gas_generation", "wind_generation", "solar_generation", "total_generation"];
  const last = await lastYearValues(anchorAt, metrics, stateObj);
  const out = {};
  for (const metric of metrics) out[metric] = last[metric] != null && current[metric] != null ? { value: last[metric], pct: pct(current[metric], last[metric]) } : null;
  return out;
}
function yoyLine(yoy) { return yoy == null ? "vs LY              N/A" : `vs LY              ${arrow(yoy.pct)} ${signedPct(yoy.pct)}`; }

async function report(s) {
  const latestRows = Object.fromEntries(ALL_SIGNALS.map(signal => [signal, latest(s, signal)]));
  const rows = Object.fromEntries(CORE_SIGNALS.map(signal => [signal, latestRows[signal] ? comparison(s, signal, latestRows[signal].at, latestRows[signal].value) : null]));
  const loadRow = latestRows.total_load;
  const gasRow = latestRows.gas_generation;
  const windRow = latestRows.wind_generation;
  const solarRow = latestRows.solar_generation;
  const totalGenRow = latestRows.total_generation;
  const load = loadRow?.value ?? null, gas = gasRow?.value ?? null, wind = windRow?.value ?? null, solar = solarRow?.value ?? null, totalGen = totalGenRow?.value ?? null;
  const current = { total_load: load, gas_generation: gas, wind_generation: wind, solar_generation: solar, total_generation: totalGen };
  const yoyAnchor = loadRow?.at || gasRow?.at || windRow?.at || solarRow?.at || null;
  const yoy = yoyAnchor ? await yearOverYear(yoyAnchor, current, s) : {};

  const residualAnchor = latestCommon(s, ["total_load", "wind_generation", "solar_generation"]);
  const residual = residualAnchor ? (() => {
    const l = valueAt(s, "total_load", residualAnchor), w = valueAt(s, "wind_generation", residualAnchor), so = valueAt(s, "solar_generation", residualAnchor);
    return l != null && w != null && so != null ? l - w - so : null;
  })() : null;
  const residualMs = parseAt(residualAnchor);
  const r24 = residualAnchor ? (() => {
    const target = new Date(residualMs - 24 * 3600000).toISOString().slice(0, 13);
    const l = exactAt(s, "total_load", target), w = exactAt(s, "wind_generation", target), so = exactAt(s, "solar_generation", target);
    return l && w && so ? l.value - w.value - so.value : null;
  })() : null;
  const r3 = residualAnchor ? (() => {
    const l = sameHourAverage(s, "total_load", residualAnchor, 3), w = sameHourAverage(s, "wind_generation", residualAnchor, 3), so = sameHourAverage(s, "solar_generation", residualAnchor, 3);
    return l != null && w != null && so != null ? l - w - so : null;
  })() : null;
  const r7 = residualAnchor ? (() => {
    const l = sameHourAverage(s, "total_load", residualAnchor, 7), w = sameHourAverage(s, "wind_generation", residualAnchor, 7), so = sameHourAverage(s, "solar_generation", residualAnchor, 7);
    return l != null && w != null && so != null ? l - w - so : null;
  })() : null;
  const residualP24 = pct(residual, r24);
  const gasShare = gas != null && totalGen > 0 ? gas / totalGen * 100 : null;
  const renewableShare = wind != null && solar != null && totalGen > 0 ? (wind + solar) / totalGen * 100 : null;
  const forecastRow = loadRow ? exactAt(s, "load_forecast", loadRow.at) : null;
  const forecast = forecastRow?.value ?? null;
  const forecastSurprise = load != null && forecast != null ? pct(load, forecast) : null;
  const p = [rows.gas_generation?.p24, rows.total_load?.p24, rows.wind_generation?.p24 != null ? -rows.wind_generation.p24 : null, rows.solar_generation?.p24 != null ? -rows.solar_generation.p24 : null].filter(v => v != null);
  const score = p.length >= 2 ? p.reduce((a, b) => a + b, 0) / p.length : null;
  const overall = score == null ? "⚪ INSUFFICIENT DATA" : score >= 2 ? "🟢 ELEVATED" : score <= -2 ? "🔴 REDUCED" : "🟡 MIXED";
  const divergence = rows.gas_generation?.p24 != null && residualP24 != null && ((rows.gas_generation.p24 > 1 && residualP24 < -1) || (rows.gas_generation.p24 < -1 && residualP24 > 1));

  const anchorAt = loadRow?.at || null;
  const latestDataAt = anchorAt;
  const freshness = signal => latestRows[signal]?.at ? ageLabel(latestRows[signal].at, anchorAt) : "N/A";
  const residualAge = residualAnchor ? ageLabel(residualAnchor, anchorAt) : null;
  const generationAnchorLabel = residualAnchor ? formatET(residualAnchor) : "N/A";

  return [
    "🔥 U.S. POWER → NATGAS", "━━━━━━━━━━━━━━━━━━━━", "",
    `🇺🇸 US ET: ${latestDataAt ? formatET(latestDataAt) : "N/A"}`,
    `🇮🇳 India: ${latestDataAt ? formatIndia(latestDataAt) : "N/A"}`, "",
    "⚡ POWER DEMAND",
    `Now              ${fmtMWh(load)}`,
    `vs 24h             ${arrow(rows.total_load?.p24)} ${signedPct(rows.total_load?.p24)}`,
    `vs 3D avg          ${arrow(rows.total_load?.p3)} ${signedPct(rows.total_load?.p3)}`,
    `vs 7D avg          ${arrow(rows.total_load?.p7)} ${signedPct(rows.total_load?.p7)}`,
    yoyLine(yoy.total_load), "",
    "🔥 GAS GENERATION",
    `Latest EIA         ${fmtMWh(gas)}`,
    `As of              ${sourceLabel(gasRow, anchorAt)}`,
    `vs 24h             ${arrow(rows.gas_generation?.p24)} ${signedPct(rows.gas_generation?.p24)}`,
    `vs 3D avg          ${arrow(rows.gas_generation?.p3)} ${signedPct(rows.gas_generation?.p3)}`,
    `vs 7D avg          ${arrow(rows.gas_generation?.p7)} ${signedPct(rows.gas_generation?.p7)}`,
    yoyLine(yoy.gas_generation),
    `Gas share          ${gasShare == null ? "N/A" : gasShare.toFixed(1) + "%"}`, "",
    "🌬️ WIND",
    `Latest EIA         ${fmtMWh(wind)}`,
    `As of              ${sourceLabel(windRow, anchorAt)}`,
    `vs 24h             ${arrow(rows.wind_generation?.p24)} ${signedPct(rows.wind_generation?.p24)}`,
    `vs 3D avg          ${arrow(rows.wind_generation?.p3)} ${signedPct(rows.wind_generation?.p3)}`,
    `vs 7D avg          ${arrow(rows.wind_generation?.p7)} ${signedPct(rows.wind_generation?.p7)}`,
    yoyLine(yoy.wind_generation), "",
    "☀️ SOLAR",
    `Latest EIA         ${fmtMWh(solar)}`,
    `As of              ${sourceLabel(solarRow, anchorAt)}`,
    `vs 24h             ${arrow(rows.solar_generation?.p24)} ${signedPct(rows.solar_generation?.p24)}`,
    `vs 3D avg          ${arrow(rows.solar_generation?.p3)} ${signedPct(rows.solar_generation?.p3)}`,
    `vs 7D avg          ${arrow(rows.solar_generation?.p7)} ${signedPct(rows.solar_generation?.p7)}`,
    yoyLine(yoy.solar_generation), "",
    "⚡ RESIDUAL LOAD",
    `Load − Wind − Solar ${fmtMWh(residual)}`,
    `Synchronized as of ${generationAnchorLabel} (${residualAge ?? "N/A"} old)`,
    `vs 24h             ${arrow(residualP24)} ${signedPct(residualP24)}`,
    `vs 3D avg          ${arrow(pct(residual, r3))} ${signedPct(pct(residual, r3))}`,
    `vs 7D avg          ${arrow(pct(residual, r7))} ${signedPct(pct(residual, r7))}`,
    `Renewable share    ${renewableShare == null ? "N/A" : renewableShare.toFixed(1) + "%"}`, "",
    "🔮 LOAD EXPECTATION",
    `Actual             ${fmtMWh(load)}`,
    `Forecast           ${fmtMWh(forecast)}`,
    `Actual vs forecast ${arrow(forecastSurprise)} ${signedPct(forecastSurprise)}`,
    forecastRow ? `Forecast as of     ${formatET(forecastRow.at)}` : "Forecast as of     N/A",
    "vs LY              N/A (historical forecast vintages not stored)", "",
    "━━━━━━━━━━━━━━━━━━━━", "📊 FUNDAMENTAL STATE",
    `Power demand       ${directionIcon(rows.total_load?.p24, true)}`,
    `Gas burn           ${directionIcon(rows.gas_generation?.p24, true)}`,
    `Renewables         ${directionIcon(renewableShare, false)}`,
    `Residual load      ${directionIcon(residualP24, true)}`,
    `Forecast surprise  ${directionIcon(forecastSurprise, true)}`,
    `Overall             ${overall}`,
    `Divergence         ${divergence ? "⚠️ DETECTED" : "NONE"}`, "",
    "🕐 DATA FRESHNESS",
    `Load               ${freshness("total_load")}`,
    `Gas                ${freshness("gas_generation")}`,
    `Wind               ${freshness("wind_generation")}`,
    `Solar              ${freshness("solar_generation")}`,
    `Forecast           ${freshness("load_forecast")}`, "",
    "🚨 Generation outages: N/A",
    "EIA-930 does not provide a validated all-generator U.S. outage series.",
    "Source: U.S. Energy Information Administration (EIA)"
  ].join("\n");
}

async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_ID, text }) });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

export default async () => {
  if (!process.env.EIA_API_KEY || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_ID) throw new Error("Missing EIA_API_KEY, TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID");
  const s = await state(), now = new Date(), d = due(now);
  const start = new Date(now.getTime() - 8 * 24 * 3600000);
  const common = { frequency: "hourly", "data[]": "value", start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13), "sort[0][column]": "period", "sort[0][direction]": "desc", length: 5000 };

  if (d.has("gas_generation") || d.has("wind_generation") || d.has("solar_generation") || d.has("total_generation")) {
    const p = await fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, s);
    const r = dataRows(p);
    addSeries(s, "gas_generation", r, x => String(x.fueltype || "").toUpperCase() === "NG");
    addSeries(s, "wind_generation", r, x => String(x.fueltype || "").toUpperCase() === "WND");
    addSeries(s, "solar_generation", r, x => String(x.fueltype || "").toUpperCase() === "SUN");
    addFuelMix(s, r);
  }
  if (d.has("total_load") || d.has("load_forecast")) {
    const p = await fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D", "DF"] }, s);
    const r = dataRows(p);
    addSeries(s, "total_load", r, x => x.type === "D");
    addSeries(s, "load_forecast", r, x => x.type === "DF");
  }

  const cutoff = Date.now() - 10 * 24 * 3600000;
  s.observations = s.observations.filter(o => parseAt(o.at) >= cutoff);
  s.lastRun = now.toISOString();
  await save(s);

  const text = await report(s);
  await telegram(text);
  return new Response(JSON.stringify({ ok: true, lastRun: s.lastRun, observations: s.observations.length, yoy: "EIA_API_ONLY" }), { headers: { "content-type": "application/json" } });
};
