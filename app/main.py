from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

from .catalog import SIGNALS, discover
from .config import Settings
from .engine import collect, format_report
from .gridstatus import GridStatus, QuotaExceeded
from .schedule import due_signals
from .storage import Storage
from .telegram import Telegram


def _overrides(settings: Settings) -> dict[str, str | None]:
    return {"gas_generation": settings.gas_dataset, "total_load": settings.load_dataset, "wind_generation": settings.wind_dataset, "solar_generation": settings.solar_dataset, "generation_outages": settings.outage_dataset, "load_forecast": settings.load_forecast_dataset}


def run(send_telegram: bool = True, force: bool = False) -> str:
    settings = Settings.from_env(); settings.ensure_data_dir()
    storage = Storage(settings.database_path)
    client = GridStatus(settings.gridstatus_api_key, storage, settings.monthly_request_limit)
    try:
        catalog = client.catalog()
        datasets = discover(catalog, client.metadata, _overrides(settings))
        due = set(SIGNALS) if force else due_signals()
        if not due:
            return format_report(collect(client, storage, datasets, set()))
        metrics = collect(client, storage, datasets, due)
        report = format_report(metrics)
        if send_telegram: Telegram(settings.telegram_bot_token, settings.telegram_group_id).send(report)
        return report
    finally:
        client.close()


def inspect_catalog() -> int:
    settings = Settings.from_env(); settings.ensure_data_dir()
    storage = Storage(settings.database_path)
    client = GridStatus(settings.gridstatus_api_key, storage, settings.monthly_request_limit)
    try:
        catalog = client.catalog(max_age_hours=0)
        datasets = discover(catalog, client.metadata, _overrides(settings))
        result = {k: (v.__dict__ if v else None) for k, v in datasets.items()}
        print(json.dumps(result, indent=2, default=str))
        missing = [k for k, v in datasets.items() if v is None]
        print("\nMISSING/UNVERIFIED U.S.-AGGREGATE SIGNALS:")
        for signal in missing: print(f"- {signal}")
        return 0 if not missing else 2
    finally:
        client.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "inspect": raise SystemExit(inspect_catalog())
        print(run(send_telegram=True, force="--force" in sys.argv))
    except QuotaExceeded as exc:
        print(f"Quota guard: {exc}", file=sys.stderr); raise SystemExit(2)
