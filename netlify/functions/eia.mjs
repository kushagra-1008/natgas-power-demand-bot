const EIA_BASE = "https://api.eia.gov/v2";
const CPC = "https://ftp.cpc.ncep.noaa.gov/htdocs/degree_days/weighted/daily_data";
const GFS_DODS = "https://nomads.ncep.noaa.gov/dods/gfs_0p5";
const WEATHER_VERSION = "gfs-v2";

async function getText(url){
  const r=await fetch(url,{headers:{"User-Agent":"natgas-power-demand-bot"}});
  if(!r.ok)throw Error(`Weather ${r.status}`);
  return r.text();
}
function parseCpc(text){
  const lines=text.trim().split(/\r?\n/),head=lines.find(x=>x.startsWith("Region|")),conus=lines.find(x=>x.startsWith("CONUS|"));
  if(!head||!conus)return[];
  const dates=head.split("|").slice(1),vals=conus.split("|").slice(1),out=[];
  for(let i=0;i<dates.length;i++){const v=Number(vals[i]);if(/^\d{8}$/.test(dates[i])&&Number.isFinite(v)&&v>=0)out.push({date:`${dates[i].slice(0,4)}-${dates[i].slice(4,6)}-${dates[i].slice(6)}`,value:v})}
  return out;
}
async function weatherActual(){
  const y=new Date().getUTCFullYear(),[ct,ht]=await Promise.all([getText(`${CPC}/${y}/Population.Cooling.txt`),getText(`${CPC}/${y}/Population.Heating.txt`)]);
  const c=parseCpc(ct),h=new Map(parseCpc(ht).map(x=>[x.date,x.value]));
  return c.map(x=>({date:x.date,cdd:x.value,hdd:h.get(x.date)})).filter(x=>x.hdd!=null).slice(-30);
}
function latestCycle(now=new Date()){
  const d=new Date(now.getTime()-3*3600000),hour=d.getUTCHours();
  return {date:`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`,hour:String(Math.floor(hour/6)*6).padStart(2,"0")};
}
function parseGfsAscii(text){
  const lines=text.split(/\r?\n/),timeLine=lines.findIndex(x=>/^time,/.test(x)),latLine=lines.findIndex(x=>/^lat,/.test(x)),lonLine=lines.findIndex(x=>/^lon,/.test(x));
  if(timeLine<0||latLine<0||lonLine<0)throw Error("GFS metadata missing");
  const times=lines[timeLine+1].split(",").map(Number).filter(Number.isFinite),lats=lines[latLine+1].split(",").map(Number).filter(Number.isFinite),lons=lines[lonLine+1].split(",").map(Number).filter(Number.isFinite);
  const data=lines.slice(1,Math.min(timeLine,latLine,lonLine)).filter(Boolean);
  const values=[];for(const line of data){const p=line.split(",").slice(1).map(Number);if(p.length)values.push(p)}
  return {times,lats,lons,values};
}
function gfsDate(noaaDays){
  const d=new Date(Date.UTC(1,0,1));d.setUTCDate(d.getUTCDate()+Math.floor(noaaDays-1));const frac=noaaDays-Math.floor(noaaDays);d.setUTCHours(Math.floor(frac*24),Math.round((frac*24%1)*60),0,0);return d;
}
async function gfsForecast(){
  const c=latestCycle();
  const url=`${GFS_DODS}/gfs_0p5_${c.hour}z.ascii?tmp2m[0:28][49:140][130:249]`;
  const {times,lats,lons,values}=parseGfsAscii(await getText(url));
  const byDate=new Map();
  for(let t=0;t<Math.min(times.length,values.length);t++){
    const day=gfsDate(times[t]).toLocaleDateString("en-CA",{timeZone:"America/New_York"});let sum=0,wgt=0;
    for(let y=0;y<lats.length;y++)for(let x=0;x<lons.length;x++){
      const lat=lats[y],lon=lons[x]-360,v=Number(values[t]?.[y*lons.length+x]);
      if(!Number.isFinite(v)||lat<24.5||lat>49.5||lon<-124.75||lon>-66.9)continue;
      const w=Math.cos(lat*Math.PI/180);sum+=v*w;wgt+=w;
    }
    if(wgt){const tempK=sum/wgt;const tempF=(tempK-273.15)*9/5+32;if(!byDate.has(day))byDate.set(day,[]);byDate.get(day).push(tempF)}
  }
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  return [...byDate.keys()].sort().filter(d=>d>today).slice(0,7).map(date=>{const a=byDate.get(date),mean=a.reduce((s,v)=>s+v,0)/a.length;return {date,hdd:Math.max(65-mean,0),cdd:Math.max(mean-65,0),samples:a.length}});
}
function avgPrev(a,i,key,n){const v=a.slice(Math.max(0,i-n),i).map(x=>Number(x[key])).filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null}
function fmt(v){return v==null?"N/A":v.toFixed(1)}
function weatherBlock(w){
  const a=w?.actual||[];if(!a.length)return"";
  const i=a.length-1,cur=a[i],prior=a[i-1],c3=avgPrev(a,i,"cdd",3),h3=avgPrev(a,i,"hdd",3),c7=avgPrev(a,i,"cdd",7),h7=avgPrev(a,i,"hdd",7);
  const tdd=x=>x==null?null:(Number(x.cdd)||0)+(Number(x.hdd)||0),curT=tdd(cur),priorT=tdd(prior),t3=c3!=null&&h3!=null?c3+h3:null,t7=c7!=null&&h7!=null?c7+h7:null;
  const f=w.forecast||[],sum=(arr,k)=>arr.length?arr.reduce((s,x)=>s+(Number(x[k])||0),0):null;
  const f1=f.slice(0,1),f3=f.slice(0,3),f7=f.slice(0,7),fh1=sum(f1,"hdd"),fh3=sum(f3,"hdd"),fh7=sum(f7,"hdd"),fc1=sum(f1,"cdd"),fc3=sum(f3,"cdd"),fc7=sum(f7,"cdd");
  const row=(n,c,p,a3,a7)=>`${n.padEnd(5)} ${fmt(c).padStart(7)} ${fmt(p).padStart(7)} ${fmt(a3).padStart(7)} ${fmt(a7).padStart(7)}`;
  const fr=(n,d1,d3,d7)=>`${n.padEnd(5)} ${fmt(d1).padStart(7)} ${fmt(d3).padStart(7)} ${fmt(d7).padStart(7)}`;
  return ["","🌡️ WEATHER → POWER",`Data: ${cur.date}`,"","ACTUAL DEGREE DAYS (°F-days)","       Current   Prior    3D Avg   7D Avg",row("HDD",cur.hdd,prior?.hdd,h3,h7),row("CDD",cur.cdd,prior?.cdd,c3,c7),row("TDD",curT,priorT,t3,t7),"","FORECAST DEGREE DAYS — GFS (°F-days)","       Next 1D  Next 3D  Next 7D",fr("HDD",fh1,fh3,fh7),fr("CDD",fc1,fc3,fc7),fr("TDD",fh1+fc1,fh3+fc3,fh7+fc7),f.length?`Through: ${f.at(-1).date}`:"Through: N/A","Source: NOAA/NCEP GFS 0.50° 2m TMP; 6h samples"].join("\n");
}
async function maybeWeather(state){
  state.weather??={actual:[],forecast:[]};
  const last=Date.parse(state.weather.updatedAt||"");
  const currentVersion=state.weather.version||"";
  if(currentVersion===WEATHER_VERSION&&Number.isFinite(last)&&Date.now()-last<12*3600000){process.env.__NATGAS_WEATHER_BLOCK=state.weather.telegramBlock||"";return}
  try{state.weather.actual=await weatherActual()}catch(e){state.weather.error=String(e.message)}
  try{state.weather.forecast=await gfsForecast()}catch(e){state.weather.forecastError=String(e.message);state.weather.forecast=[]}
  state.weather.version=WEATHER_VERSION;state.weather.updatedAt=new Date().toISOString();state.weather.telegramBlock=weatherBlock(state.weather);process.env.__NATGAS_WEATHER_BLOCK=state.weather.telegramBlock||"";
}
export async function fetchEIA(path,params={},state){
  const key=process.env.EIA_API_KEY;if(!key)throw Error("Missing EIA_API_KEY environment variable");await maybeWeather(state);
  const month=new Date().toISOString().slice(0,7);state.usage??={};state.usage[month]??=0;const limit=Number(process.env.EIA_MONTHLY_REQUEST_LIMIT||1250);if(state.usage[month]>=limit)throw Error(`EIA monthly budget ${limit} reached`);
  const url=new URL(`${EIA_BASE}${path}`);url.searchParams.set("api_key",key);for(const [k,v] of Object.entries(params)){if(Array.isArray(v))for(const item of v)url.searchParams.append(k,item);else if(v!==undefined&&v!==null)url.searchParams.set(k,String(v))}
  const response=await fetch(url,{headers:{accept:"application/json"}});state.usage[month]++;if(!response.ok)throw Error(`EIA ${response.status}: ${(await response.text()).slice(0,400)}`);return response.json();
}
export function dataRows(payload){return payload?.response?.data||[]}
export function latest(rows,predicate){const candidates=rows.filter(predicate).map(r=>({value:Number(r.value),at:String(r.period||"")})).filter(x=>Number.isFinite(x.value)&&x.at).sort((a,b)=>a.at.localeCompare(b.at));return candidates.at(-1)||null}
const originalFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{try{const url=String(args[0]?.url||args[0]||""),init=args[1]||{};if(url.includes("api.telegram.org")&&process.env.TELEGRAM_BOT_TOKEN&&typeof init.body==="string"){const body=JSON.parse(init.body),block=process.env.__NATGAS_WEATHER_BLOCK||"";if(body.text&&block&&!body.text.includes("🌡️ WEATHER → POWER"))args[1]={...init,body:JSON.stringify({...body,text:body.text+block})}}}catch{}return originalFetch(...args)};
