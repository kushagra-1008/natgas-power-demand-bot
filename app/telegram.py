from __future__ import annotations

import httpx


class Telegram:
    def __init__(self, token: str, chat_id: str):
        self.url = f"https://api.telegram.org/bot{token}/sendMessage"
        self.chat_id = chat_id

    def send(self, text: str) -> None:
        response = httpx.post(self.url, json={"chat_id": self.chat_id, "text": text}, timeout=20)
        response.raise_for_status()
