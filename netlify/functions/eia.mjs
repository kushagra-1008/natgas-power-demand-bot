const EIA_BASE = "https://api.eia.gov/v2";

export async function fetchEIA(path, params = {}, state) {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("Missing EIA_API_KEY environment variable");
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
