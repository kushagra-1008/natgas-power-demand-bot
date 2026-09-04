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
            return con.execute("SELECT * FROM observations WHERE signal=? ORDER BY observed_at DESC LIMIT 1", (signal,)).fetchone()

    def historical(self, signal: str, observed_at: str, hours: float, tolerance_hours: float = 1.5):
        target = datetime.fromisoformat(observed_at.replace("Z", "+00:00")).timestamp() - hours * 3600
        lo, hi = target - tolerance_hours * 3600, target + tolerance_hours * 3600
        with self._connect() as con:
            rows = con.execute("SELECT * FROM observations WHERE signal=?", (signal,)).fetchall()
        best = None
        best_distance = None
        for row in rows:
            ts = datetime.fromisoformat(row["observed_at"].replace("Z", "+00:00")).timestamp()
            distance = abs(ts - target)
            if lo <= ts <= hi and (best_distance is None or distance < best_distance):
                best, best_distance = row, distance
        return best

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
                "INSERT INTO catalog_cache(id, fetched_at, payload) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at, payload=excluded.payload",
                (datetime.now(timezone.utc).isoformat(), json.dumps(payload)),
            )

    def get_catalog_cache(self):
        with self._connect() as con:
            return con.execute("SELECT fetched_at, payload FROM catalog_cache WHERE id=1").fetchone()
