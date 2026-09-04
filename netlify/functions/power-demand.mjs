import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const CORE_SIGNALS = ["gas_generation", "total_load", "wind_generation", "solar_generation"];
const ALL_SIGNALS = [...CORE_SIGNALS, "total_generation", "load_forecast"];
const store = () => getStore("natgas-power-demand");

async function state() {
  const s = (await store().get("state", { type: "json" })) || {
    observations: [], usage: {}, lastRun: null, source: "EIA"
  };
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

function hourET(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : parseAt(now);
  if (!Number.isFinite(ms)) return NaN;
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false
  }).format(new Date(ms)));
}

function formatTime(iso, timeZone, locale = "en-US") {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return "N/A";
  return new Intl.DateTimeFormat(locale, {
    timeZone, weekday: "short", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short"
  }).format(new Date(ms));
}
function formatET(iso) { return formatTime(iso, "America/New_York", "en-US"); }
function formatIndia(iso) { return formatTime(iso, "Asia/Kolkata", "en-IN"); }

function due(now = new Date()) {
  const h = hourET(now), d = new Set();
  if (Number.isFinite(h) && ((h >= 6 && h < 18) || h % 3 === 0)) {
    d.add("gas_generation"); d.add("total_load");
  }
  if ([8, 12, 16].includes(h)) d.add("solar_generation");
  if (now.getUTCHours() % 6 === 0) { d.add("wind_generation"); d.add("load_forecast"); }
  return d;
}

function addObservation(s, signal, row) {
  const value = Number(row?.value), at = String(row?.period || "");
  if (!Number.isFinite(value) || !at || !Number.isFinite(parseAt(at))) return;
  if (!s.observations.some(o => o.signal === signal && o.at === at)) {
    s.observations.push({ signal, value, at, unit: "MWh" });
  }
}
function addSeries(s, signal, rows, predicate) {
  for (const row of rows) if (predicate(row)) addObservation(s, signal, row);
}

function addFuelMix(s, rows) {
  const byPeriod = new Map();
  for (const row of rows) {
    const at = String(row?.period || ""), value = Number(row?.value);
    if (!at || !Number.isFinite(value) || !Number.isFinite(parseAt(at))) continue;
    const fuel = String(row?.fueltype || "").toUpperCase();
    if (!byPeriod.has(at)) byPeriod.set(at, { sum: 0, all: null, count: 0 });
    const g = byPeriod.get(at);
    if (fuel === "ALL") g.all = value;
    else { g.sum += value; g.count++; }
  }
  for (const [at, g] of byPeriod) {
    const total = g.all != null ? g.all : (g.count ? g.sum : null);
    if (total != null && total > 0) addObservation(s, "total_generation", { period: at, value: total });
  }
}

function rowsFor(s, signal) {
  return s.observations.filter(o => o.signal === signal && Number.isFinite(parseAt(o.at)));
}
function latest(s, signal) {
  let best = null, bestMs = -Infinity;
  for (const row of rowsFor(s, signal)) {
    const ms = parseAt(row.at);
    if (ms > bestMs) { best = row; bestMs = ms; }
  }
  return best;
}
function nearestAt(s, signal, targetMs, toleranceMs = 90 * 60 * 1000) {
  if (!Number.isFinite(targetMs)) return null;
  let best = null, bestDist = Infinity;
  for (const row of rowsFor(s, signal)) {
    const rowMs = parseAt(row.at);
    const dist = Math.abs(rowMs - targetMs);
    if (dist <= toleranceMs && dist < bestDist) { best = row; bestDist = dist; }
  }
  return best;
}

function sameHourKey(iso) {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false
  }).formatToParts(new Date(ms));
  const get = type => parts.find(p => p.type === type)?.value;
  const year = get("year"), month = get("month"), day = get("day"), hour = get("hour");
  return year && month && day && hour ? `${year}-${month}-${day}-${String(hour).padStart(2, "0")}` : null;
}

function sameHourAverage(s, signal, anchorAt, days) {
  const anchorMs = parseAt(anchorAt), anchorHour = sameHourKey(anchorAt);
  if (!Number.isFinite(anchorMs) || !anchorHour) return null;
  const values = [];
  for (let d = 1; d <= days; d++) {
    const targetMs = anchorMs - d * 24 * 3600000;
    const row = nearestAt(s, signal, targetMs, 2 * 3600000);
    if (row && sameHourKey(row.at)?.endsWith(`-${sameHourKey(anchorAt).split("-").at(-1)}`)) values.push(row.value);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function pct(a, b) { return b != null && b !== 0 ? (a / b - 1) * 100 : null; }
function comparison(s, signal, anchorAt, value) {
  const anchorMs = parseAt(anchorAt);
  if (!Number.isFinite(anchorMs)) return { value, v24: null, p24: null, avg3: null, p3: null, avg7: null, p7: null };
  const one = nearestAt(s, signal, anchorMs - 24 * 3600000);
  const avg3 = sameHourAverage(s, signal, anchorAt, 3);
  const avg7 = sameHourAverage(s, signal, anchorAt, 7);
  return { value, v24: one?.value ?? null, p24: one ? pct(value, one.value) : null, avg3, p3: avg3 != null ? pct(value, avg3) : null, avg7, p7: avg7 != null ? pct(value, avg7) : null };
}

function valueAt(s, signal, anchorAt) {
  const ms = parseAt(anchorAt);
  return Number.isFinite(ms) ? nearestAt(s, signal, ms, 90 * 60 * 1000) : null;
}
function latestCommon(s, signals, toleranceMs = 90 * 60 * 1000) {
  const anchors = signals.map(signal => latest(s, signal)).filter(Boolean);
  if (anchors.length !== signals.length) return null;
  const candidates = rowsFor(s, signals[0]).sort((a, b) => parseAt(b.at) - parseAt(a.at));
  for (const candidate of candidates) {
    const ms = parseAt(candidate.at);
    if (signals.every(signal => nearestAt(s, signal, ms, toleranceMs))) return candidate.at;
  }
  return null;
}

function arrow(p) { return p == null ? "•" : p > 1 ? "↑" : p < -1 ? "↓" : "→"; }
function signedPct(p) { return p == null ? "N/A" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`; }
function fmtMWh(v) { return v == null ? "N/A" : `${Math.round(v).toLocaleString("en-US")} MWh`; }
function directionIcon(p, positiveIsGood = true) {
  if (p == null) return "⚪";
  const x = positiveIsGood ? p : -p;
  return x > 1 ? "🟢" : x < -1 ? "🔴" : "🟡";
}

function report(s) {
  const latestRows = Object.fromEntries(ALL_SIGNALS.map(signal => [signal, latest(s, signal)]));
  const rows = {};
  for (const signal of CORE_SIGNALS) {
    const r = latestRows[signal];
    rows[signal] = r ? comparison(s, signal, r.at, r.value) : null;
  }

  const loadRow = latestRows.total_load;
  const gasRow = latestRows.gas_generation;
  const windRow = latestRows.wind_generation;
  const solarRow = latestRows.solar_generation;
  const totalGenRow = latestRows.total_generation;
  const forecastRow = latestRows.load_forecast;

  const load = loadRow?.value ?? null;
  const gas = gasRow?.value ?? null;
  const wind = windRow?.value ?? null;
  const solar = solarRow?.value ?? null;
  const totalGen = totalGenRow?.value ?? null;

  const residual = load != null && wind != null && solar != null ? load - wind - solar : null;
  const residualAnchor = latestCommon(s, ["total_load", "wind_generation", "solar_generation"]);
  const residualAnchorMs = parseAt(residualAnchor);
  const residualCurrent = residualAnchor ? (() => {
    const l = valueAt(s, "total_load", residualAnchor)?.value;
    const w = valueAt(s, "wind_generation", residualAnchor)?.value;
    const so = valueAt(s, "solar_generation", residualAnchor)?.value;
    return l != null && w != null && so != null ? l - w - so : null;
  })() : residual;
  const residual24 = residualAnchor ? (() => {
    const l = nearestAt(s, "total_load", residualAnchorMs - 24 * 3600000);
    const w = nearestAt(s, "wind_generation", residualAnchorMs - 24 * 3600000);
    const so = nearestAt(s, "solar_generation", residualAnchorMs - 24 * 3600000);
    return l && w && so ? l.value - w.value - so.value : null;
  })() : null;
  const residual3 = residualAnchor ? (() => {
    const l = sameHourAverage(s, "total_load", residualAnchor, 3);
    const w = sameHourAverage(s, "wind_generation", residualAnchor, 3);
    const so = sameHourAverage(s, "solar_generation", residualAnchor, 3);
    return l != null && w != null && so != null ? l - w - so : null;
  })() : null;
  const residual7 = residualAnchor ? (() => {
    const l = sameHourAverage(s, "total_load", residualAnchor, 7);
    const w = sameHourAverage(s, "wind_generation", residualAnchor, 7);
    const so = sameHourAverage(s, "solar_generation", residualAnchor, 7);
    return l != null && w != null && so != null ? l - w - so : null;
  })() : null;

  const gasShare = gas != null && totalGen > 0 ? gas / totalGen * 100 : null;
  const renewableShare = wind != null && solar != null && totalGen > 0 ? (wind + solar) / totalGen * 100 : null;
  const forecast = forecastRow?.value ?? null;
  const forecastAtLoad = loadRow ? nearestAt(s, "load_forecast", parseAt(loadRow.at), 90 * 60 * 1000) : null;
  const forecastComparable = forecastAtLoad?.value ?? null;
  const forecastSurprise = load != null && forecastComparable != null ? (load / forecastComparable - 1) * 100 : null;

  const p = [rows.gas_generation?.p24, rows.total_load?.p24, rows.wind_generation?.p24 != null ? -rows.wind_generation.p24 : null, rows.solar_generation?.p24 != null ? -rows.solar_generation.p24 : null].filter(v => v != null);
  const score = p.length >= 2 ? p.reduce((a, b) => a + b, 0) / p.length : null;
  const residualPct24 = pct(residualCurrent, residual24);
  const divergence = rows.gas_generation?.p24 != null && residualPct24 != null && ((rows.gas_generation.p24 > 1 && residualPct24 < -1) || (rows.gas_generation.p24 < -1 && residualPct24 > 1));
  const overall = score == null ? "⚪ INSUFFICIENT DATA" : score >= 2 ? "🟢 ELEVATED" : score <= -2 ? "🔴 REDUCED" : "🟡 MIXED";

  const latestDataMs = Math.max(...ALL_SIGNALS.map(signal => parseAt(latestRows[signal]?.at)).filter(Number.isFinite));
  const latestDataAt = Number.isFinite(latestDataMs) ? new Date(latestDataMs).toISOString() : null;
  const freshness = signal => {
    const at = latestRows[signal]?.at, ms = parseAt(at);
    if (!Number.isFinite(ms) || !Number.isFinite(latestDataMs)) return "N/A";
    const hours = Math.max(0, (latestDataMs - ms) / 3600000);
    return hours < 1 ? "<1h" : `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  };

  const lines = [
    "🔥 U.S. POWER → NATGAS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🇺🇸 US ET: ${latestDataAt ? formatET(latestDataAt) : "N/A"}`,
    `🇮🇳 India: ${latestDataAt ? formatIndia(latestDataAt) : "N/A"}`,
    "",
    "⚡ POWER DEMAND",
    `Now              ${fmtMWh(load)}`,
    `vs 24h             ${arrow(rows.total_load?.p24)} ${signedPct(rows.total_load?.p24)}`,
    `vs 3D avg          ${arrow(rows.total_load?.p3)} ${signedPct(rows.total_load?.p3)}`,
    `vs 7D avg          ${arrow(rows.total_load?.p7)} ${signedPct(rows.total_load?.p7)}`,
    "",
    "🔥 GAS BURN",
    `Now              ${fmtMWh(gas)}`,
    `vs 24h             ${arrow(rows.gas_generation?.p24)} ${signedPct(rows.gas_generation?.p24)}`,
    `vs 3D avg          ${arrow(rows.gas_generation?.p3)} ${signedPct(rows.gas_generation?.p3)}`,
    `vs 7D avg          ${arrow(rows.gas_generation?.p7)} ${signedPct(rows.gas_generation?.p7)}`,
    `Gas share          ${gasShare == null ? "N/A" : gasShare.toFixed(1) + "%"}`,
    "",
    "🌬️ WIND",
    `Now              ${fmtMWh(wind)}`,
    `vs 24h             ${arrow(rows.wind_generation?.p24)} ${signedPct(rows.wind_generation?.p24)}`,
    `vs 3D avg          ${arrow(rows.wind_generation?.p3)} ${signedPct(rows.wind_generation?.p3)}`,
    `vs 7D avg          ${arrow(rows.wind_generation?.p7)} ${signedPct(rows.wind_generation?.p7)}`,
    "",
    "☀️ SOLAR",
    `Now              ${fmtMWh(solar)}`,
    `vs 24h             ${arrow(rows.solar_generation?.p24)} ${signedPct(rows.solar_generation?.p24)}`,
    `vs 3D avg          ${arrow(rows.solar_generation?.p3)} ${signedPct(rows.solar_generation?.p3)}`,
    `vs 7D avg          ${arrow(rows.solar_generation?.p7)} ${signedPct(rows.solar_generation?.p7)}`,
    "",
    "⚡ RESIDUAL LOAD",
    `Load − Wind − Solar ${fmtMWh(residualCurrent)}`,
    `vs 24h             ${arrow(residualPct24)} ${signedPct(residualPct24)}`,
    `vs 3D avg          ${arrow(pct(residualCurrent, residual3))} ${signedPct(pct(residualCurrent, residual3))}`,
    `vs 7D avg          ${arrow(pct(residualCurrent, residual7))} ${signedPct(pct(residualCurrent, residual7))}`,
    `Renewable share    ${renewableShare == null ? "N/A" : renewableShare.toFixed(1) + "%"}`,
    "",
    "🔮 LOAD EXPECTATION",
    `Actual             ${fmtMWh(load)}`,
    `Forecast           ${fmtMWh(forecastComparable ?? forecast)}`,
    `Actual vs forecast ${arrow(forecastSurprise)} ${signedPct(forecastSurprise)}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 FUNDAMENTAL STATE",
    `Power demand       ${directionIcon(rows.total_load?.p24, true)}`,
    `Gas burn           ${directionIcon(rows.gas_generation?.p24, true)}`,
    `Renewables         ${directionIcon(renewableShare != null ? -((renewableShare - (renewableShare)) || 0) : null, true)}`,
    `Residual load      ${directionIcon(residualPct24, true)}`,
    `Forecast surprise  ${directionIcon(forecastSurprise, true)}`,
    `Overall             ${overall}`,
    `Divergence         ${divergence ? "⚠️ DETECTED" : "NONE"}`,
    "",
    "🕐 DATA FRESHNESS",
    `Load               ${freshness("total_load")}`,
    `Gas                ${freshness("gas_generation")}`,
    `Wind               ${freshness("wind_generation")}`,
    `Solar              ${freshness("solar_generation")}`,
    `Forecast           ${freshness("load_forecast")}`,
    "",
    "🚨 Generation outages: N/A",
    "EIA-930 does not provide a validated all-generator U.S. outage series.",
    "Source: U.S. Energy Information Administration (EIA)",
  ];
  return lines.join("\n");
}

async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_GROUP_ID, text })
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

export default async () => {
  if (!process.env.EIA_API_KEY || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_ID) {
    throw new Error("Missing EIA_API_KEY, TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID");
  }
  const s = await state(), now = new Date(), d = due(now);
  const start = new Date(now.getTime() - 8 * 24 * 3600000);
  const common = {
    frequency: "hourly", "data[]": "value",
    start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13),
    "sort[0][column]": "period", "sort[0][direction]": "desc", length: 5000
  };

  if (d.has("total_load") || d.has("load_forecast")) {
    const p = await fetchEIA("/electricity/rto/region-data/data/", {
      ...common, "facets[respondent][]": "US48", "facets[type][]": ["D", "DF"]
    }, s);
    const r = dataRows(p);
    addSeries(s, "total_load", r, x => x.type === "D");
    addSeries(s, "load_forecast", r, x => x.type === "DF");
  }
  if (d.has("gas_generation") || d.has("wind_generation") || d.has("solar_generation")) {
    const p = await fetchEIA("/electricity/rto/fuel-type-data/data/", {
      ...common, "facets[respondent][]": "US48"
    }, s);
    const r = dataRows(p);
    addSeries(s, "gas_generation", r, x => x.fueltype === "NG");
    addSeries(s, "wind_generation", r, x => x.fueltype === "WND");
    addSeries(s, "solar_generation", r, x => x.fueltype === "SUN");
    addFuelMix(s, r);
  }

  s.observations = s.observations.filter(o => Number.isFinite(parseAt(o.at)))
    .sort((a, b) => parseAt(a.at) - parseAt(b.at)).slice(-15000);
  s.lastRun = now.toISOString();
  await save(s);

  if (d.size) await telegram(report(s));

  return new Response(JSON.stringify({
    ok: true, source: "EIA", due: [...d], unavailable: ["generation_outages"],
    usage: s.usage, observationCount: s.observations.length,
    latest: Object.fromEntries(ALL_SIGNALS.map(signal => [signal, latest(s, signal)?.at || null]))
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "@hourly" };