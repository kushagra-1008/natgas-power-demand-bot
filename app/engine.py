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
    baseline_pct: float | None = None
    available: bool = False


def _rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for key in ("data", "rows", "results"):
            if isinstance(payload.get(key), list):
                return [r for r in payload[key] if isinstance(r, dict)]
    return []


def _extract(ds: SignalDataset, payload: Any) -> tuple[float, str] | None:
    rows = _rows(payload)
    if not rows:
        return None
    row = rows[-1]
    value = row.get(ds.value_column)
    if value is None:
        return None
    try:
        return float(value), str(row.get(ds.time_column) or datetime.now(timezone.utc).isoformat())
    except (TypeError, ValueError):
        return None


def collect(client: GridStatus, storage: Storage, datasets: dict[str, SignalDataset | None]) -> list[Metric]:
    out = []
    for signal in SIGNALS:
        ds = datasets.get(signal)
        metric = Metric(signal)
        if not ds:
            out.append(metric)
            continue
        payload = client.latest(ds.dataset_id, limit=5)
        extracted = _extract(ds, payload)
        if not extracted:
            out.append(metric)
            continue
        value, observed_at = extracted
        storage.record_observation(signal, observed_at, value, ds.metadata.get("units"), payload)
        metric.value = value
        metric.unit = str(ds.metadata.get("units") or "")
        metric.available = True
        baseline = storage.historical(signal, observed_at, 24)
        if baseline and baseline["value"]:
            metric.vs_24h_pct = (value / baseline["value"] - 1) * 100
        out.append(metric)
    return out


def pressure(metrics: list[Metric]) -> tuple[str, str, str]:
    m = {x.signal: x for x in metrics}
    scores = []
    if m["gas_generation"].vs_24h_pct is not None:
        scores.append(m["gas_generation"].vs_24h_pct * 1.0)
    if m["total_load"].vs_24h_pct is not None:
        scores.append(m["total_load"].vs_24h_pct * 0.7)
    if m["wind_generation"].vs_24h_pct is not None:
        scores.append(-m["wind_generation"].vs_24h_pct * 0.35)
    if m["solar_generation"].vs_24h_pct is not None:
        scores.append(-m["solar_generation"].vs_24h_pct * 0.35)
    if not scores:
        return "⚪ UNKNOWN", "→ INSUFFICIENT DATA", "No validated U.S.-aggregate observations are available."
    score = sum(scores) / len(scores)
    if score >= 2:
        return "🟢 HIGH", "↑ MORE GAS BURN", "Higher load and/or weaker renewable supply is increasing gas-burn pressure."
    if score <= -2:
        return "🔴 LOW", "↓ LESS GAS BURN", "Lower load and/or stronger renewable supply is reducing gas-burn pressure."
    return "🟡 MODERATE", "→ MIXED", "Power-sector inputs are mixed; gas-demand pressure is not decisive."


def format_report(metrics: list[Metric]) -> str:
    names = {
        "gas_generation": "🔥 Gas Generation",
        "total_load": "⚡ Total Load",
        "wind_generation": "🌬️ Wind",
        "solar_generation": "☀️ Solar",
        "generation_outages": "🚨 Generation Outage",
        "load_forecast": "🔮 Load Forecast",
    }
    lines = ["🔥 U.S. POWER → NATGAS", ""]
    for m in metrics:
        value = "N/A" if not m.available else (f"{m.vs_24h_pct:+.1f}% vs 24h" if m.vs_24h_pct is not None else f"{m.value:,.0f}")
        lines.append(f"{names[m.signal]:<22} {value}")
    state, direction, reason = pressure(metrics)
    lines += ["", f"Demand Pressure: {state}", f"Direction:        {direction}", "", "Reason:", reason]
    return "\n".join(lines)
