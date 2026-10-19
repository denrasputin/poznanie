"""Надёжность сборщика: повторы, 429, недоступный robots.txt, старые номера, серия неудач."""
import json
from datetime import datetime, timedelta, timezone

import requests
import yaml

from collector import config
from collector.fetch import Fetcher
from collector.run import collect_all
from collector.store import Store
from tests.fakes import FakeResp, FakeSession, fx

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)


def setup(tmp_path, sources):
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump({"sections": [{"id": "a", "name": "А", "udc": "1"}], "sources": sources},
                                allow_unicode=True), encoding="utf-8")
    return config.load(p)[1]


def health(tmp_path, sid):
    return json.loads((tmp_path / "d" / "state.json").read_text())["sources"][sid]


class Flaky(FakeSession):
    """Первые n запросов к адресу падают, дальше — как обычно."""

    def __init__(self, routes, fail_times=1, error=None):
        super().__init__(routes)
        self.fail_times, self.error, self.count = fail_times, error, {}

    def get(self, url, headers=None, timeout=None, stream=False):
        n = self.count[url] = self.count.get(url, 0) + 1
        if n <= self.fail_times:
            self.calls.append((url, dict(headers or {})))
            if self.error == "503":
                return FakeResp(url, 503, b"busy")
            raise requests.ConnectionError("blip")
        return super().get(url, headers, timeout, stream)


FEED_SRC = [{"id": "f", "name": "Лента", "section": "А", "url": "https://f.example/",
             "feeds": ["https://f.example/feed"]}]


def test_network_blip_is_retried(tmp_path):
    sess = Flaky({"https://f.example/feed": fx("feed.rss")}, fail_times=1)
    collect_all(setup(tmp_path, FEED_SRC), Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    assert health(tmp_path, "f")["health"]["status"] == "ok"


def test_server_error_is_retried(tmp_path):
    sess = Flaky({"https://f.example/feed": fx("feed.rss")}, fail_times=2, error="503")
    collect_all(setup(tmp_path, FEED_SRC), Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    assert health(tmp_path, "f")["health"]["new"] == 2


def test_too_many_requests_is_temporary(tmp_path):
    sess = FakeSession({"https://f.example/feed": (429, b"slow down", {"Retry-After": "3600"})})
    s = collect_all(setup(tmp_path, FEED_SRC), Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    h = health(tmp_path, "f")["health"]
    assert h["status"] == "limited" and "429" in h["message"] and s["errors"] == 0


def test_short_retry_after_is_waited(tmp_path):
    class Once(FakeSession):
        hit = 0

        def get(self, url, headers=None, timeout=None, stream=False):
            self.hit += 1
            if self.hit == 1:
                return FakeResp(url, 429, b"", {"Retry-After": "2"})
            return super().get(url, headers, timeout, stream)

    sess = Once({"https://f.example/feed": fx("feed.rss")})
    collect_all(setup(tmp_path, FEED_SRC), Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    assert health(tmp_path, "f")["health"]["status"] == "ok"


def test_unreachable_robots_is_not_a_ban(tmp_path):
    srcs = setup(tmp_path, [{"id": "pg", "name": "Страница", "section": "А",
                             "url": "https://list.example/news/", "mode": "auto"}])
    sess = FakeSession({"https://list.example/robots.txt": (503, b"down", {}),
                        "https://list.example/news/": fx("listing.html")})
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    h = health(tmp_path, "pg")["health"]
    assert h["status"] == "error" and h["message"] == "сайт не отвечает"   # временный сбой, не «не пускает»


def test_fail_streak_counts_and_resets(tmp_path):
    srcs = setup(tmp_path, FEED_SRC)
    sess = FakeSession({"https://f.example/feed": fx("feed.rss")})
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    sess.routes["https://f.example/feed"] = (500, b"", {})
    for i in range(2):
        collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW + timedelta(hours=i + 1))
    st = health(tmp_path, "f")
    assert st["fail_streak"] == 2 and st["failing_since"]
    sess.routes["https://f.example/feed"] = fx("feed.rss")
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW + timedelta(hours=5))
    assert "fail_streak" not in health(tmp_path, "f")


def test_old_numbered_articles_are_not_new(tmp_path):
    def listing(nums):
        links = "".join(f'<a href="/materials/{n}">Материал номер {n} о русской литературе</a>' for n in nums)
        return f"<html><body><main>{links}</main></body></html>".encode()

    srcs = setup(tmp_path, [{"id": "pk", "name": "Полка", "section": "А", "url": "https://pk.example/",
                             "mode": "auto", "list_url": "https://pk.example/materials",
                             "match": r"/materials/\d+$"}])
    routes = {"https://pk.example/robots.txt": b"", "https://pk.example/materials": listing([10, 9, 8])}
    sess = FakeSession(routes)
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    routes["https://pk.example/materials"] = listing([11, 10, 9, 8, 3])   # 11 — новый, 3 — старый всплыл
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW + timedelta(hours=1))
    recs = [json.loads(l) for f in (tmp_path / "d" / "posts").glob("*.jsonl") for l in f.read_text().splitlines()]
    fresh = {r["url"].rsplit("/", 1)[1] for r in recs if not r.get("baseline")}
    assert fresh == {"11"}


def test_min_interval_skips_recent_runs(tmp_path):
    from collector.run import too_soon
    store = Store(tmp_path / "d")
    assert not too_soon(store, 150, NOW)                      # сборов ещё не было
    store.state["last_run"] = (NOW - timedelta(hours=1)).isoformat()
    assert too_soon(store, 150, NOW)                          # час назад — рано
    store.state["last_run"] = (NOW - timedelta(hours=3)).isoformat()
    assert not too_soon(store, 150, NOW)                      # три часа назад — пора
    assert not too_soon(store, 0, NOW)                        # без ограничения — всегда можно
