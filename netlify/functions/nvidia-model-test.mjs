import { getStore } from "@netlify/blobs";

const MODELS = [
  "nvidia/nemotron-3-super-120b-a12b",
  "deepseek-ai/deepseek-v4-pro",
  "moonshotai/kimi-k3",
  "z-ai/glm5.2"
];

const store = () => getStore("natgas-power-demand");

function parseAt(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}$/.test(s)) return Date.parse(`${s}:00:00Z`);
  return Date.parse(s);
}

function latest(observations, signal) {
  return observations
    .filter(o => o.signal === signal && Number.isFinite(Number(o.value)) && Number.isFinite(parseAt(o.at)))
    .sort((a, b) => parseAt(b.at) - parseAt(a.at))[0] || null;
}

function fmt(v) {
  return v == null ? "N/A" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function pct(a, b) {
  return b != null && b !== 0 ? (a / b - 1) * 100 : null;
}

function buildFacts(state) {
  const o = state.observations || [];
  const get = signal => latest(o, signal);
  const load = get("total_load")?.value ?? null;
  const gas = get("gas_generation")?.value ?? null;
  const wind = get("wind_generation")?.value ?? null;
  const solar = get("solar_generation")?.value ?? null;
  const total = get("total_generation")?.value ?? null;
  const at = get("total_load")?.at || get("gas_generation")?.at || null;
  const residual = load != null && wind != null && solar != null ? load - wind - solar : null;
  const gasShare = gas != null && total > 0 ? gas / total * 100 : null;
  const renewableShare = wind != null && solar != null && total > 0 ? (wind + solar) / total * 100 : null;
  const weather = state.weather?.telegramBlock || "No weather block available.";

  return {
    anchor_time: at,
    latest: {
      total_load_mwh: load,
      gas_generation_mwh: gas,
      wind_generation_mwh: wind,
      solar_generation_mwh: solar,
      total_generation_mwh: total,
      residual_load_mwh: residual,
      gas_share_pct: gasShare,
      renewable_share_pct: renewableShare
    },
    weather_block: weather,
    note: "These are observed EIA/NOAA-derived facts. Do not invent missing values. Explain implications for U.S. power-sector natural-gas demand only; do not give buy/sell recommendations."
  };
}

async function callModel(model, facts, apiKey) {
  const started = Date.now();
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a U.S. power-market and natural-gas demand analyst. Analyze only the supplied facts. Do not invent data, causes, or market prices. Distinguish electricity load from actual gas generation and account for renewable generation. Return a concise Telegram-ready daily intelligence note with: headline, 3-5 key observations, and a final power-sector gas-demand assessment. No buy/sell advice."
        },
        {
          role: "user",
          content: JSON.stringify(facts)
        }
      ],
      temperature: 0.2,
      max_tokens: 700,
      stream: false,
      reasoning_effort: "medium"
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body).slice(0, 800)}`);
  return {
    model,
    ms: Date.now() - started,
    text: body?.choices?.[0]?.message?.content || ""
  };
}

export default async () => {
  const apiKey = Netlify.env.get("NVIDIA_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ ok: false, error: "Missing NVIDIA_API_KEY" }), { status: 500, headers: { "content-type": "application/json" } });

  const state = (await store().get("state", { type: "json" })) || { observations: [], weather: {} };
  const facts = buildFacts(state);

  const results = await Promise.all(MODELS.map(async model => {
    try { return await callModel(model, facts, apiKey); }
    catch (error) { return { model, error: String(error.message || error) }; }
  }));

  return new Response(JSON.stringify({ ok: true, facts, results }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
};
