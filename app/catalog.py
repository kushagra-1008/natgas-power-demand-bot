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


SIGNALS = ("gas_generation", "total_load", "wind_generation", "solar_generation", "generation_outages", "load_forecast")


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
    text = _text(metadata)
    iso_terms = ("ercot", "caiso", "pjm", "miso", "spp", "nyiso", "isone", "ieso", "iso ne", "iso new england")
    if any(term in text for term in iso_terms):
        return False
    national_terms = ("united states", "u s aggregate", "us aggregate", "national", "nationwide", "usa aggregate")
    return any(term in text for term in national_terms)


def _choose_value_column(signal: str, columns: list[str]) -> str | None:
    lowered = [(c, c.lower()) for c in columns]
    exact = {
        "gas_generation": ("natural_gas", "natural gas", "gas generation", "gas"),
        "total_load": ("total load", "load"),
        "wind_generation": ("wind generation", "wind"),
        "solar_generation": ("solar generation", "solar"),
        "generation_outages": ("outage", "outages"),
        "load_forecast": ("load forecast", "forecast"),
    }[signal]
    for col, low in lowered:
        if any(term in low for term in exact) and "time" not in low and "location" not in low:
            return col
    return None


def _make(signal: str, item: dict[str, Any], metadata: dict[str, Any]) -> SignalDataset | None:
    columns = metadata.get("all_columns") or metadata.get("columns") or []
    names = [c.get("name") if isinstance(c, dict) else str(c) for c in columns]
    time_col = metadata.get("time_index_column") or next((n for n in names if "time" in n.lower() and "utc" in n.lower()), None)
    value_col = _choose_value_column(signal, names)
    if not time_col or not value_col:
        return None
    return SignalDataset(signal, str(item.get("id") or item.get("dataset_id")), metadata, value_col, time_col)


def discover(catalog: dict[str, Any] | list[Any], metadata_getter, overrides: dict[str, str | None] | None = None) -> dict[str, SignalDataset | None]:
    """Discover only genuine U.S.-aggregate datasets; never sum ISOs."""
    result: dict[str, SignalDataset | None] = {s: None for s in SIGNALS}
    items = _items(catalog)
    by_id = {str(x.get("id") or x.get("dataset_id")): x for x in items if x.get("id") or x.get("dataset_id")}

    # Explicit IDs are still validated against metadata and aggregation scope.
    for signal, dataset_id in (overrides or {}).items():
        if not dataset_id:
            continue
        item = by_id.get(dataset_id, {"id": dataset_id})
        metadata = metadata_getter(dataset_id)
        if is_us_aggregate(metadata):
            result[signal] = _make(signal, item, metadata)

    # Automatic discovery only examines catalog entries whose catalog metadata
    # itself explicitly indicates U.S./national scope, minimizing API calls.
    for item in items:
        dataset_id = str(item.get("id") or item.get("dataset_id") or "")
        if not dataset_id or any(x and x.dataset_id == dataset_id for x in result.values()):
            continue
        if not is_us_aggregate(item):
            continue
        blob = _text(item)
        for signal in SIGNALS:
            if result[signal] is not None:
                continue
            if signal == "gas_generation" and not ("gas" in blob and "generation" in blob):
                continue
            if signal == "total_load" and not ("load" in blob or "demand" in blob):
                continue
            if signal == "wind_generation" and not ("wind" in blob and "generation" in blob):
                continue
            if signal == "solar_generation" and not ("solar" in blob and "generation" in blob):
                continue
            if signal == "generation_outages" and not ("outage" in blob and "generation" in blob):
                continue
            if signal == "load_forecast" and not ("load" in blob and "forecast" in blob):
                continue
            metadata = metadata_getter(dataset_id)
            if is_us_aggregate(metadata):
                result[signal] = _make(signal, item, metadata)
    return result
