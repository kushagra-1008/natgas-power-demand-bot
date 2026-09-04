from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .catalog import SignalDataset
from .gridstatus import GridStatus
from .storage import Storage

SIGNALS = ("gas_generation", "total_load", "wind_generation", "solar_generation", "generation_outages", "load_forecast")

@dataclass
class Metric:
    signal: str
    value: float | None = None
    unit: str | None = None
    vs_24h_pct: float | None = None
    available: bool = False

def _rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list): return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for key in ("data", "rows", "results"):
            if isinstance(payload.get(key), list): return [r for r in payload[key] if isinstance(r, dict)]
    return []

def _extract(ds: SignalDataset, payload: Any) -> tuple[float, str] | None:
    rows = _rows(payload)
    if not rows: return None
    row = max(rows, key=lambda r: str(r.get(ds.time_column) or ""))
    value = row.get(ds.value_column)
    if value is None: return None
    try: return float(value), str(row.get(ds.time_column) or datetime.now(timezone.utc).isoformat())
    except (TypeError, ValueError): return None

def collect(client: GridStatus, storage: Storage, datasets: dict[str, SignalDataset | None], due: set[str] | None = None) -> list[Metric]:
    due = due or set(SIGNALS)
    payloads: dict[str, Any] = {}
    for signal in due:
        ds = datasets.get(signal)
        if ds and ds.dataset_id not in payloads:
            payloads[ds.dataset_id] = client.latest(ds.dataset_id, hours=3, limit=100)
    out: list[Metric] = []
    for signal in SIGNALS:
        ds = datasets.get(signal)
        metric = Metric(signal)
        if not ds or signal not in due:
            latest = storage.latest(signal)
            if latest:
                metric.value, metric.unit, metric.available = float(latest["value"]), latest["unit"], True
                baseline = storage.historical(signal, latest["observed_at"], 24)
                if baseline and baseline["value"]: metric.vs_24h_pct = (metric.value / baseline["value"] - 1) * 100
            out.append(metric); continue
        extracted = _extract(ds, payloads.get(ds.dataset_id))
        if not extracted: out.append(metric); continue
        value, observed_at = extracted
        storage.record_observation(signal, observed_at, value, str(ds.metadata.get("units") or ""), payloads[ds.dataset_id])
        metric.value, metric.unit, metric.available = value, str(ds.metadata.get("units") or ""), True
        baseline = storage.historical(signal, observed_at, 24)
        if baseline and baseline["value"]: metric.vs_24h_pct = (value / baseline["value"] - 1) * 100
        out.append(metric)
    return out

def pressure(metrics: list[Metric]) -> tuple[str, str, str]:
    m = {x.signal: x for x in metrics}; components = []
    if m["gas_generation"].vs_24h_pct is not None: components.append(m["gas_generation"].vs_24h_pct)
    if m["total_load"].vs_24h_pct is not None: components.append(m["total_load"].vs_24h_pct * .7)
    if m["wind_generation"].vs_24h_pct is not None: components.append(-m["wind_generation"].vs_24h_pct * .35)
    if m["solar_generation"].vs_24h_pct is not None: components.append(-m["solar_generation"].vs_24h_pct * .35)
    if not components: return "⚪ UNKNOWN", "→ INSUFFICIENT DATA", "No validated U.S.-aggregate observations are available."
    score = sum(components) / len(components)
    if score >= 2: return "🟢 HIGH", "↑ MORE GAS BURN", "Higher load and/or weaker renewable supply is increasing gas-burn pressure."
    if score <= -2: return "🔴 LOW", "↓ LESS GAS BURN", "Lower load and/or stronger renewable supply is reducing gas-burn pressure."
    return "🟡 MODERATE", "→ MIXED", "Power-sector inputs are mixed; gas-demand pressure is not decisive."

def format_report(metrics: list[Metric]) -> str:
    names = {"gas_generation":"🔥 Gas Generation", "total_load":"⚡ Total Load", "wind_generation":"🌬️ Wind", "solar_generation":"☀️ Solar", "generation_outages":"🚨 Generation Outage", "load_forecast":"🔮 Load Forecast"}
    lines = ["🔥 U.S. POWER → NATGAS", ""]
    for m in metrics:
        value = "N/A" if not m.available else (f"{m.vs_24h_pct:+.1f}% vs 24h" if m.vs_24h_pct is not None else f"{m.value:,.0f}")
        lines.append(f"{names[m.signal]:<22} {value}")
    state, direction, reason = pressure(metrics)
    lines += ["", f"Demand Pressure: {state}", f"Direction:        {direction}", "", "Reason:", reason]
    return "\n".join(lines)
