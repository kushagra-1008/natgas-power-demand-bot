const EIA_BASE = "https://api.eia.gov/v2";
const CPC_BASE = "https://ftp.cpc.ncep.noaa.gov/htdocs/degree_days/weighted";

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "natgas-power-demand-bot" } });
  if (!r.ok) throw new Error(`Weather ${r.status}`);
  return r.text();
}

function parseCpc(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.find(x => x.startsWith("Region|"));
  const conus = lines.find(x => x.startsWith("CONUS|"));
  if (!head || !conus) return [];
  const dates = head.split("|").slice(1);
  const vals = conus.split("|").slice(1);
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const v = Number(vals[i]);
    if (/^\d{8}$/.test(dates[i]) && Number.isFinite(v) && v >= 0) {
      out.push({ date: `${dates[i].slice(0, 4)}-${dates[i].slice(4, 6)}-${dates[i].slice(6)}`, value: v });
    }
  }
  return out;
}

async function weatherActual() {
  const y = new Date().getUTCFullYear();
  const [ct, ht] = await Promise.all([
    getText(`${CPC_BASE}/daily_data/${y}/Population.Cooling.txt`),
    getText(`${CPC_BASE}/daily_data/${y}/Population.Heating.txt`)
  ]);
  const c = parseCpc(ct);
  const h = new Map(parseCpc(ht).map(x => [x.date, x.value]));
  return c.map(x => ({ date: x.date, cdd: x.value, hdd: h.get(x.date) }))
    .filter(x => x.hdd != null).slice(-30);
}

async function weatherForecast() {
  const [ct, ht] = await Promise.all([
    getText(`${CPC_BASE}/daily_forecasts_7day/latest/Population.Cooling.txt`),
    getText(`${CPC_BASE}/daily_forecasts_7day/latest/Population.Heating.txt`)
  ]);
  const c = parseCpc(ct);
  const h = new Map(parseCpc(ht).map(x => [x.date, x.value]));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return c.map(x => ({ date: x.date, cdd: x.value, hdd: h.get(x.date) }))
    .filter(x => x.hdd != null && x.date > today).slice(0, 7);
}

function avgPrev(a, i, key, n) {
  const v = a.slice(Math.max(0, i - n), i).map(x => Number(x[key])).filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function fmt(v) { return v == null ? "N/A" : v.toFixed(1); }
function sum(a, key) { return a.length ? a.reduce((s, x) => s + (Number(x[key]) || 0), 0) : null; }

function weatherBlock(w) {
  const a = w?.actual || [];
  if (!a.length) return "";
  const i = a.length - 1;
  const cur = a[i], prior = a[i - 1];
  const c3 = avgPrev(a, i, "cdd", 3), h3 = avgPrev(a, i, "hdd", 3);
  const c7 = avgPrev(a, i, "cdd", 7), h7 = avgPrev(a, i, "hdd", 7);
  const tdd = x => x == null ? null : (Number(x.cdd) || 0) + (Number(x.hdd) || 0);
  const f = w.forecast || [];
  const f1 = f.slice(0, 1), f3 = f.slice(0, 3), f7 = f.slice(0, 7);
  const fh1 = sum(f1, "hdd"), fh3 = sum(f3, "hdd"), fh7 = sum(f7, "hdd");
  const fc1 = sum(f1, "cdd"), fc3 = sum(f3, "cdd"), fc7 = sum(f7, "cdd");
  const row = (n, c, p, a3, a7) => `${n.padEnd(5)} ${fmt(c).padStart(7)} ${fmt(p).padStart(7)} ${fmt(a3).padStart(7)} ${fmt(a7).padStart(7)}`;
  const fr = (n, d1, d3, d7) => `${n.padEnd(5)} ${fmt(d1).padStart(7)} ${fmt(d3).padStart(7)} ${fmt(d7).padStart(7)}`;
  return [
    "", "🌡️ WEATHER → POWER", `Data: ${cur.date}`, "",
    "ACTUAL DEGREE DAYS (°F-days)",
    "       Current   Prior    3D Avg   7D Avg",
    row("HDD", cur.hdd, prior?.hdd, h3, h7),
    row("CDD", cur.cdd, prior?.cdd, c3, c7),
    row("TDD", tdd(cur), tdd(prior), h3 != null && c3 != null ? h3 + c3 : null, h7 != null && c7 != null ? h7 + c7 : null), "",
    "FORECAST DEGREE DAYS (°F-days)",
    "       Next 1D  Next 3D  Next 7D",
    fr("HDD", fh1, fh3, fh7),
    fr("CDD", fc1, fc3, fc7),
    fr("TDD", fh1 != null && fc1 != null ? fh1 + fc1 : null, fh3 != null && fc3 != null ? fh3 + fc3 : null, fh7 != null && fc7 != null ? fh7 + fc7 : null),
    f.length ? `Through: ${f.at(-1).date}` : "Through: N/A",
    "Source: NOAA/CPC NDFD 7-day forecast"
  ].join("\n");
}

async function maybeWeather(state) {
  state.weather ??= { actual: [], forecast: [], version: "cpc-v3" };
  if (state.weather.version !== "cpc-v3") {
    state.weather = { actual: [], forecast: [], version: "cpc-v3" };
  }
  const last = Date.parse(state.weather.updatedAt || "");
  if (Number.isFinite(last) && Date.now() - last < 12 * 3600000 && state.weather.telegramBlock) {
    process.env.__NATGAS_WEATHER_BLOCK = state.weather.telegramBlock;
    return;
  }
  try { state.weather.actual = await weatherActual(); } catch (e) { state.weather.actualError = String(e.message); }
  try { state.weather.forecast = await weatherForecast(); } catch (e) { state.weather.forecastError = String(e.message); state.weather.forecast = []; }
  state.weather.updatedAt = new Date().toISOString();
  state.weather.telegramBlock = weatherBlock(state.weather);
  process.env.__NATGAS_WEATHER_BLOCK = state.weather.telegramBlock || "";
}

export async function fetchEIA(path, params = {}, state) {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("Missing EIA_API_KEY environment variable");
  await maybeWeather(state);
  const month = new Date().toISOString().slice(0, 7);
  state.usage ??= {};
  state.usage[month] ??= 0;
  const limit = Number(process.env.EIA_MONTHLY_REQUEST_LIMIT || 1250);
  if (state.usage[month] >= limit) throw new Error(`EIA monthly budget ${limit} reached`);
  const url = new URL(`${EIA_BASE}${path}`);
  url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const response = await fetch(url, { headers: { accept: "application/json" } });
  state.usage[month]++;
  if (!response.ok) throw new Error(`EIA ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response.json();
}

export function dataRows(payload) { return payload?.response?.data || []; }
export function latest(rows, predicate) {
  const candidates = rows.filter(predicate).map(r => ({ value: Number(r.value), at: String(r.period || "") }))
    .filter(x => Number.isFinite(x.value) && x.at).sort((a, b) => a.at.localeCompare(b.at));
  return candidates.at(-1) || null;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  try {
    const url = String(args[0]?.url || args[0] || ""), init = args[1] || {};
    if (url.includes("api.telegram.org") && process.env.TELEGRAM_BOT_TOKEN && typeof init.body === "string") {
      const body = JSON.parse(init.body), block = process.env.__NATGAS_WEATHER_BLOCK || "";
      if (body.text && block && !body.text.includes("🌡️ WEATHER → POWER")) {
        args[1] = { ...init, body: JSON.stringify({ ...body, text: body.text + block }) };
      }
    }
  } catch {}
  return originalFetch(...args);
};
