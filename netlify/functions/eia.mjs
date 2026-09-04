const EIA_BASE = "https://api.eia.gov/v2";
const CPC = "https://ftp.cpc.ncep.noaa.gov/htdocs/degree_days/weighted/daily_data";
const NWS = "https://api.weather.gov";
const WEATHER_POINTS = [
  [44.086,-70.661,15431.98], [41.845,-76.476,42610.074], [42.653,-86.836,47693.655],
  [42.765,-97.063,22069.011], [33.795,-80.966,70198.706], [34.517,-87.168,20069.188],
  [32.468,-97.330,43566.089], [40.199,-110.228,26346.149], [19.828,-155.495,53800.005]
];

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "natgas-power-demand-bot" } });
  if (!r.ok) throw new Error(`Weather ${r.status}`);
  return r.text();
}
function parseCpc(text) {
  const lines = text.trim().split(/\r?\n/), head = lines.find(x => x.startsWith("Region|")), conus = lines.find(x => x.startsWith("CONUS|"));
  if (!head || !conus) return [];
  const dates = head.split("|").slice(1), vals = conus.split("|").slice(1), out = [];
  for (let i=0;i<dates.length;i++) { const v=Number(vals[i]); if (/^\d{8}$/.test(dates[i]) && Number.isFinite(v) && v>=0) out.push({date:`${dates[i].slice(0,4)}-${dates[i].slice(4,6)}-${dates[i].slice(6)}`,value:v}); }
  return out;
}
async function weatherActual() {
  const y = new Date().getUTCFullYear();
  const [ct, ht] = await Promise.all([getText(`${CPC}/${y}/Population.Cooling.txt`), getText(`${CPC}/${y}/Population.Heating.txt`)]);
  const c = parseCpc(ct), h = new Map(parseCpc(ht).map(x=>[x.date,x.value]));
  return c.map(x=>({date:x.date,cdd:x.value,hdd:h.get(x.date)})).filter(x=>x.hdd!=null).slice(-30);
}
async function nwsForecast() {
  const rs = await Promise.all(WEATHER_POINTS.map(async p => {
    try {
      const a=await fetch(`${NWS}/points/${p[0]},${p[1]}`,{headers:{"User-Agent":"natgas-power-demand-bot"}}); if(!a.ok) throw 0;
      const meta=await a.json(), b=await fetch(meta.properties.forecast,{headers:{"User-Agent":"natgas-power-demand-bot"}}); if(!b.ok) throw 0;
      return {w:p[2],periods:(await b.json()).properties.periods||[]};
    } catch { return null; }
  }));
  const by=new Map();
  for(const r of rs.filter(Boolean)) {
    const d=new Map();
    for(const q of r.periods){const date=String(q.startTime||"").slice(0,10),v=Number(q.temperature);if(!date||!Number.isFinite(v))continue;if(!d.has(date))d.set(date,[]);d.get(date).push(v);}
    for(const [date,vs] of d){const mean=vs.reduce((a,b)=>a+b,0)/vs.length;if(!by.has(date))by.set(date,[]);by.get(date).push({hdd:Math.max(0,65-mean),cdd:Math.max(0,mean-65),w:r.w});}
  }
  return [...by].map(([date,v])=>{const w=v.reduce((a,b)=>a+b.w,0);return{date,hdd:v.reduce((a,b)=>a+b.hdd*b.w,0)/w,cdd:v.reduce((a,b)=>a+b.cdd*b.w,0)/w};}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,7);
}
function pct(a,b){return b!=null&&b!==0?(a/b-1)*100:null;}
function weatherBlock(w) {
  if(!w?.actual?.length) return "";
  const a=w.actual, i=a.length-1, cur=a[i], one=a[i-1], p3=a.slice(Math.max(0,i-3),i), p7=a.slice(Math.max(0,i-7),i);
  const avg=(arr,k)=>{const v=arr.map(x=>x[k]).filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null};
  const line=(k,label)=>`${label} ${cur[k].toFixed(1)} | 24h ${pct(cur[k],one?.[k])==null?"N/A":`${pct(cur[k],one[k]).toFixed(1)}%`} | 3D ${pct(cur[k],avg(p3,k))==null?"N/A":`${pct(cur[k],avg(p3,k)).toFixed(1)}%`} | 7D ${pct(cur[k],avg(p7,k))==null?"N/A":`${pct(cur[k],avg(p7,k)).toFixed(1)}%`}`;
  const f=w.forecast||[],fc=f.reduce((x,y)=>x+y.cdd,0),fh=f.reduce((x,y)=>x+y.hdd,0);
  return ["","🌡️ WEATHER → POWER",`Data              ${cur.date}`,line("cdd","CDD"),line("hdd","HDD"),`Next 7D CDD       ${f.length?fc.toFixed(1):"N/A"}`,`Next 7D HDD       ${f.length?fh.toFixed(1):"N/A"}`,f.length?`Forecast through  ${f.at(-1).date}`:"Forecast          N/A","Source: NOAA/CPC + NWS"].join("\n");
}
async function maybeWeather(state) {
  state.weather ??= { actual: [], forecast: [] };
  const last = Date.parse(state.weather.updatedAt || "");
  if (Number.isFinite(last) && Date.now()-last < 12*3600000) return;
  try { state.weather.actual = await weatherActual(); } catch(e) { state.weather.error=String(e.message); }
  try { state.weather.forecast = await nwsForecast(); } catch(e) { state.weather.forecastError=String(e.message); }
  state.weather.updatedAt = new Date().toISOString();
  state.weather.telegramBlock = weatherBlock(state.weather);
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
  const candidates = rows.filter(predicate).map(r => ({ value: Number(r.value), at: String(r.period || "") })).filter(x => Number.isFinite(x.value) && x.at).sort((a, b) => a.at.localeCompare(b.at));
  return candidates.at(-1) || null;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  try {
    const url = String(args[0]?.url || args[0] || "");
    if (url.includes("api.telegram.org") && process.env.TELEGRAM_BOT_TOKEN) {
      const init = args[1] || {};
      if (typeof init.body === "string") {
        const body = JSON.parse(init.body);
        if (body.text && !body.text.includes("🌡️ WEATHER → POWER")) {
          body.text += process.env.__NATGAS_WEATHER_BLOCK || "";
          const next = { ...init, body: JSON.stringify(body) };
          return originalFetch(args[0], next);
        }
      }
    }
  } catch {}
  return response;
};
