import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const store = () => getStore("natgas-power-demand");

function parseAt(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}

function etHour(now) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).format(now));
}

function formatTime(iso, timeZone) {
  const ms = parseAt(iso);
  if (!Number.isFinite(ms)) return "N/A";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(ms));
}

function fmtMWh(v) {
  return v == null ? "N/A" : `${Math.round(v).toLocaleString("en-US")} MWh`;
}

function pct(a, b) {
  return b != null && b !== 0 ? (a / b - 1) * 100 : null;
}

function signed(p) {
  return p == null ? "N/A" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function arrow(p) {
  return p == null ? "→" : p > 1 ? "↑" : p < -1 ? "↓" : "→";
}

function latest(rows, predicate) {
  return rows
    .filter(predicate)
    .map((r) => ({ value: numericValue(r), at: periodValue(r) || String(r.at || "") }))
    .filter((r) => Number.isFinite(r.value) && Number.isFinite(parseAt(r.at)))
    .sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null;
}

function nearest(rows, targetMs, predicate, toleranceMs = 2 * 3600000) {
  let best = null;
  let bestDist = Infinity;
  for (const row of rows) {
    if (!predicate(row)) continue;
    const at = periodValue(row) || String(row.at || "");
    const ms = parseAt(at);
    if (!Number.isFinite(ms)) continue;
    const dist = Math.abs(ms - targetMs);
    if (dist <= toleranceMs && dist < bestDist) {
      best = { value: numericValue(row), at };
      bestDist = dist;
    }
  }
  return best;
}

function sameHourAverage(rows, anchorMs, predicate, days) {
  const anchor = new Date(anchorMs);
  const targetHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).format(anchor);

  const values = [];
  for (let d = 1; d <= days; d++) {
    const row = nearest(rows, anchorMs - d * 24 * 3600000, predicate, 2 * 3600000);
    if (!row) continue;
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(parseAt(row.at)));
    if (hour === targetHour) values.push(row.value);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function fuelType(row) {
  return String(
    row.fueltype ??
    row["fuel-type"] ??
    row.fuel_type ??
    row.fueltypeid ??
    row.fueltype_id ??
    ""
  ).trim().toUpperCase();
}

function numericValue(row) {
  const raw = row?.value ?? row?.["value"] ?? row?.data?.value;
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function periodValue(row) {
  return String(row?.period ?? row?.timestamp ?? row?.datetime ?? "").trim();
}

function addFuelMix(rows) {
  const byPeriod = new Map();
  for (const row of rows) {
    const at = String(row.period || "");
    const value = Number(row.value);
    if (!at || !Number.isFinite(value)) continue;
    if (!byPeriod.has(at)) byPeriod.set(at, {});
    byPeriod.get(at)[fuelType(row)] = value;
  }
  return byPeriod;
}

async function loadState() {
  return (await store().get("state", { type: "json" })) || {};
}

async function saveState(s) {
  await store().setJSON("state", s);
}

async function sendTelegram(message) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_GROUP_ID,
        text: message,
        disable_web_page_preview: true,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Telegram ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

function buildReport(s) {
  const signals = ["gas_generation", "total_load", "wind_generation", "solar_generation"];
  const latestRows = Object.fromEntries(signals.map((signal) => [signal, latest(s.observations || [], (r) => r.signal === signal)]));

  const loadRow = latestRows.total_load;
  const gasRow = latestRows.gas_generation;
  const windRow = latestRows.wind_generation;
  const solarRow = latestRows.solar_generation;

  const load = loadRow?.value ?? null;
  const gas = gasRow?.value ?? null;
  const wind = windRow?.value ?? null;
  const solar = solarRow?.value ?? null;

  const load24 = loadRow ? nearest(s.observations, parseAt(loadRow.at) - 24 * 3600000, (r) => r.signal === "total_load") : null;
  const gas24 = gasRow ? nearest(s.observations, parseAt(gasRow.at) - 24 * 3600000, (r) => r.signal === "gas_generation") : null;
  const wind24 = windRow ? nearest(s.observations, parseAt(windRow.at) - 24 * 3600000, (r) => r.signal === "wind_generation") : null;
  const solar24 = solarRow ? nearest(s.observations, parseAt(solarRow.at) - 24 * 3600000, (r) => r.signal === "solar_generation") : null;

  const load3 = loadRow ? sameHourAverage(s.observations, parseAt(loadRow.at), (r) => r.signal === "total_load", 3) : null;
  const load7 = loadRow ? sameHourAverage(s.observations, parseAt(loadRow.at), (r) => r.signal === "total_load", 7) : null;
  const gas3 = gasRow ? sameHourAverage(s.observations, parseAt(gasRow.at), (r) => r.signal === "gas_generation", 3) : null;
  const gas7 = gasRow ? sameHourAverage(s.observations, parseAt(gasRow.at), (r) => r.signal === "gas_generation", 7) : null;
  const wind3 = windRow ? sameHourAverage(s.observations, parseAt(windRow.at), (r) => r.signal === "wind_generation", 3) : null;
  const wind7 = windRow ? sameHourAverage(s.observations, parseAt(windRow.at), (r) => r.signal === "wind_generation", 7) : null;
  const solar3 = solarRow ? sameHourAverage(s.observations, parseAt(solarRow.at), (r) => r.signal === "solar_generation", 3) : null;
  const solar7 = solarRow ? sameHourAverage(s.observations, parseAt(solarRow.at), (r) => r.signal === "solar_generation", 7) : null;

  const fuelMix = Object.fromEntries(addFuelMix(s._fuelRows || []).entries());
  const totalGeneration = Object.values(fuelMix).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const gasShare = totalGeneration > 0 && gas != null ? gas / totalGeneration * 100 : null;
  const renewableShare = totalGeneration > 0 && wind != null && solar != null ? (wind + solar) / totalGeneration * 100 : null;

  const residual = load != null && wind != null && solar != null ? load - wind - solar : null;
  const residual24 = load24 && wind24 && solar24 ? load24.value - wind24.value - solar24.value : null;

  const forecastRow = loadRow
    ? (s.observations || []).find((r) => r.signal === "load_forecast" && r.at === loadRow.at)
    : null;
  const forecast = forecastRow?.value ?? null;
  const forecastSurprise = load != null && forecast != null ? pct(load, forecast) : null;

  const scoreParts = [
    loadRow && load24 ? pct(load, load24.value) : null,
    gasRow && gas24 ? pct(gas, gas24.value) : null,
    residual != null && residual24 != null ? pct(residual, residual24) : null,
    renewableShare != null ? -renewableShare : null,
  ].filter((v) => v != null);

  const score = scoreParts.length ? scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length : null;
  const overall = score == null ? "⚪ INSUFFICIENT DATA" : score >= 2 ? "🟢 ELEVATED" : score <= -2 ? "🔴 REDUCED" : "🟡 MIXED";

  return [
    "🔥 U.S. POWER → NATGAS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🇺🇸 US ET: ${loadRow ? formatTime(loadRow.at, "America/New_York") : "N/A"}`,
    `🇮🇳 India: ${loadRow ? formatTime(loadRow.at, "Asia/Kolkata") : "N/A"}`,
    "",
    "⚡ POWER DEMAND",
    `Now              ${fmtMWh(load)}`,
    `vs 24h           ${arrow(loadRow && load24 ? pct(load, load24.value) : null)} ${signed(loadRow && load24 ? pct(load, load24.value) : null)}`,
    `vs 3D avg        ${arrow(load3 != null && load != null ? pct(load, load3) : null)} ${signed(load3 != null && load != null ? pct(load, load3) : null)}`,
    `vs 7D avg        ${arrow(load7 != null && load != null ? pct(load, load7) : null)} ${signed(load7 != null && load != null ? pct(load, load7) : null)}`,
    "",
    "🔥 GAS GENERATION",
    `Latest EIA       ${fmtMWh(gas)}`,
    `As of            ${gasRow ? formatTime(gasRow.at, "America/New_York") : "N/A"}`,
    `vs 24h           ${arrow(gasRow && gas24 ? pct(gas, gas24.value) : null)} ${signed(gasRow && gas24 ? pct(gas, gas24.value) : null)}`,
    `vs 3D avg        ${arrow(gas3 != null && gas != null ? pct(gas, gas3) : null)} ${signed(gas3 != null && gas != null ? pct(gas, gas3) : null)}`,
    `vs 7D avg        ${arrow(gas7 != null && gas != null ? pct(gas, gas7) : null)} ${signed(gas7 != null && gas != null ? pct(gas, gas7) : null)}`,
    `Gas share        ${gasShare == null ? "N/A" : gasShare.toFixed(1) + "%"}`,
    "",
    "🌬️ WIND",
    `Latest EIA       ${fmtMWh(wind)}`,
    `vs 24h           ${arrow(windRow && wind24 ? pct(wind, wind24.value) : null)} ${signed(windRow && wind24 ? pct(wind, wind24.value) : null)}`,
    `vs 3D avg        ${arrow(wind3 != null && wind != null ? pct(wind, wind3) : null)} ${signed(wind3 != null && wind != null ? pct(wind, wind3) : null)}`,
    `vs 7D avg        ${arrow(wind7 != null && wind != null ? pct(wind, wind7) : null)} ${signed(wind7 != null && wind != null ? pct(wind, wind7) : null)}`,
    "",
    "☀️ SOLAR",
    `Latest EIA       ${fmtMWh(solar)}`,
    `vs 24h           ${arrow(solarRow && solar24 ? pct(solar, solar24.value) : null)} ${signed(solarRow && solar24 ? pct(solar, solar24.value) : null)}`,
    `vs 3D avg        ${arrow(solar3 != null && solar != null ? pct(solar, solar3) : null)} ${signed(solar3 != null && solar != null ? pct(solar, solar3) : null)}`,
    `vs 7D avg        ${arrow(solar7 != null && solar != null ? pct(solar, solar7) : null)} ${signed(solar7 != null && solar != null ? pct(solar, solar7) : null)}`,
    "",
    "⚡ RESIDUAL LOAD",
    `Load − Wind − Solar  ${fmtMWh(residual)}`,
    `vs 24h           ${arrow(residual24 != null && residual != null ? pct(residual, residual24) : null)} ${signed(residual24 != null && residual != null ? pct(residual, residual24) : null)}`,
    "",
    "🔮 LOAD EXPECTATION",
    `Actual             ${fmtMWh(load)}`,
    `Forecast           ${fmtMWh(forecast)}`,
    `Actual vs forecast ${arrow(forecastSurprise)} ${signed(forecastSurprise)}`,
    "",
    "📊 FUNDAMENTAL STATE",
    `Power demand      ${arrow(loadRow && load24 ? pct(load, load24.value) : null)}`,
    `Gas burn          ${arrow(gasRow && gas24 ? pct(gas, gas24.value) : null)}`,
    `Residual load     ${arrow(residual24 != null && residual != null ? pct(residual, residual24) : null)}`,
    `Renewables       ${renewableShare == null ? "N/A" : renewableShare.toFixed(1) + "%"}`,
    `Overall           ${overall}`,
    "",
    "🚨 Generation outages: N/A",
    "EIA-930 does not provide a validated all-generator U.S. outage series.",
    "Source: U.S. Energy Information Administration (EIA)",
  ].join("\n");
}

export default async () => {
  const { EIA_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID } = process.env;
  if (!EIA_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_ID) {
    throw new Error("Missing EIA_API_KEY, TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID");
  }

  const s = await loadState();
  const now = new Date();

  // One invocation = one fetch/send. No backfill, no extra report jobs, no historical repair.
  const start = new Date(now.getTime() - 8 * 24 * 3600000);
  const common = {
    frequency: "hourly",
    "data[]": "value",
    start: start.toISOString().slice(0, 13),
    end: now.toISOString().slice(0, 13),
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    length: 5000,
  };

  // EIA-930 publication cadence: load hourly, fuel mix every 3h,
  // forecast every 6h. This stays below the 1,250/month request budget.
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    hour12: false,
  }).format(now));

  let fuelRows = Array.isArray(s.fuelRows) ? s.fuelRows : [];
  let loadRows = [];
  let forecastRows = [];

  const loadPayload = await fetchEIA("/electricity/rto/region-data/data/", {
    ...common,
    "facets[respondent][]": "US48",
    "facets[type][]": "D",
  }, s);
  loadRows = dataRows(loadPayload);

  if (hour % 3 === 0 || fuelRows.length === 0) {
    const fuelPayload = await fetchEIA("/electricity/rto/fuel-type-data/data/", {
      ...common,
      "facets[respondent][]": "US48",
      "facets[fueltype][]": ["NG", "WND", "SUN"],
    }, s);
    fuelRows = dataRows(fuelPayload);
    s.fuelRows = fuelRows;
  }

  if (hour % 6 === 0 || !(s.observations || []).some((o) => o.signal === "load_forecast")) {
    const forecastPayload = await fetchEIA("/electricity/rto/region-data/data/", {
      ...common,
      "facets[respondent][]": "US48",
      "facets[type][]": "DF",
    }, s);
    forecastRows = dataRows(forecastPayload);
  }

  console.log(JSON.stringify({
    eia_counts: { load: loadRows.length, forecast: forecastRows.length, fuel: fuelRows.length },
    eia_latest: {
      load: loadRows[0]?.period || null,
      forecast: forecastRows[0]?.period || null,
      fuel: fuelRows[0]?.period || null,
    },
  }));

  for (const row of fuelRows) {
    const type = fuelType(row);
    if (!["NG", "WND", "SUN"].includes(type)) continue;
    const signal = type === "NG" ? "gas_generation" : type === "WND" ? "wind_generation" : "solar_generation";
    const value = numericValue(row);
    const at = periodValue(row);
    if (Number.isFinite(value) && at && !s.observations?.some((o) => o.signal === signal && o.at === at)) {
      (s.observations ||= []).push({ signal, value, at, unit: "MWh" });
    }
  }

  for (const row of loadRows) {
    const type = String(row.type || "");
    const signal = type === "D" ? "total_load" : null;
    if (!signal) continue;
    const value = numericValue(row);
    const at = periodValue(row);
    if (Number.isFinite(value) && at && !s.observations?.some((o) => o.signal === signal && o.at === at)) {
      (s.observations ||= []).push({ signal, value, at, unit: "MWh" });
    }
  }

  for (const row of forecastRows) {
    const value = numericValue(row);
    const at = periodValue(row);
    if (Number.isFinite(value) && at && !s.observations?.some((o) => o.signal === "load_forecast" && o.at === at)) {
      (s.observations ||= []).push({ signal: "load_forecast", value, at, unit: "MWh" });
    }
  }

  s._fuelRows = fuelRows.filter((r) => Number.isFinite(numericValue(r))).map((r) => ({
    ...r,
    value: numericValue(r),
    period: periodValue(r),
  }));
  const cutoff = Date.now() - 10 * 24 * 3600000;
  s.observations = (s.observations || []).filter((o) => parseAt(o.at) >= cutoff);

  const parsedSignals = ["total_load", "gas_generation", "wind_generation", "solar_generation"]
    .filter((signal) => (s.observations || []).some((o) => o.signal === signal));

  console.log(JSON.stringify({
    parsed_signals: parsedSignals,
    observation_count: (s.observations || []).length,
    latest_observation: (s.observations || []).sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null,
  }));

  if (!parsedSignals.includes("total_load") || !parsedSignals.includes("gas_generation")) {
    throw new Error(
      `EIA parsed insufficient signals: ${JSON.stringify({
        parsedSignals,
        loadRows: loadRows.length,
        forecastRows: forecastRows.length,
        fuelRows: fuelRows.length,
        sampleLoad: loadRows[0] || null,
        sampleFuel: fuelRows[0] || null,
      }).slice(0, 1800)}`
    );
  }

  const report = buildReport(s);
  const reportHour = loadRows.length
    ? latest(loadRows, (r) => String(r.type || "") === "D")
    : null;
  // Version the send key so the first corrected deployment can resend the
  // current EIA period that may previously have been sent as an N/A report.
  const fetchKey = `v3:${reportHour?.at || now.toISOString()}`;

  // Netlify can retry a scheduled invocation. The same EIA period must never send twice.
  if (s.lastSentFetchKey === fetchKey) {
    s.lastRun = now.toISOString();
    s.lastDuplicateSuppressed = true;
    await saveState(s);
    return new Response(JSON.stringify({
      ok: true,
      sent: false,
      duplicate_suppressed: true,
      fetchKey,
      lastRun: s.lastRun,
    }), { headers: { "content-type": "application/json" } });
  }

  await sendTelegram(report);

  s.lastRun = now.toISOString();
  s.lastSentFetchKey = fetchKey;
  s.lastDuplicateSuppressed = false;
  await saveState(s);

  return new Response(JSON.stringify({
    ok: true,
    sent: true,
    fetchKey,
    observations: s.observations.length,
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "@hourly" };
