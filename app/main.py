from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

from .catalog import discover
from .config import Settings
from .engine import collect, format_report
from .gridstatus import GridStatus, QuotaExceeded
from .storage import Storage
from .telegram import Telegram


def run(send_telegram: bool = True) -> str:
    settings = Settings.from_env()
    settings.ensure_data_dir()
    storage = Storage(settings.database_path)
    client = GridStatus(settings.gridstatus_api_key, storage, settings.monthly_request_limit)
    try:
        catalog = client.catalog()
        datasets = discover(catalog, client.metadata)
        metrics = collect(client, storage, datasets)
        report = format_report(metrics)
        if send_telegram:
            Telegram(settings.telegram_bot_token, settings.telegram_group_id).send(report)
        return report
    finally:
        client.close()


def inspect_catalog() -> int:
    settings = Settings.from_env()
    settings.ensure_data_dir()
    storage = Storage(settings.database_path)
    client = GridStatus(settings.gridstatus_api_key, storage, settings.monthly_request_limit)
    try:
        catalog = client.catalog(max_age_hours=0)
        datasets = discover(catalog, client.metadata)
        print(json.dumps({k: (v.__dict__ if v else None) for k, v in datasets.items()}, indent=2, default=str))
        missing = [k for k, v in datasets.items() if v is None]
        print("\nMISSING/UNVERIFIED U.S.-AGGREGATE SIGNALS:")
        for signal in missing:
            print(f"- {signal}")
        return 0 if not missing else 2
    finally:
        client.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "inspect":
            raise SystemExit(inspect_catalog())
        print(run(send_telegram=True))
    except QuotaExceeded as exc:
        print(f"Quota guard: {exc}", file=sys.stderr)
        raise SystemExit(2)
