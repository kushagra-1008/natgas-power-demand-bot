from datetime import datetime, timezone

from app.schedule import due_signals


def test_daytime_hourly_signals():
    # 12:00 UTC = 08:00 New York during daylight saving time.
    due = due_signals(datetime(2026, 7, 1, 12, tzinfo=timezone.utc))
    assert {"gas_generation", "total_load", "solar_generation"}.issubset(due)


def test_overnight_three_hour_cadence():
    # 03:00 UTC = 23:00 New York during daylight saving time.
    due = due_signals(datetime(2026, 7, 2, 3, tzinfo=timezone.utc))
    assert {"gas_generation", "total_load"}.issubset(due)

    due_next = due_signals(datetime(2026, 7, 2, 4, tzinfo=timezone.utc))
    assert "gas_generation" not in due_next


def test_six_hour_signals():
    due = due_signals(datetime(2026, 7, 2, 6, tzinfo=timezone.utc))
    assert {"wind_generation", "generation_outages", "load_forecast"}.issubset(due)
