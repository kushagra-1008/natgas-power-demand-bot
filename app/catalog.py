from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SignalDataset:
    signal: str
    dataset_id: str
    metadata: dict[str, Any]
    value_column: str
    time_column: str


SIGNAL_TERMS = {
    "gas_generation": ("gas", "natural gas", "generation", "fuel mix"),
    "total_load": ("load", "demand"),
    "wind_generation": ("wind", "generation", "fuel mix"),
    "solar_generation": ("solar", "generation", "fuel mix"),
    "generation_outages": ("outage", "generation"),
    "load_forecast": ("load", "forecast"),
}


def _text(obj: Any) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", str(obj).lower())


def _items(catalog: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    if isinstance(catalog, list):
        return [x for x in catalog if isinstance(x, dict)]
    for key in ("data", "items", "datasets"):
        if isinstance(catalog.get(key), list):
            return [x for x in catalog[key] if isinstance(x, dict)]
    return []


def is_us_aggregate(metadata: dict[str, Any]) -> bool:
    """Conservative validation: reject explicit ISO/market-level datasets.

    A dataset is considered eligible only when metadata contains an explicit
    national/U.S. indication and does not identify an ISO market. We never
    infer national aggregation by summing ISO datasets.
    """
    text = _text(metadata)
    iso_terms = ("ercot", "caiso", "pjm", "miso", "spp", "nyiso", "isone", "ieso", "iso ne", "iso new england")
    if any(term in text for term in iso_terms):
        return False
    national_terms = ("united states", "u s aggregate", "us aggregate", "national", "nationwide", "usa aggregate")
    return any(term in text for term in national_terms)


def discover(catalog: dict[str, Any] | list[Any], metadata_getter) -> dict[str, SignalDataset | None]:
    result: dict[str, SignalDataset | None] = {s: None for s in SIGNAL_TERMS}
    candidates = _items(catalog)
    for item in candidates:
        dataset_id = item.get("id") or item.get("dataset_id")
        if not dataset_id:
            continue
        blob = _text(item)
        possible = [s for s, terms in SIGNAL_TERMS.items() if all(t in blob for t in terms)]
        if not possible:
            continue
        metadata = metadata_getter(dataset_id)
        if not is_us_aggregate(metadata):
            continue
        columns = metadata.get("all_columns") or metadata.get("columns") or []
        names = [c.get("name") if isinstance(c, dict) else str(c) for c in columns]
        time_col = metadata.get("time_index_column") or next((n for n in names if "time" in n and "utc" in n), None)
        for signal in possible:
            value_col = _choose_value_column(signal, names)
            if value_col and time_col and result[signal] is None:
                result[signal] = SignalDataset(signal, dataset_id, metadata, value_col, time_col)
    return result


def _choose_value_column(signal: str, columns: list[str]) -> str | None:
    lowered = [(c, c.lower()) for c in columns]
    preferred = {
        "gas_generation": ("natural_gas", "natural gas", "gas", "generation"),
        "total_load": ("load", "demand"),
        "wind_generation": ("wind",),
        "solar_generation": ("solar",),
        "generation_outages": ("outage", "mw"),
        "load_forecast": ("forecast", "load", "mw"),
    }[signal]
    for col, low in lowered:
        if all(term in low for term in preferred):
            return col
    for col, low in lowered:
        if any(term in low for term in preferred) and "time" not in low and "location" not in low:
            return col
    return None
