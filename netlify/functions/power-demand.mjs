import { getStore } from "@netlify/blobs";

const BASE = "https://api.gridstatus.io/v1";
const SIGNALS = ["gas_generation", "total_load", "wind_generation", "solar_generation", "generation_outages", "load_forecast"];
const OVERRIDE_ENV = {
  gas_generation: "GRIDSTATUS_GAS_DATASET", total_load: "GRIDSTATUS_LOAD_DATASET",
  wind_generation: "GRIDSTATUS_WIND_DATASET", solar_generation: "GRIDSTATUS_SOLAR_DATASET",
  generation_outages: "GRIDSTATUS_OUTAGE_DATASET", load_forecast: "GRIDSTATUS_LOAD_FORECAST_DATASET"
};

const store = () => getStore("natgas-power-demand");

async function state() { return (await store().get("state", { type: "json" })) || { observations: [], usage: {}, catalog: null, catalogAt: 0 }; }
async function save(s) { await store().setJSON("state", s); }
function text(x) { return String(x ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " "); }
function aggregate(meta) {
  const t = text(meta);
  if (["ercot","caiso","pjm","miso","spp","nyiso","isone","ieso"].some(x => t.includes(x))) return false;
  return ["united states","u s aggregate","us aggregate","national","nationwide","usa aggregate"].some(x => t.includes(x));
}
function items(c) { return Array.isArray(c) ? c : (c?.data || c?.items || c?.datasets || []); }
async function gs(path, params, s) {
  const month = new Date().toISOString().slice(0, 7);
  s.usage[month] ||= 0;
  const limit = Number(process.env.GRIDSTATUS_MONTHLY_REQUEST_LIMIT || 1250);
  if (s.usage[month] >= limit) throw new Error(`GridStatus monthly budget ${limit} reached`);
  const u = new URL(`${BASE}${path}`); Object.entries(params || {}).forEach(([k,v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { "x-api-key": process.env.GRIDSTATUS_API_KEY, accept: "application/json" } });
  s.usage[month]++;
  if (!r.ok) throw new Error(`GridStatus ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.json();
}
async function discover(s) {
  const now = Date.now();
  if (s.catalog && now - s.catalogAt < 86400000) return s.catalog;
  const c = await gs("/datasets", {}, s);
  const map = Object.fromEntries(SIGNALS.map(x => [x, null]));
  for (const item of items(c)) {
    const id = item.id || item.dataset_id; if (!id || !aggregate(item)) continue;
    const b = text(item);
    const hits = {
      gas_generation: b.includes("gas") && b.includes("generation"), total_load: b.includes("load") || b.includes("demand"),
      wind_generation: b.includes("wind") && b.includes("generation"), solar_generation: b.includes("solar") && b.includes("generation"),
      generation_outages: b.includes("outage") && b.includes("generation"), load_forecast: b.includes("load") && b.includes("forecast")
    };
    for (const signal of SIGNALS) if (!map[signal] && hits[signal]) {
      const m = await gs(`/datasets/${id}`, {}, s);
      if (!aggregate(m)) continue;
      const cols = (m.all_columns || m.columns || []).map(x => typeof x === "object" ? x.name : String(x));
      const time = m.time_index_column || cols.find(x => /time.*utc/i.test(x));
      const choices = { gas_generation:["natural gas","natural_gas","gas generation","gas"], total_load:["total load","load"], wind_generation:["wind generation","wind"], solar_generation:["solar generation","solar"], generation_outages:["outage","outages"], load_forecast:["load forecast","forecast"] }[signal];
      const value = cols.find(x => choices.some(y => x.toLowerCase().includes(y)) && !/time|location/i.test(x));
      if (time && value) map[signal] = { id: String(id), time, value, units: m.units || "" };
    }
  }
  s.catalog = map; s.catalogAt = now; await save(s); return map;
}
function due(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", hour:"numeric", hour12:false }).format(now));
  const utc = now.getUTCHours(); const d = new Set();
  if (h >= 6 && h < 18 || h % 3 === 0) ["gas_generation","total_load"].forEach(x => d.add(x));
  if ([8,12,16].includes(h)) d.add("solar_generation");
  if (utc % 6 === 0) ["wind_generation","generation_outages","load_forecast"].forEach(x => d.add(x));
  return d;
}
function latest(rows, col, time) { if (!rows.length) return null; const r = [...rows].sort((a,b)=>String(a[time]||"").localeCompare(String(b[time]||""))).at(-1); return { value:Number(r[col]), at:String(r[time]) }; }
function hist(s, signal, at, hours=24) { const target = new Date(at).getTime()-hours*3600000; return s.observations.filter(x=>x.signal===signal).sort((a,b)=>Math.abs(new Date(a.at)-target)-Math.abs(new Date(b.at)-target))[0]; }
function report(s) {
  const names={gas_generation:"🔥 Gas Generation",total_load:"⚡ Total Load",wind_generation:"🌬️ Wind",solar_generation:"☀️ Solar",generation_outages:"🚨 Generation Outage",load_forecast:"🔮 Load Forecast"};
  const m={}; for(const x of SIGNALS){ const a=s.observations.filter(o=>o.signal===x).at(-1); m[x]=a ? {...a, pct:(hist(s,x,a.at)&&hist(s,x,a.at).value ? (a.value/hist(s,x,a.at).value-1)*100:null)} : null; }
  const components=[]; if(m.gas_generation?.pct!=null)components.push(m.gas_generation.pct); if(m.total_load?.pct!=null)components.push(m.total_load.pct*.7); if(m.wind_generation?.pct!=null)components.push(-m.wind_generation.pct*.35); if(m.solar_generation?.pct!=null)components.push(-m.solar_generation.pct*.35);
  const score=components.length?components.reduce((a,b)=>a+b,0)/components.length:null; const state=score==null?["⚪ UNKNOWN","→ INSUFFICIENT DATA","No validated U.S.-aggregate observations are available."]:score>=2?["🟢 HIGH","↑ MORE GAS BURN","Higher load and/or weaker renewable supply is increasing gas-burn pressure."]:score<=-2?["🔴 LOW","↓ LESS GAS BURN","Lower load and/or stronger renewable supply is reducing gas-burn pressure."]:["🟡 MODERATE","→ MIXED","Power-sector inputs are mixed; gas-demand pressure is not decisive."];
  const lines=["🔥 U.S. POWER → NATGAS",""]; for(const x of SIGNALS) lines.push(`${names[x].padEnd(22)} ${m[x]?.pct!=null ? `${m[x].pct>=0?'+':''}${m[x].pct.toFixed(1)}% vs 24h` : 'N/A'}`); lines.push("",`Demand Pressure: ${state[0]}`,`Direction:        ${state[1]}`,"","Reason:",state[2]); return lines.join("\n");
}
async function telegram(text) { const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:process.env.TELEGRAM_GROUP_ID,text})}); if(!r.ok) throw new Error(`Telegram ${r.status}`); }

export default async () => {
  const s=await state(); if(!process.env.GRIDSTATUS_API_KEY||!process.env.TELEGRAM_BOT_TOKEN||!process.env.TELEGRAM_GROUP_ID) throw new Error("Missing required environment variables");
  const datasets=await discover(s), d=due();
  const payloads=new Map();
  for(const signal of d){const ds=datasets[signal]; if(ds&&!payloads.has(ds.id)){const end=new Date(),start=new Date(end-3*3600000);payloads.set(ds.id,await gs(`/datasets/${ds.id}/query`,{start_time:start.toISOString(),end_time:end.toISOString(),limit:100},s));}}
  for(const signal of d){const ds=datasets[signal]; if(!ds)continue; const p=payloads.get(ds.id); const rows=Array.isArray(p)?p:(p?.data||p?.rows||p?.results||[]); const a=latest(rows,ds.value,ds.time); if(a&&!Number.isNaN(a.value))s.observations.push({signal,value:a.value,at:a.at,unit:ds.units});}
  s.observations=s.observations.slice(-10000); await save(s); if(d.size) await telegram(report(s)); return new Response(JSON.stringify({ok:true,due:[...d],missing:SIGNALS.filter(x=>!datasets[x]),usage:s.usage,report:report(s)}),{headers:{"content-type":"application/json"}});
};
export const config={schedule:"@hourly"};
