from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from urllib import robotparser
from urllib.parse import urlsplit

import requests

_repo = os.environ.get("GITHUB_REPOSITORY", "")
USER_AGENT = (f"PoznanieDashboard/1.0 (+https://github.com/{_repo}; personal feed reader)"
              if _repo else "PoznanieDashboard/1.0 (personal feed reader)")
TIMEOUT = (8, 15)
MAX_BYTES = 8 * 1024 * 1024
RETRIES = 2                       # повторов после сбоя сети или ответа 5xx
BACKOFF = (2.0, 5.0)              # паузы перед повторами, секунд
RETRY_STATUS = {500, 502, 503, 504}
MAX_RETRY_AFTER = 20              # 429: подождём, только если сайт просит паузу не длиннее этой


def _retry_after(value: str | None) -> float | None:
    try:
        return max(0.0, float(value)) if value else None
    except ValueError:
        return None                # дата вместо секунд — не ждём, попробуем в следующий прогон


@dataclass
class Response:
    status: int
    url: str
    content: bytes = b""
    headers: dict = field(default_factory=dict)

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")


class FetchError(Exception):
    pass


class Fetcher:
    """HTTP-клиент: вежливый User-Agent, лимит размера, кэш robots.txt."""

    def __init__(self, session: requests.Session | None = None):
        self.session = session or requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "ru,en;q=0.8",
        })
        self._robots: dict[str, robotparser.RobotFileParser | None] = {}
        self._lock = threading.Lock()

    def _request(self, url: str, headers: dict | None = None, stream: bool = False):
        """GET с повторами: сбой сети и 5xx — ещё до RETRIES раз с паузой,
        429 — ждём Retry-After, если сайт просит короткую паузу."""
        for attempt in range(RETRIES + 1):
            last = attempt == RETRIES
            try:
                r = self.session.get(url, headers=headers or {}, timeout=TIMEOUT, stream=stream)
            except requests.RequestException as e:
                if last:
                    raise FetchError(f"сеть: {type(e).__name__}") from e
                time.sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
                continue
            if r.status_code in RETRY_STATUS and not last:
                time.sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
                continue
            if r.status_code == 429 and not last:
                wait = _retry_after(r.headers.get("Retry-After"))
                if wait is not None and wait <= MAX_RETRY_AFTER:
                    time.sleep(wait)
                    continue
            return r
        raise AssertionError("unreachable")

    def get(self, url: str, etag: str | None = None, last_modified: str | None = None) -> Response:
        headers = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        r = self._request(url, headers, stream=True)
        if r.status_code == 304:
            return Response(304, r.url, b"", dict(r.headers))
        if r.status_code >= 400:
            raise FetchError(f"HTTP {r.status_code}")
        chunks, size = [], 0
        for chunk in r.iter_content(65536):
            size += len(chunk)
            if size > MAX_BYTES:
                raise FetchError("ответ больше 8 МБ")
            chunks.append(chunk)
        return Response(r.status_code, r.url, b"".join(chunks), dict(r.headers))

    def _robots_for(self, base: str) -> robotparser.RobotFileParser | None:
        with self._lock:
            if base in self._robots:
                return self._robots[base]
        rp = robotparser.RobotFileParser()
        try:
            r = self._request(base + "/robots.txt")
            if r.status_code >= 500 or r.status_code == 429:
                rp = None                      # сервер недоступен -> в этот раз не заходим
            elif r.status_code >= 400:
                rp.parse([])                   # robots.txt нет -> можно
            else:
                rp.parse(r.text.splitlines())
        except FetchError:
            rp = None
        with self._lock:
            self._robots[base] = rp
        return rp

    def allowed(self, url: str) -> bool:
        """Разрешает ли robots.txt. Если сам robots.txt не скачался — это временный сбой, а не запрет."""
        p = urlsplit(url)
        rp = self._robots_for(f"{p.scheme}://{p.netloc}")
        if rp is None:
            raise FetchError("сеть: robots.txt не загрузился")
        return rp.can_fetch(USER_AGENT, url)

    def sitemaps_from_robots(self, url: str) -> list[str]:
        p = urlsplit(url)
        rp = self._robots_for(f"{p.scheme}://{p.netloc}")
        return list(rp.site_maps() or []) if rp else []
