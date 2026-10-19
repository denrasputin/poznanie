"""Сквозной прогон: сборщик (дважды) + сборка дашборда на подставной сети."""
import json
from datetime import datetime, timedelta, timezone

import yaml

from collector import config
from collector.fetch import Fetcher
from collector.run import collect_all
from collector.store import Store
from dashboard.build import build
from tests.fakes import FakeSession, fx

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)

SOURCES = {
    "sections": [{"id": "a", "name": "Раздел А", "udc": "1"}, {"id": "b", "name": "Раздел Б", "udc": "94"}],
    "sources": [
        {"id": "rss", "name": "RSS-сайт", "section": "Раздел А", "url": "https://rss.example/", "lang": "ru",
         "feeds": ["https://rss.example/feed"]},
        {"id": "disc", "name": "Сайт с автопоиском", "section": "Раздел А", "url": "https://d.example/", "lang": "en",
         "mode": "auto", "feed_hint": "https://d.example/broken.xml"},
        {"id": "sm", "name": "Сайт с картой", "section": "Раздел Б", "url": "https://sm.example/", "lang": "ru",
         "mode": "auto"},
        {"id": "pg", "name": "Сайт без ленты", "section": "Раздел Б", "url": "https://list.example/news/", "lang": "ru",
         "mode": "auto"},
        {"id": "ref", "name": "Справочник", "section": "Раздел Б", "url": "https://ref.example/", "lang": "ru",
         "mode": "reference"},
    ],
}


def routes():
    return {
        "https://rss.example/feed": (200, fx("feed.rss"), {"ETag": '"v1"'}),
        "https://d.example/robots.txt": b"User-agent: *\nAllow: /\n",
        "https://d.example/": fx("discover.html"),
        "https://d.example/feed/": fx("feed.atom"),
        "https://sm.example/robots.txt": b"User-agent: *\nDisallow: /private/\nSitemap: https://sm.example/sitemap_index.xml\n",
        "https://sm.example/": b"<html><body>no feed here</body></html>",
        "https://sm.example/sitemap_index.xml": fx("sitemap_index.xml"),
        "https://sm.example/sitemap-posts.xml": fx("sitemap_posts.xml"),
        "https://sm.example/articles/kak-ustroeno-pervoe": fx("article.html"),
        "https://list.example/robots.txt": b"",
        "https://list.example/news/": fx("listing.html"),
        "https://list.example/": b"<html><body>root</body></html>",
    }


def make(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(yaml.safe_dump(SOURCES, allow_unicode=True), encoding="utf-8")
    return p


def test_two_runs_and_dashboard(tmp_path, monkeypatch):
    monkeypatch.setattr("collector.methods.sitemap.now_utc", lambda: NOW)
    spath = make(tmp_path)
    _, sources = config.load(spath)
    data = tmp_path / "data"
    sess = FakeSession(routes())

    s1 = collect_all(sources, Store(data), Fetcher(sess), workers=3, now=NOW)
    st = json.loads((data / "state.json").read_text())["sources"]
    assert st["rss"]["health"]["method"] == "rss" and st["rss"]["health"]["new"] == 2
    assert st["disc"]["health"]["method"] == "rss"          # подсказка сломана -> нашёл <link rel>
    assert st["disc"]["resolved"]["url"] == "https://d.example/feed/"
    assert st["sm"]["health"]["method"] == "sitemap"
    assert st["pg"]["health"]["method"] == "page"
    assert st["ref"]["health"]["status"] == "reference"
    assert s1["errors"] == 0                                   # справочник — не ошибка
    first = [json.loads(l) for f in (data / "posts").glob("*.jsonl") for l in f.read_text().splitlines()]
    page_items = [r for r in first if r["source"] == "pg"]
    assert page_items and all(r.get("baseline") for r in page_items)   # первый прогон: не «новое»
    sm_item = next(r for r in first if r["source"] == "sm")
    assert sm_item["title"].startswith("Как устроено первое")

    # второй прогон: лента отвечает 304, на странице появилась новая заметка
    sess.routes["https://list.example/news/"] = fx("listing.html").replace(
        b"<main>", '<main><a href="/2026/10/novaya-zametka-poyavilas-segodnya">Новая заметка появилась сегодня утром</a>'.encode())
    later = NOW + timedelta(hours=1)
    s2 = collect_all(sources, Store(data), Fetcher(sess), workers=3, now=later)
    st = json.loads((data / "state.json").read_text())["sources"]
    assert st["rss"]["health"]["status"] == "not_modified"
    assert any(h.get("If-None-Match") == '"v1"' for u, h in sess.calls if u == "https://rss.example/feed")
    assert st["pg"]["health"]["new"] == 1 and s2["new"] == 1

    out = tmp_path / "public"
    res = build(data, out, spath, days=31, now=later)
    posts = json.loads((out / "data" / "posts.json").read_text())
    titles = [p["t"] for p in posts]
    assert "Новая заметка появилась сегодня утром" in titles
    assert "Первая тестовая заметка о книгах" not in titles            # baseline скрыт
    newest = next(p for p in posts if p["t"].startswith("Новая заметка"))
    assert newest.get("k") == 1                                          # дата = момент обнаружения
    srcs = {s["id"]: s for s in json.loads((out / "data" / "sources.json").read_text())}
    assert srcs["ref"]["status"] == "reference" and srcs["rss"]["status"] == "ok"
    assert (out / "index.html").exists() and (out / "app.js").exists()
    assert res["sources"] == 5


def test_robots_block(tmp_path):
    spath = tmp_path / "s.yaml"
    spath.write_text(yaml.safe_dump({
        "sections": [{"id": "a", "name": "А", "udc": "1"}],
        "sources": [{"id": "closed", "name": "Закрытый", "section": "А", "url": "https://closed.example/", "mode": "auto"}],
    }, allow_unicode=True), encoding="utf-8")
    _, sources = config.load(spath)
    sess = FakeSession({"https://closed.example/robots.txt": b"User-agent: *\nDisallow: /\n"})
    collect_all(sources, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    st = json.loads((tmp_path / "d" / "state.json").read_text())["sources"]["closed"]["health"]
    assert st["status"] in ("blocked", "error")


def test_dead_site_fails_fast(tmp_path):
    import requests

    class DeadSession(FakeSession):
        def get(self, url, headers=None, timeout=None, stream=False):
            self.calls.append((url, {}))
            if url.endswith("robots.txt"):
                return super().get(url)
            raise requests.ConnectionError("down")

    spath = tmp_path / "s.yaml"
    spath.write_text(yaml.safe_dump({
        "sections": [{"id": "a", "name": "А", "udc": "1"}],
        "sources": [{"id": "dead", "name": "Лежит", "section": "А", "url": "https://dead.example/", "mode": "auto"}],
    }, allow_unicode=True), encoding="utf-8")
    _, sources = config.load(spath)
    sess = DeadSession({"https://dead.example/robots.txt": b""})
    collect_all(sources, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    h = json.loads((tmp_path / "d" / "state.json").read_text())["sources"]["dead"]["health"]
    assert h["status"] == "error" and h["message"] == "сайт не отвечает"
    pages = [u for u, _ in sess.calls if not u.endswith("robots.txt")]
    assert len(pages) <= 3               # один адрес с повторами, а не десяток адресов лент
