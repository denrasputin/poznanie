"""Проверки второй версии: устойчивость к 403, фильтры адресов, карты без дат, смена способа."""
import json
from datetime import datetime, timedelta, timezone

import yaml

from collector import config
from collector.fetch import Fetcher
from collector.methods import page
from collector.run import collect_all
from collector.store import Store
from collector.util import clean_title
from tests.fakes import FakeSession, fx

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)


def setup(tmp_path, sources):
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump({"sections": [{"id": "a", "name": "А", "udc": "1"}], "sources": sources},
                                allow_unicode=True), encoding="utf-8")
    return config.load(p)[1]


def state(tmp_path):
    return json.loads((tmp_path / "d" / "state.json").read_text())["sources"]


def posts(tmp_path):
    return [json.loads(l) for f in (tmp_path / "d" / "posts").glob("*.jsonl") for l in f.read_text().splitlines()]


def test_clean_title():
    assert clean_title("The Anger Trap: emotion science | BPS") == "The Anger Trap: emotion science"
    assert clean_title("Обновлено Нормальность числа π") == "Нормальность числа π"
    assert clean_title("Короткий | BPS") == "Короткий | BPS"


def test_one_of_two_feeds_forbidden(tmp_path):
    srcs = setup(tmp_path, [{"id": "two", "name": "Две ленты", "section": "А", "url": "https://two.example/",
                             "feeds": ["https://sub.example/feed", "https://two.example/feed/"]}])
    sess = FakeSession({"https://sub.example/feed": (403, b"no", {}),
                        "https://two.example/feed/": fx("feed.rss")})
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    h = state(tmp_path)["two"]["health"]
    assert h["status"] == "ok" and h["new"] == 2 and "HTTP 403" in h["message"]


def test_forbidden_is_blocked_not_error(tmp_path):
    srcs = setup(tmp_path, [{"id": "f", "name": "403", "section": "А", "url": "https://f.example/",
                             "feeds": ["https://f.example/feed"]}])
    sess = FakeSession({"https://f.example/feed": (403, b"no", {})})
    s = collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    assert state(tmp_path)["f"]["health"]["status"] == "blocked" and s["errors"] == 0


def test_sitemap_skips_service_pages(tmp_path, monkeypatch):
    monkeypatch.setattr("collector.methods.sitemap.now_utc", lambda: NOW)
    srcs = setup(tmp_path, [{"id": "mix", "name": "Смесь", "section": "А", "url": "https://mix.example/",
                             "mode": "auto"}])
    sess = FakeSession({"https://mix.example/robots.txt": b"Sitemap: https://mix.example/sm.xml\n",
                        "https://mix.example/": b"<html><body>nothing</body></html>",
                        "https://mix.example/sm.xml": fx("sitemap_mixed.xml")})
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    assert posts(tmp_path) == []          # заголовок не догрузился — запись отложена, а не «слаг вместо названия»
    sess.routes["https://mix.example/digest/nastoyaschaya-statya-o-pamyati"] = fx("article.html")
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW + timedelta(hours=1))
    got = posts(tmp_path)
    assert [p["url"] for p in got] == ["https://mix.example/digest/nastoyaschaya-statya-o-pamyati"]
    assert got[0]["title"].startswith("Как устроено первое")


def test_undated_sitemap_baseline_then_new(tmp_path):
    srcs = setup(tmp_path, [{"id": "nd", "name": "Без дат", "section": "А", "url": "https://nd.example/",
                             "mode": "auto", "match": "/article/."}])
    routes = {"https://nd.example/robots.txt": b"",
              "https://nd.example/": b"<html><body>js app</body></html>",
              "https://nd.example/sitemap.xml": fx("sitemap_nodate.xml"),
              "https://nd.example/article/svezhaya-statya": fx("article.html")}
    sess = FakeSession(routes)
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    first = posts(tmp_path)
    assert len(first) == 3 and all(p.get("baseline") for p in first)
    assert state(tmp_path)["nd"]["resolved"]["method"] == "sitemap"
    routes["https://nd.example/sitemap.xml"] = fx("sitemap_nodate.xml").replace(
        b"</urlset>", b"<url><loc>https://nd.example/article/svezhaya-statya</loc></url></urlset>")
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW + timedelta(hours=1))
    new = [p for p in posts(tmp_path) if not p.get("baseline")]
    assert len(new) == 1 and new[0]["title"].startswith("Как устроено первое")


def test_unique_by_title_harvest():
    items = page.harvest(fx("oldschool.html"), "https://old.example/", {"item": "i > a[href*='site-news']"},
                         unique="title")
    assert [i["title"] for i in items] == ["Книга на общие темы", "Лекции", "Ангуттара-никая"]
    assert len({i["key"] for i in items}) == 3


def test_config_change_triggers_reresolve_and_baseline(tmp_path):
    base = {"id": "pg", "name": "Страница", "section": "А", "url": "https://list.example/news/", "mode": "auto"}
    routes = {"https://list.example/robots.txt": b"", "https://list.example/news/": fx("listing.html"),
              "https://list.example/": b"<html><body>root</body></html>",
              "https://list.example/blog/": fx("listing.html").replace(b"pervaya", b"blogovaya")}
    sess = FakeSession(routes)
    collect_all(setup(tmp_path, [base]), Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW)
    srcs = setup(tmp_path, [{**base, "list_url": "https://list.example/blog/"}])
    collect_all(srcs, Store(tmp_path / "d"), Fetcher(sess), workers=1, now=NOW + timedelta(hours=1))
    st = state(tmp_path)["pg"]
    assert st["resolved"]["url"] == "https://list.example/blog/"
    fresh = [p for p in posts(tmp_path) if "blogovaya" in p["url"]]
    assert fresh and all(p.get("baseline") for p in fresh)   # смена способа — не поток «новых»
