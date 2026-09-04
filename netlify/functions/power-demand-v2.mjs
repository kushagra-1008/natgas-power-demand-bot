import { getStore } from "@netlify/blobs";
import { fetchEIA, dataRows, latest } from "./eia.mjs";
const SIGNALS=["gas_generation","total_load","wind_generation","solar_generation","generation_outages","load_forecast"];
const store=()=>getStore("natgas-power-demand");
async function state(){return (await store().get("state",{type:"json}))||{observations:[],usage:{},lastRun:null};}
