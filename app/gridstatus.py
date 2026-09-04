from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .storage import Storage

BASE = "https://api.gridstatus.io/v1"


class QuotaExceeded(RuntimeError):
    pass


class GridStatus:
    def __init__(self, api_key: str, storage: Storage, monthly_limit: int):
        self.api_key = api_key
        self.storage = storage
        self.monthly_limit = monthly_limit
        self.client = httpx.Client(timeout=30, headers={"x-api-key": api_key, "accept": "application/json"})

    def _request(self, path: str, params: dict[str, Any] | None = None):
        if self.storage.usage() >= self.monthly_limit:
            raise QuotaExceeded(f"GridStatus monthly request budget ({self.monthly_limit}) reached")
        response = self.client.get(f"{BASE}{path}", params=params or {})
        self.storage.increment_usage()
        response.raise_for_status()
        return response.json()

    def catalog(self, max_age_hours: int = 24):
        cached = self.storage.get_catalog_cache()
        if cached:
            fetched = datetime.fromisoformat(cached[0])
            if (datetime.now(timezone.utc) - fetched).total_seconds() < max_age_hours * 3600:
                import json
                return json.loads(cached[1])
        payload = self._request("/datasets")
        self.storage.cache_catalog(payload)
        return payload

    def metadata(self, dataset_id: str):
        return self._request(f"/datasets/{dataset_id}")

    def latest(self, dataset_id: str, hours: int = 3, limit: int = 100):
        # Grid Status documents start_time/end_time/limit for dataset queries.
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=hours)
        return self._request(
            f"/datasets/{dataset_id}/query",
            {"start_time": start.isoformat(), "end_time": end.isoformat(), "limit": limit},
        )

    def close(self):
        self.client.close()
