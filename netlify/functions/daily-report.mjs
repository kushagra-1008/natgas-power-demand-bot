import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows } from "./eia.mjs";

const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const ET = "America/New_York";
const store = () => getStore("natgas-power-demand");

function parseAt(value) {
  const s = String(value ?? "").trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}
function sameHourKey(value) {
  const ms = parseAt(value);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false
  }).formatToParts(new Date(ms));
  const get = type => parts.find(x => x.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}`;
}
function formatTime(value, tz = ET) {
  const ms = parseAt(value);
  if (!Number.isFinite(ms)) return "N/A";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true, timeZoneName: "short"
  }).format(new Date(ms));
}
function latest(rows, predicate) {
  return rows.filter(predicate)
    .map(r => ({ ...r, value: Number(r.value), at: String(r.period || "") }))
    .filter(r => Number.isFinite(r.value) && Number.isFinite(parseAt(r.at)))
    .sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null;
}
function nearest(rows, targetMs, predicate, tolerance = 90 * 60 * 1000) {
  let best = null;
  let distance = Infinity;
  for (const row of rows) {
    if (!predicate(row)) continue;
    const ms = parseAt(row.period);
    if (!Number.isFinite(ms)) continue;
    const d = Math.abs(ms - targetMs);
    if (d <= tolerance && d < distance) {
      best = row;
      distance = d;
    }
  }
  return best;
}
function average(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function percent(current, base) {
  return Number.isFinite(current) && Number.isFinite(base) && base !== 0 ? (current / base - 1) * 100 : null;
}
function percentagePoint(current, base) {
  return Number.isFinite(current) && Number.isFinite(base) ? current - base : null;
}
function signed(value, digits = 1) {
  return value == null ? "N/A" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
function signedPP(value) {
  return value == null ? "N/A" : `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
}
function fmtMWh(value) {
  return value == null ? "N/A" : `${Math.round(value).toLocaleString("en-US")} MWh`;
}
function fmtNum(value, digits = 1) {
  return value == null ? "N/A" : Number(value).toFixed(digits);
}
function arrow(value) {
  return value == null ? "→" : value > 1 ? "↑" : value < -1 ? "↓" : "→";
}
function fuelPredicate(code) {
  return row => String(row.fueltype || "").toUpperCase() === code;
}
function sameHourAverage(rows, anchorMs, predicate, days) {
  const anchorKey = sameHourKey(new Date(anchorMs).toISOString());
  const values = [];
  for (let d = 1; d <= days; d++) {
    const row = nearest(rows, anchorMs - d * 86400000, predicate, 2 * 3600000);
    if (row && sameHourKey(row.period) === anchorKey && Number.isFinite(Number(row.value))) values.push(Number(row.value));
  }
  return average(values);
}
function fuelAt(rows, targetMs) {
  const get = code => nearest(rows, targetMs, fuelPredicate(code));
  const ng = get("NG");
  const wnd = get("WND");
  const sun = get("SUN");
  const all = get("ALL");
  return {
    gas: ng ? Number(ng.value) : null,
    wind: wnd ? Number(wnd.value) : null,
    solar: sun ? Number(sun.value) : null,
    total: all ? Number(all.value) : null
  };
}
function priorYearDate(anchorAt) {
  const ms = parseAt(anchorAt);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = type => parts.find(x => x.type === type)?.value;
  return `${Number(get("year")) - 1}-${get("month")}-${get("day")}`;
}

async function getPriorYear(state, anchorAt) {
  const date = priorYearDate(anchorAt);
  if (!date) return {};
  const anchorMs = parseAt(anchorAt);
  const targetKey = sameHourKey(new Date(anchorMs - 365 * 86400000).toISOString());
  const common = {
    frequency: "hourly", "data[]": "value", start: `${date}T00`, end: `${date}T23`,
    "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000
  };
  const [loadPayload, fuelPayload] = await Promise.all([
    fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D"] }, state),
    fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, state)
  ]);
  const loadRows = dataRows(loadPayload);
  const fuelRows = dataRows(fuelPayload);
  const load = loadRows.find(r => String(r.type) === "D" && sameHourKey(r.period) === targetKey);
  const mix = fuelAt(fuelRows, anchorMs - 365 * 86400000);
  return {
    load: load ? Number(load.value) : null,
    gas: mix.gas,
    wind: mix.wind,
    solar: mix.solar,
    total: mix.total
  };
}

function weatherFacts(state) {
  const weather = state.weather || {};
  const actual = Array.isArray(weather.actual) ? weather.actual.filter(x => Number.isFinite(Number(x.hdd)) && Number.isFinite(Number(x.cdd))) : [];
  const forecast = Array.isArray(weather.forecast) ? weather.forecast.filter(x => Number.isFinite(Number(x.hdd)) && Number.isFinite(Number(x.cdd))) : [];
  const a = actual.at(-1);
  const p = actual.at(-2);
  const dd = x => x ? Number(x.hdd || 0) + Number(x.cdd || 0) : null;
  const sumDays = n => {
    const slice = forecast.slice(0, n);
    return {
      hdd: slice.length ? slice.reduce((s, x) => s + Number(x.hdd || 0), 0) : null,
      cdd: slice.length ? slice.reduce((s, x) => s + Number(x.cdd || 0), 0) : null,
      tdd: slice.length ? slice.reduce((s, x) => s + dd(x), 0) : null
    };
  };
  return {
    actualDate: a?.date || null,
    current: a ? { hdd: Number(a.hdd), cdd: Number(a.cdd), tdd: dd(a) } : null,
    prior: p ? { hdd: Number(p.hdd), cdd: Number(p.cdd), tdd: dd(p) } : null,
    avg3: actual.length ? { hdd: average(actual.slice(-3).map(x => Number(x.hdd))), cdd: average(actual.slice(-3).map(x => Number(x.cdd))), tdd: average(actual.slice(-3).map(dd)) } : null,
    avg7: actual.length ? { hdd: average(actual.slice(-7).map(x => Number(x.hdd))), cdd: average(actual.slice(-7).map(x => Number(x.cdd))), tdd: average(actual.slice(-7).map(dd)) } : null,
    forecast: { d1: sumDays(1), d3: sumDays(3), d7: sumDays(7), through: forecast.at(-1)?.date || null, source: forecast.length ? "NOAA/CPC NDFD 7-day" : null }
  };
}

function classify(loadPct, gasPct, residualPct, renewableDeltaPP, completeness) {
  const drivers = [gasPct, residualPct, loadPct, renewableDeltaPP == null ? null : -renewableDeltaPP].filter(Number.isFinite);
  if (completeness < 0.75 || drivers.length < 2) return { state: "INSUFFICIENT DATA", confidence: "LOW", score: null };
  const score = drivers.reduce((a, b) => a + Math.max(-20, Math.min(20, b)), 0) / drivers.length;
  const agreement = [gasPct, residualPct, loadPct].filter(Number.isFinite);
  const pos = agreement.filter(x => x > 1).length;
  const neg = agreement.filter(x => x < -1).length;
  let state = score >= 2 ? "STRONGER" : score <= -2 ? "WEAKER" : "MIXED";
  if (gasPct != null && residualPct != null && gasPct > 1 && residualPct < -1) state = "MIXED";
  if (gasPct != null && residualPct != null && gasPct < -1 && residualPct > 1) state = "MIXED";
  const confidence = completeness >= 0.95 && (pos === 0 || neg === 0 || Math.max(pos, neg) >= 2) ? "HIGH" : completeness >= 0.9 ? "MEDIUM" : "LOW";
  return { state, confidence, score };
}

async function buildFacts() {
  const state = (await store().get("state", { type: "json" })) || { weather: {}, usage: {} };
  const now = new Date();
  const start = new Date(now.getTime() - 8 * 86400000);
  const common = {
    frequency: "hourly", "data[]": "value", start: start.toISOString().slice(0, 13), end: now.toISOString().slice(0, 13),
    "sort[0][column]": "period", "sort[0][direction]": "asc", length: 5000
  };
  const [fuelPayload, loadPayload] = await Promise.all([
    fetchEIA("/electricity/rto/fuel-type-data/data/", { ...common, "facets[respondent][]": "US48" }, state),
    fetchEIA("/electricity/rto/region-data/data/", { ...common, "facets[respondent][]": "US48", "facets[type][]": ["D", "DF"] }, state)
  ]);
  const fuelRows = dataRows(fuelPayload);
  const loadRows = dataRows(loadPayload);
  const loadRow = latest(loadRows, r => String(r.type) === "D");
  if (!loadRow) throw new Error("No current EIA load observation");

  const anchorAt = loadRow.at;
  const anchorMs = parseAt(anchorAt);
  const mix = fuelAt(fuelRows, anchorMs);
  const priorLoad = nearest(loadRows, anchorMs - 86400000, r => String(r.type) === "D");
  const gas24 = nearest(fuelRows, anchorMs - 86400000, fuelPredicate("NG"));
  const wind24 = nearest(fuelRows, anchorMs - 86400000, fuelPredicate("WND"));
  const solar24 = nearest(fuelRows, anchorMs - 86400000, fuelPredicate("SUN"));
  const residual = mix.wind != null && mix.solar != null ? loadRow.value - mix.wind - mix.solar : null;
  const residual24 = priorLoad && wind24 && solar24 ? Number(priorLoad.value) - Number(wind24.value) - Number(solar24.value) : null;
  const load3 = sameHourAverage(loadRows, anchorMs, r => String(r.type) === "D", 3);
  const load7 = sameHourAverage(loadRows, anchorMs, r => String(r.type) === "D", 7);
  const gas3 = sameHourAverage(fuelRows, anchorMs, fuelPredicate("NG"), 3);
  const gas7 = sameHourAverage(fuelRows, anchorMs, fuelPredicate("NG"), 7);
  const wind3 = sameHourAverage(fuelRows, anchorMs, fuelPredicate("WND"), 3);
  const wind7 = sameHourAverage(fuelRows, anchorMs, fuelPredicate("WND"), 7);
  const solar3 = sameHourAverage(fuelRows, anchorMs, fuelPredicate("SUN"), 3);
  const solar7 = sameHourAverage(fuelRows, anchorMs, fuelPredicate("SUN"), 7);
  const residual3 = load3 != null && wind3 != null && solar3 != null ? load3 - wind3 - solar3 : null;
  const residual7 = load7 != null && wind7 != null && solar7 != null ? load7 - wind7 - solar7 : null;

  const forecastRows = loadRows.filter(r => String(r.type) === "DF" && Number.isFinite(Number(r.value)) && parseAt(r.period) > anchorMs).sort((a, b) => parseAt(a.period) - parseAt(b.period));
  const loadForecast = {
    next1h: forecastRows[0] ? Number(forecastRows[0].value) : null,
    next3hAvg: average(forecastRows.slice(0, 3).map(r => Number(r.value))),
    next7hAvg: average(forecastRows.slice(0, 7).map(r => Number(r.value))),
    surprisePct: forecastRows[0] ? percent(loadRow.value, Number(forecastRows[0].value)) : null
  };

  const total = mix.total;
  const gasShare = mix.gas != null && total > 0 ? mix.gas / total * 100 : null;
  const renewableShare = mix.wind != null && mix.solar != null && total > 0 ? (mix.wind + mix.solar) / total * 100 : null;
  const priorRenewableShare = wind24 && solar24 && total > 0 ? (Number(wind24.value) + Number(solar24.value)) / total * 100 : null;
  const renewableDeltaPP = percentagePoint(renewableShare, priorRenewableShare);
  const priorYear = await getPriorYear(state, anchorAt);
  const priorYearResidual = priorYear.load != null && priorYear.wind != null && priorYear.solar != null ? priorYear.load - priorYear.wind - priorYear.solar : null;
  const yoy = {
    load: percent(loadRow.value, priorYear.load), gas: percent(mix.gas, priorYear.gas), wind: percent(mix.wind, priorYear.wind), solar: percent(mix.solar, priorYear.solar),
    residual: percent(residual, priorYearResidual)
  };

  const values = [loadRow.value, mix.gas, mix.wind, mix.solar, total, residual];
  const completeness = values.filter(Number.isFinite).length / values.length;
  const fundamental = classify(percent(mix.gas, gas24?.value), percent(mix.gas, gas3), percent(residual, residual24), renewableDeltaPP, completeness);
  const weather = weatherFacts(state);

  return {
    anchorAt,
    anchorET: formatTime(anchorAt, ET),
    anchorIST: formatTime(anchorAt, "Asia/Kolkata"),
    fundamental,
    completeness,
    current: {
      load: loadRow.value, gas: mix.gas, wind: mix.wind, solar: mix.solar, totalGeneration: total, residual, gasShare, renewableShare
    },
    change: {
      load24: percent(loadRow.value, priorLoad?.value), load3: percent(loadRow.value, load3), load7: percent(loadRow.value, load7),
      gas24: percent(mix.gas, gas24?.value), gas3: percent(mix.gas, gas3), gas7: percent(mix.gas, gas7),
      wind24: percent(mix.wind, wind24?.value), wind3: percent(mix.wind, wind3), wind7: percent(mix.wind, wind7),
      solar24: percent(mix.solar, solar24?.value), solar3: percent(mix.solar, solar3), solar7: percent(mix.solar, solar7),
      residual24: percent(residual, residual24), residual3: percent(residual, residual3), residual7: percent(residual, residual7), renewableDeltaPP
    },
    yoy,
    forecast: loadForecast,
    weather,
    source: "EIA US48 electricity data + NOAA/CPC weather data"
  };
}

async function callNemotron(facts, apiKey) {
  const systemPrompt = [
    "You are a senior U.S. power-market analyst writing a professional daily natural-gas power-demand note.",
    "Use ONLY the supplied facts. Never invent data, causes, market prices, weather values, or outages.",
    "The deterministic fundamental state supplied in facts is authoritative; do not override it.",
    "Explain the interaction of load, gas generation, residual load, wind, solar, gas share, load forecast and weather.",
    "Distinguish observed data from inference. If signals conflict, explicitly call the setup mixed rather than forcing a direction.",
    "Do not give buy/sell advice and do not forecast a natural-gas price.",
    "Write plain Telegram text, compact but institutional in tone.",
    "Structure exactly: headline; 5 to 7 bullets; one line beginning 'Power-sector gas demand:'; one line beginning 'Key risk:'; one line beginning 'Data quality:'."
  ].join(" ");
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(facts) }],
      temperature: 0.2,
      top_p: 0.9,
      reasoning_effort: "low",
      max_tokens: 1800,
      stream: false
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`NVIDIA ${response.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data?.choices?.[0]?.message?.content?.trim() || "No model response.";
}

function deterministicAppendix(f) {
  const c = f.current;
  const ch = f.change;
  const y = f.yoy;
  const w = f.weather;
  const fund = f.fundamental;
  const line = [
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 DESK FACTS",
    `Load       ${fmtMWh(c.load)}  ${arrow(ch.load24)} ${signed(ch.load24)}  YoY ${signed(y.load)}`,
    `Gas burn   ${fmtMWh(c.gas)}  ${arrow(ch.gas24)} ${signed(ch.gas24)}  YoY ${signed(y.gas)}`,
    `Residual   ${fmtMWh(c.residual)}  ${arrow(ch.residual24)} ${signed(ch.residual24)}  YoY ${signed(y.residual)}`,
    `Wind       ${fmtMWh(c.wind)}  ${arrow(ch.wind24)} ${signed(ch.wind24)}  YoY ${signed(y.wind)}`,
    `Solar      ${fmtMWh(c.solar)}  ${arrow(ch.solar24)} ${signed(ch.solar24)}  YoY ${signed(y.solar)}`,
    `Gas share  ${fmtNum(c.gasShare)}%   Renewables ${fmtNum(c.renewableShare)}%  Δrenew ${signedPP(ch.renewableDeltaPP)}`,
    `Load f/cst 1h ${fmtMWh(f.forecast.next1h)}  surprise ${signed(f.forecast.surprisePct)}`,
    `Fundamental ${fund.state} / ${fund.confidence} confidence`,
    `Weather    HDD ${fmtNum(w.current?.hdd)} CDD ${fmtNum(w.current?.cdd)} | 3D TDD ${fmtNum(w.avg3?.tdd)} | 7D TDD ${fmtNum(w.avg7?.tdd)}`,
    `Weather→   Next 1D TDD ${fmtNum(w.forecast.d1?.tdd)} | 3D ${fmtNum(w.forecast.d3?.tdd)} | 7D ${fmtNum(w.forecast.d7?.tdd)}`,
    `Data       ${Math.round(f.completeness * 100)}% complete | ${f.anchorET} | ${f.anchorIST}`,
    `Source     ${f.source}`
  ];
  return line.join("\n");
}

export default async () => {
  const eiaKey = Netlify.env.get("EIA_API_KEY");
  const nvidiaKey = Netlify.env.get("NVIDIA_API_KEY");
  const telegramToken = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const telegramGroup = Netlify.env.get("TELEGRAM_GROUP_ID");
  if (!eiaKey || !nvidiaKey || !telegramToken || !telegramGroup) throw new Error("Missing required environment variable");

  const facts = await buildFacts();
  const analysis = await callNemotron(facts, nvidiaKey);
  const text = [
    "🇺🇸 U.S. POWER + NATURAL GAS — DAILY DESK NOTE",
    "",
    analysis,
    deterministicAppendix(facts)
  ].join("\n");

  const telegramResponse = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: telegramGroup, text, disable_web_page_preview: true })
  });
  if (!telegramResponse.ok) throw new Error(`Telegram ${telegramResponse.status}`);

  return new Response(JSON.stringify({ ok: true, model: MODEL, anchor_time: facts.anchorAt, fundamental: facts.fundamental, sent: true }, null, 2), {
    headers: { "content-type": "application/json" }
  });
};

export const config = { schedule: "0 11 * * *" };
