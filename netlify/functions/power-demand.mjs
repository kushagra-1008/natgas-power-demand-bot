import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const SIGNALS = [
  "gas_generation",
  "total_load",
  "wind_generation",
  "solar_generation",
  "total_generation",
  "load_forecast",
];

const CORE_SIGNALS = ["gas_generation", "total_load", "wind_generation", "solar_generation"];
const store = () => getStore("natgas-power-demand");

async function state() {
  const s = (await store().get("state", { type: "json" })) || {
    observations: [], usage: {}, lastRun: null, source: "EIA"
  };
  if (s.source !== "EIA") return { observations: [], usage: {}, lastRun: null, source: "EIA" };
  return s;
}
async function save(s) { await store().setJSON("state", s); }

function hourET(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false
  }).format(now));
}

function formatET(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short"
  }).format(new Date(iso));
}

function formatIndia(iso) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "short", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short"
  }).format(new Date(iso));
}

function due(now = new Date()) {
  const h = hourET(now), d = new Set();
  if ((h >= 6 && h < 18) || h % 3 === 0) {
    d.add("gas_generation"); d.add("total_load");
  }
  if ([8, 12, 16].includes(h)) d.add("solar_generation");
  if (now.getUTCHours() % 6 === 0) {
    d.add("wind_generation");
    d.add("load_forecast");
  }
  return d;
}

function parseAt(x) {
  const s = String(x);
  if (s.endsWith("Z")) return Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
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
    if (!byPeriod.has(at)) byPeriod.set(at, { all: null });
    const g = byPeriod.get(at);
    if (fuel === "ALL") g.all = value;
  }
  for (const [at, g] of byPeriod) {
    if (g.all != null) addObservation(s, "total_generation", { period: at, value: g.all });
  }
}

function rowsFor(s, signal) {
  return s.observations.filter(o => o.signal === signal && Number.isFinite(parseAt(o.at)));
}

function nearestAt(s, signal, targetMs, toleranceMs = 90 * 60 * 1000) {
  const rows = rowsFor(s, signal);
  let best = null, bestDist = Infinity;
  for (const row of rows) {
    const dist = Math.abs(parseAt(row.at) - targetMs);
    if (dist <= toleranceMs && dist < bestDist) { best = row; bestDist = dist; }
  }
  return best;
}

function sameHourKey(iso) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false
  }).formatToParts(new Date(iso));
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("hour")}`;
}

function sameHourAverage(s, signal, anchorAt, days) {
  const anchorMs = parseAt(anchorAt);
  const anchorHour = sameHourKey(anchorAt);
  const values = [];
  for (let d = 1; d <= days; d++) {
    const targetMs = anchorMs - d * 24 * 3600000;
    const row = nearestAt(s, signal, targetMs, 2 * 3600000);
    if (row && sameHourKey(row.at) === anchorHour) values.push(row.value);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function pct(a, b) {
  return b != null && b !== 0 ? (a / b - 1) * 100 : null;
}

function comparison(s, signal, anchorAt, value) {
  const one = nearestAt(s, signal, parseAt(anchorAt) - 24 * 3600000);
  const avg3 = sameHourAverage(s, signal, anchorAt, 3);
  const avg7 = sameHourAverage(s, signal, anchorAt, 7);
  return {
    value,
    v24: one?.value ?? null,
    p24: one ? pct(value, one.value) : null,
    avg3,
    p3: avg3 != null ? pct(value, avg3) : null,
    avg7,
    p7: avg7 != null ? pct(value, avg7) : null,
  };
}

function commonAnchor(s) {
  const sets = CORE_SIGNALS.map(signal => new Set(rowsFor(s, signal).map(o => o.at)));
  if (sets.some(set => set.size === 0)) return null;
  let common = [...sets[0]].filter(at => sets.every(set => set.has(at)));
  common.sort((a, b) => parseAt(a) - parseAt(b));
  return common.at(-1) || null;
}

function valueAt(s, signal, anchorAt) {
  return nearestAt(s, signal, parseAt(anchorAt), 90 * 60 * 1000);
}

function arrow(p) {
  if (p == null) return "•";
  if (p > 1) return "↑";
  if (p < -1) return "↓";
  return "→";
}

function signedPct(p) {
  return p == null ? "N/A" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function fmtMWh(v) {
  return v == null ? "N/A" : `${Math.round(v).toLocaleString("en-US")} MWh`;
}

function report(s, anchorAt) {
  const rows = {};
  for (const signal of CORE_SIGNALS) {
    const r = valueAt(s, signal, anchorAt);
    rows[signal] = r ? comparison(s, signal, anchorAt, r.value) : null;
  }

  const gas = rows.gas_generation?.value;
  const load = rows.total_load?.value;
  const wind = rows.wind_generation?.value;
  const solar = rows.solar_generation?.value;
  const totalGen = valueAt(s, "total_generation", anchorAt)?.value ?? null;
  const residual = load != null && wind != null && solar != null ? load - wind - solar : null;
  const gasShare = gas != null && totalGen ? gas / totalGen * 100 : null;
  const renewableShare = wind != null && solar != null && totalGen ? (wind + solar) / totalGen * 100 : null;

  const residual24 = (() => {
    const l = nearestAt(s, "total_load", parseAt(anchorAt) - 24 * 3600000);
    const w = nearestAt(s, "wind_generation", parseAt(anchorAt) - 24 * 3600000);
    const so = nearestAt(s, "solar_generation", parseAt(anchorAt) - 24 * 3600000);
    return l && w && so ? l.value - w.value - so.value : null;
  })();
  const residual3 = (() => {
    const l = sameHourAverage(s, "total_load", anchorAt, 3);
    const w = sameHourAverage(s, "wind_generation", anchorAt, 3);
    const so = sameHourAverage(s, "solar_generation", anchorAt, 3);
    return l != null && w != null && so != null ? l - w - so : null;
  })();
  const residual7 = (() => {
    const l = sameHourAverage(s, "total_load", anchorAt, 7);
    const w = sameHourAverage(s, "wind_generation", anchorAt, 7);
    const so = sameHourAverage(s, "solar_generation", anchorAt, 7);
    return l != null && w != null && so != null ? l - w - so : null;
  })();

  const forecast = valueAt(s, "load_forecast", anchorAt)?.value ?? null;
  const forecastSurprise = load != null && forecast != null ? (load - forecast) / forecast * 100 : null;

  const pressure = [];
  if (rows.gas_generation?.p24 != null) pressure.push(rows.gas_generation.p24);
  if (rows.total_load?.p24 != null) pressure.push(rows.total_load.p24 * 0.7);
  if (rows.wind_generation?.p24 != null) pressure.push(-rows.wind_generation.p24 * 0.35);
  if (rows.solar_generation?.p24 != null) pressure.push(-rows.solar_generation.p24 * 0.35);
  const score = pressure.length >= 2 ? pressure.reduce((a, b) => a + b, 0) / pressure.length : null;

  const state = score == null ? "⚪ INSUFFICIENT DATA" : score >= 2 ? "🟢 ELEVATED" : score <= -2 ? "🔴 REDUCED" : "🟡 MIXED";
  const residualPct24 = pct(residual, residual24);
  const divergence = score != null && rows.gas_generation?.p24 != null && residualPct24 != null
    ? (rows.gas_generation.p24 > 1 && residualPct24 < -1) || (rows.gas_generation.p24 < -1 && residualPct24 > 1)
    : false;

  const forecastIcon = forecastSurprise == null ? "⚪" : forecastSurprise > 1 ? "🟢" : forecastSurprise < -1 ? "🔴" : "🟡";
  const lines = [
    "🔥 U.S. POWER → NATGAS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🇺🇸 US ET: ${formatET(anchorAt)}`,
    `🇮🇳 India: ${formatIndia(anchorAt)}`,
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
    `Load − Wind − Solar   ${fmtMWh(residual)}`,
    `vs 24h             ${arrow(residualPct24)} ${signedPct(residualPct24)}`,
    `vs 3D avg          ${arrow(pct(residual, residual3))} ${signedPct(pct(residual, residual3))}`,
    `vs 7D avg          ${arrow(pct(residual, residual7))} ${signedPct(pct(residual, residual7))}`,
    `Renewable share    ${renewableShare == null ? "N/A" : renewableShare.toFixed(1) + "%"}`,
    "",
    "🔮 LOAD EXPECTATION",
    `Actual             ${fmtMWh(load)}`,
    `Forecast           ${fmtMWh(forecast)}`,
    `Actual vs forecast ${arrow(forecastSurprise)} ${signedPct(forecastSurprise)}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 FUNDAMENTAL STATE",
    `Power demand       ${rows.total_load ? "🟢" : "⚪"}`,
    `Gas burn           ${rows.gas_generation ? "🟢" : "⚪"}`,
    `Renewables         ${renewableShare != null ? "🟢" : "⚪"}`,
    `Residual load      ${residual != null ? "🟢" : "⚪"}`,
    `Forecast surprise  ${forecastIcon}`,
    `Overall             ${state}`,
    `Divergence         ${divergence ? "⚠️ DETECTED" : "NONE"}`,
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

  s.observations = s.observations
    .filter(o => Number.isFinite(parseAt(o.at)))
    .sort((a, b) => parseAt(a.at) - parseAt(b.at))
    .slice(-15000);
  s.lastRun = now.toISOString();
  await save(s);

  const anchorAt = commonAnchor(s);
  if (d.size && anchorAt) await telegram(report(s, anchorAt));

  return new Response(JSON.stringify({
    ok: true, source: "EIA", due: [...d], unavailable: ["generation_outages"],
    usage: s.usage, observationCount: s.observations.length, anchorAt
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "@hourly" };
