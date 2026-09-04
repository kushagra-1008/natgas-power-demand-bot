from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def due_signals(now: datetime | None = None) -> set[str]:
    """Return signals due for the current hourly scheduler tick.

    Daytime is 06:00-17:59 America/New_York. Gas/load are hourly in that
    window and every three hours overnight. Solar is sampled three times in
    daytime. Six-hour signals use UTC boundaries to make the cadence stable.
    """
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(ET)
    due: set[str] = set()
    daytime = 6 <= local.hour < 18
    if daytime or local.hour % 3 == 0:
        due.update({"gas_generation", "total_load"})
    if local.hour in (8, 12, 16):
        due.add("solar_generation")
    if now.hour % 6 == 0:
        due.update({"wind_generation", "generation_outages", "load_forecast"})
    return due
