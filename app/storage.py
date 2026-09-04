from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class Storage:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._init()

    def _connect(self):
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        return con

    def _init(self):
        with self._connect() as con:
            con.executescript("""
            CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                signal TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                value REAL NOT NULL,
                unit TEXT,
                raw_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_obs_signal_time ON observations(signal, observed_at);
            CREATE TABLE IF NOT EXISTS api_usage (
                month TEXT PRIMARY KEY,
                requests INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS catalog_cache (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                fetched_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            """)

    def record_observation(self, signal: str, observed_at: str, value: float, unit: str | None, raw: Any = None):
        with self._connect() as con:
            con.execute(
                "INSERT INTO observations(signal, observed_at, value, unit, raw_json) VALUES(?,?,?,?,?)",
                (signal, observed_at, value, unit, json.dumps(raw) if raw is not None else None),
            )

    def latest(self, signal: str):
        with self._connect() as con:
            return con.execute(
                "SELECT * FROM observations WHERE signal=? ORDER BY observed_at DESC LIMIT 1", (signal,)
            ).fetchone()

    def closest_before(self, signal: str, observed_at: str, hours: float):
        with self._connect() as con:
            return con.execute(
                """SELECT * FROM observations WHERE signal=? AND observed_at <= datetime(?, ?) 
                   ORDER BY observed_at DESC LIMIT 1""",
                (signal, observed_at, f"+{hours} hours"),
            ).fetchone()

    def around(self, signal: str, observed_at: str, target_hours: float, tolerance_hours: float = 2.0):
        # SQLite's datetime modifiers make this comparison portable enough for our ISO UTC timestamps.
        with self._connect() as con:
            return con.execute(
                """SELECT * FROM observations
                   WHERE signal=?
                     AND observed_at BETWEEN datetime(?, ?) AND datetime(?, ?)
                   ORDER BY ABS((julianday(observed_at)-julianday(?)) * 24.0) LIMIT 1""",
                (signal, observed_at, f"-{target_hours + tolerance_hours} hours", observed_at,
                 f"-{max(0, target_hours - tolerance_hours)} hours", observed_at),
            ).fetchone()

    def usage(self) -> int:
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        with self._connect() as con:
            row = con.execute("SELECT requests FROM api_usage WHERE month=?", (month,)).fetchone()
            return int(row[0]) if row else 0

    def increment_usage(self):
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        with self._connect() as con:
            con.execute("INSERT INTO api_usage(month, requests) VALUES(?,1) ON CONFLICT(month) DO UPDATE SET requests=requests+1", (month,))

    def cache_catalog(self, payload: Any):
        with self._connect() as con:
            con.execute(
                "INSERT INTO catalog_cache(id, fetched_at, payload) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at, payload=excluded.payload",
                (datetime.now(timezone.utc).isoformat(), json.dumps(payload)),
            )

    def get_catalog_cache(self):
        with self._connect() as con:
            row = con.execute("SELECT fetched_at, payload FROM catalog_cache WHERE id=1").fetchone()
            if not row:
                return None
            return row
