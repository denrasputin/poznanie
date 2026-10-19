"""Сборка сайта: дубли, опасные ссылки, статусы с запасом на разовый сбой, разделение данных, посты справочников,
повторы одной новости, проверка."""
import json
from datetime import datetime, timedelta, timezone

import yaml

from collector.util import iso
from dashboard import archive, favicons
from dashboard.build import build, check

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)


SRC = {"id": "x", "name": "Икс", "section": "А", "url": "https://x.example/", "lang": "ru",
       "feeds": ["https://x.example/feed"]}


def make(tmp_path, posts, state=None, sources=(SRC,)):
    spath = tmp_path / "s.yaml"
    spath.write_text(yaml.safe_dump({
        "sections": [{"id": "a", "name": "А", "udc": "1"}],
        "sources": list(sources),
    }, allow_unicode=True), encoding="utf-8")
    data = tmp_path / "data"
    (data / "posts").mkdir(parents=True)
    (data / "posts" / "2026-10.jsonl").write_text(
        "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in posts), encoding="utf-8")
    (data / "state.json").write_text(json.dumps(state or {"sources": {}, "runs": []}), encoding="utf-8")
    return data, spath


def post(i, url, title, days_ago=0, via="rss"):
    d = iso(NOW - timedelta(days=days_ago))
    return {"id": f"id{i}", "source": "x", "url": url, "title": title, "summary": "", "published": d, "seen": d, "via": via}


def test_dedupe_unsafe_and_split(tmp_path):
    data, spath = make(tmp_path, [
        post(1, "https://t.me/x/5", "Одна и та же статья", via="telegram"),
        post(2, "https://x.example/a", "Одна и та же статья"),
        post(3, "javascript:alert(1)", "Вредная ссылка"),
        post(4, "https://x.example/old", "Статья трёхнедельной давности", days_ago=20),
    ])
    out = tmp_path / "public"
    build(data, out, spath, now=NOW)
    recent = json.loads((out / "data" / "posts.json").read_text())
    older = json.loads((out / "data" / "posts-older.json").read_text())
    assert [p["u"] for p in recent] == ["https://x.example/a"]      # дубль склеен, ссылка — на сайт
    assert [p["t"] for p in older] == ["Статья трёхнедельной давности"]
    assert json.loads((out / "data" / "meta.json").read_text())["has_older"] is True
    assert check(out, spath) == []


def test_single_failure_is_not_an_alarm(tmp_path):
    fail = {"health": {"status": "error", "message": "сайт не отвечает"}, "last_ok": iso(NOW - timedelta(hours=1)),
            "last_post": iso(NOW)}
    for streak, expected in ((1, "ok"), (3, "error")):
        state = {"sources": {"x": {**fail, "fail_streak": streak, "failing_since": iso(NOW)}}, "runs": []}
        (tmp_path / str(streak)).mkdir()
        data, spath = make(tmp_path / str(streak), [post(1, "https://x.example/a", "Статья")], state)
        out = tmp_path / str(streak) / "public"
        build(data, out, spath, now=NOW)
        src = json.loads((out / "data" / "sources.json").read_text())[0]
        assert src["status"] == expected
        assert bool(src["failing_since"]) == (expected == "error")


def test_check_catches_empty_site(tmp_path):
    data, spath = make(tmp_path, [])
    out = tmp_path / "public"
    build(data, out, spath, now=NOW)
    assert any("пустой" in p for p in check(out, spath))


def test_reference_source_posts_are_hidden(tmp_path):
    ref = {"id": "r", "name": "Эр", "section": "А", "url": "https://r.example/", "lang": "ru", "mode": "reference"}
    data, spath = make(tmp_path, [post(1, "https://x.example/a", "Статья"),
                                  {**post(2, "https://r.example/b", "Собрано до перевода в справочники"), "source": "r"}],
                       sources=(SRC, ref))
    out = tmp_path / "public"
    build(data, out, spath, now=NOW)
    assert [p["s"] for p in json.loads((out / "data" / "posts.json").read_text())] == ["x"]
    assert {s["id"]: s["status"] for s in json.loads((out / "data" / "sources.json").read_text())}["r"] == "reference"


def test_same_story_is_marked_and_related_file_written(tmp_path):
    y = {"id": "y", "name": "Игрек", "section": "А", "url": "https://y.example/", "lang": "ru", "feeds": ["https://y.example/feed"]}
    story = "ФАС признала рекламу Мегафона о 5G недостоверной"
    data, spath = make(tmp_path, [post(1, "https://x.example/a", story, days_ago=0.5),
                                  {**post(2, "https://y.example/b", story + ": оператор удивлён"), "source": "y"}],
                       sources=(SRC, y))
    out = tmp_path / "public"
    res = build(data, out, spath, now=NOW)
    posts = {p["i"]: p for p in json.loads((out / "data" / "posts.json").read_text())}
    assert posts["id2"]["dup"] == "id1" and "dup" not in posts["id1"] and res["duplicates"] == 1
    assert isinstance(json.loads((out / "data" / "related.json").read_text()), dict)


def test_favicon_helpers():
    assert favicons.sniff(b"\x89PNG\r\n") == "png" and favicons.sniff(b"<html>") is None
    html = (b'<link rel="icon" href="/f.ico"><link rel="apple-touch-icon" sizes="180x180" href="/a.png">'
            b'<link rel="mask-icon" href="/m.svg">')
    urls = favicons.candidates(html, "https://s.example/page")
    assert urls[0] == "https://s.example/a.png" and "https://s.example/m.svg" not in urls


def test_archive_page_escapes_text():
    page = archive.page({"url": "https://x.example/?a=1&b=2", "title": "<script>x</script>", "summary": "",
                         "source": "Икс", "section": "А", "date": "2026-10-17T12:00:00Z"})
    assert "<script>" not in page and "&lt;script&gt;" in page and "a=1&amp;b=2" in page
