import { getStore } from "@netlify/blobs";

const BASE="https://api.gridstatus.io/v1";
const SIGNALS=["gas_generation","total_load","wind_generation","solar_generation","generation_outages","load_forecast"];
const OV={gas_generation:"GRIDSTATUS_GAS_DATASET",total_load:"GRIDSTATUS_LOAD_DATASET",wind_generation:"GRIDSTATUS_WIND_DATASET",solar_generation:"GRIDSTATUS_SOLAR_DATASET",generation_outages:"GRIDSTATUS_OUTAGE_DATASET",load_forecast:"GRIDSTATUS_LOAD_FORECAST_DATASET"};
const KEY_NAMES=[1,2,3,4,5,6].map(n=>`GRIDSTATUS_API_KEY_${n}`);
const store=()=>getStore("natgas-power-demand");
async function state(){return (await store().get("state",{type:"json"}))||{observations:[],usage:{},catalog:null,catalogAt:0,apiKeyIndex:0};}
async function save(s){await store().setJSON("state",s);}
function text(x){return String(x??"").toLowerCase().replace(/[^a-z0-9 ]+/g," ");}
function aggregate(m){const t=text(m);if(["ercot","caiso","pjm","miso","spp","nyiso","isone","ieso"].some(x=>t.includes(x)))return false;return ["united states","u s aggregate","us aggregate","national","nationwide","usa aggregate"].some(x=>t.includes(x));}
function items(c){return Array.isArray(c)?c:(c?.data||c?.items||c?.datasets||[]);}
function gridKeys(){return KEY_NAMES.map(n=>process.env[n]).filter(Boolean);}
async function gs(path,params,s){
  const keys=gridKeys();
  if(!keys.length)throw new Error("Missing GRIDSTATUS_API_KEY_1..6 environment variables");
  const month=new Date().toISOString().slice(0,7);s.usage[month]??=0;
  const lim=Number(process.env.GRIDSTATUS_MONTHLY_REQUEST_LIMIT||1250);
  if(s.usage[month]>=lim)throw new Error(`GridStatus monthly budget ${lim} reached`);
  const u=new URL(`${BASE}${path}`);for(const[k,v]of Object.entries(params||{}))u.searchParams.set(k,v);
  const attempts=Math.min(keys.length,2);
  let lastStatus=0,lastBody="";
  for(let attempt=0;attempt<attempts;attempt++){
    const index=(Number(s.apiKeyIndex)||0)%keys.length;
    const r=await fetch(u,{headers:{"x-api-key":keys[index],accept:"application/json"}});
    s.usage[month]++;
    s.apiKeyIndex=(index+1)%keys.length;
    await save(s);
    if(r.ok)return r.json();
    lastStatus=r.status;lastBody=(await r.text()).slice(0,300);
    if(r.status!==401&&r.status!==403&&r.status!==429)break;
  }
  throw new Error(`GridStatus ${lastStatus}: ${lastBody}`);
}
function columns(m){return (m.all_columns||m.columns||[]).map(x=>typeof x==="object"?x.name:String(x));}
function valueColumn(signal,cols){const c={gas_generation:["natural gas","natural_gas","gas generation","gas"],total_load:["total load","load"],wind_generation:["wind generation","wind"],solar_generation:["solar generation","solar"],generation_outages:["outage","outages"],load_forecast:["load forecast","forecast"]}[signal];return cols.find(x=>c.some(y=>x.toLowerCase().includes(y))&&!/time|location/i.test(x));}
async function discover(s){const now=Date.now();if(s.catalog&&now-s.catalogAt<86400000)return s.catalog;const c=await gs("/datasets",{},s);const map=Object.fromEntries(SIGNALS.map(x=>[x,null]));
  for(const signal of SIGNALS){const id=process.env[OV[signal]];if(!id)continue;const m=await gs(`/datasets/${id}`,{},s);if(!aggregate(m))continue;const cols=columns(m),time=m.time_index_column||cols.find(x=>/time.*utc/i.test(x)),value=valueColumn(signal,cols);if(time&&value)map[signal]={id:String(id),time,value,units:m.units||""};}
  for(const item of items(c)){const id=item.id||item.dataset_id;if(!id||!aggregate(item))continue;const b=text(item);const hits={gas_generation:b.includes("gas")&&b.includes("generation"),total_load:b.includes("load")||b.includes("demand"),wind_generation:b.includes("wind")&&b.includes("generation"),solar_generation:b.includes("solar")&&b.includes("generation"),generation_outages:b.includes("outage")&&b.includes("generation"),load_forecast:b.includes("load")&&b.includes("forecast")};for(const signal of SIGNALS)if(!map[signal]&&hits[signal]){const m=await gs(`/datasets/${id}`,{},s);if(!aggregate(m))continue;const cols=columns(m),time=m.time_index_column||cols.find(x=>/time.*utc/i.test(x)),value=valueColumn(signal,cols);if(time&&value)map[signal]={id:String(id),time,value,units:m.units||""};}}
  s.catalog=map;s.catalogAt=now;await save(s);return map;}
function due(now=new Date()){const h=Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",hour12:false}).format(now));const d=new Set();if((h>=6&&h<18)||h%3===0)["gas_generation","total_load"].forEach(x=>d.add(x));if([8,12,16].includes(h))d.add("solar_generation");if(now.getUTCHours()%6===0)["wind_generation","generation_outages","load_forecast"].forEach(x=>d.add(x));return d;}
function latest(rows,col,time){if(!rows.length)return null;const r=[...rows].sort((a,b)=>String(a[time]||"").localeCompare(String(b[time]||""))).at(-1);const v=Number(r[col]);return Number.isFinite(v)?{value:v,at:String(r[time])}:null;}
function hist(s,signal,at,hours=24){const target=new Date(at).getTime()-hours*3600000;const candidates=s.observations.filter(x=>x.signal===signal&&new Date(x.at).getTime()<=target);if(!candidates.length)return null;return candidates.reduce((a,b)=>Math.abs(new Date(a.at).getTime()-target)<Math.abs(new Date(b.at).getTime()-target)?a:b);}
function report(s,datasets){const names={gas_generation:"🔥 Gas Generation",total_load:"⚡ Total Load",wind_generation:"🌬️ Wind",solar_generation:"☀️ Solar",generation_outages:"🚨 Generation Outage",load_forecast:"🔮 Load Forecast"};const m={};for(const x of SIGNALS){const a=s.observations.filter(o=>o.signal===x).at(-1);const b=a?hist(s,x,a.at):null;m[x]=a?{...a,pct:b&&b.value?(a.value/b.value-1)*100:null,delta:b?a.value-b.value:null}:null;}const c=[];if(m.gas_generation?.pct!=null)c.push(m.gas_generation.pct);if(m.total_load?.pct!=null)c.push(m.total_load.pct*.7);if(m.wind_generation?.pct!=null)c.push(-m.wind_generation.pct*.35);if(m.solar_generation?.pct!=null)c.push(-m.solar_generation.pct*.35);const score=c.length?c.reduce((a,b)=>a+b,0)/c.length:null;const verdict=score==null?["⚪ UNKNOWN","→ INSUFFICIENT DATA","No validated U.S.-aggregate observations are available."]:score>=2?["🟢 HIGH","↑ MORE GAS BURN","Higher load and/or weaker renewable supply is increasing gas-burn pressure."]:score<=-2?["🔴 LOW","↓ LESS GAS BURN","Lower load and/or stronger renewable supply is reducing gas-burn pressure."]:["🟡 MODERATE","→ MIXED","Power-sector inputs are mixed; gas-demand pressure is not decisive."];const lines=["🔥 U.S. POWER → NATGAS",""];for(const x of SIGNALS){let v="N/A";if(m[x])v=x==="generation_outages"&&m[x].delta!=null?`${m[x].delta>=0?'+':''}${m[x].delta.toFixed(1)} MW vs 24h`:m[x].pct!=null?`${m[x].pct>=0?'+':''}${m[x].pct.toFixed(1)}% vs 24h`:`${m[x].value.toFixed(0)} ${m[x].unit||""}`;lines.push(`${names[x].padEnd(22)} ${v}`);}const missing=SIGNALS.filter(x=>!datasets[x]);lines.push("",`Demand Pressure: ${verdict[0]}`,`Direction:        ${verdict[1]}`,"","Reason:",verdict[2]);if(missing.length)lines.push("",`Unavailable: ${missing.join(", ")}`);return lines.join("\n");}
async function telegram(t){const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:process.env.TELEGRAM_GROUP_ID,text:t})});if(!r.ok)throw new Error(`Telegram ${r.status}`);}
export default async()=>{if(!gridKeys().length||!process.env.TELEGRAM_BOT_TOKEN||!process.env.TELEGRAM_GROUP_ID)throw new Error("Missing required environment variables");const s=await state(),datasets=await discover(s),d=due(),payloads=new Map();for(const signal of d){const ds=datasets[signal];if(ds&&!payloads.has(ds.id)){const end=new Date(),start=new Date(end.getTime()-3*3600000);payloads.set(ds.id,await gs(`/datasets/${ds.id}/query`,{start_time:start.toISOString(),end_time:end.toISOString(),limit:100},s));}}for(const signal of d){const ds=datasets[signal];if(!ds)continue;const p=payloads.get(ds.id),rows=Array.isArray(p)?p:(p?.data||p?.rows||p?.results||[]),a=latest(rows,ds.value,ds.time);if(a)s.observations.push({signal,value:a.value,at:a.at,unit:ds.units});}s.observations=s.observations.slice(-10000);await save(s);if(d.size)await telegram(report(s,datasets));return new Response(JSON.stringify({ok:true,due:[...d],missing:SIGNALS.filter(x=>!datasets[x]),usage:s.usage,activeGridStatusKeys:gridKeys().length}),{headers:{"content-type":"application/json"}});};
export const config={schedule:"@hourly"};
