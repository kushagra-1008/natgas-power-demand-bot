from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    gridstatus_api_key: str
    telegram_bot_token: str
    telegram_group_id: str
    monthly_request_limit: int = 1250
    database_path: str = "data/power_demand.db"
    cron_secret: str | None = None
    gas_dataset: str | None = None
    load_dataset: str | None = None
    wind_dataset: str | None = None
    solar_dataset: str | None = None
    outage_dataset: str | None = None
    load_forecast_dataset: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        required = ["GRIDSTATUS_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_GROUP_ID"]
        missing = [name for name in required if not os.getenv(name)]
        if missing:
            raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
        return cls(
            gridstatus_api_key=os.environ["GRIDSTATUS_API_KEY"],
            telegram_bot_token=os.environ["TELEGRAM_BOT_TOKEN"],
            telegram_group_id=os.environ["TELEGRAM_GROUP_ID"],
            monthly_request_limit=int(os.getenv("GRIDSTATUS_MONTHLY_REQUEST_LIMIT", "1250")),
            database_path=os.getenv("DATABASE_PATH", "data/power_demand.db"),
            cron_secret=os.getenv("CRON_SECRET") or None,
            gas_dataset=os.getenv("GRIDSTATUS_GAS_DATASET") or None,
            load_dataset=os.getenv("GRIDSTATUS_LOAD_DATASET") or None,
            wind_dataset=os.getenv("GRIDSTATUS_WIND_DATASET") or None,
            solar_dataset=os.getenv("GRIDSTATUS_SOLAR_DATASET") or None,
            outage_dataset=os.getenv("GRIDSTATUS_OUTAGE_DATASET") or None,
            load_forecast_dataset=os.getenv("GRIDSTATUS_LOAD_FORECAST_DATASET") or None,
        )

    def ensure_data_dir(self) -> None:
        Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
