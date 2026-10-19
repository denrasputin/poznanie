"""Собирает public/: страница дашборда + данные в JSON (+ поисковый индекс по архиву).

Запуск:  python -m dashboard [--data data] [--out public] [--days 31] [--no-search]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from collections import Counter
from datetime import timedelta
from pathlib import Path

from urllib.parse import urlsplit

from collector import config
from collector.filters import url_ok
from collector.store import iter_posts
from collector.util import clean_title, iso, now_utc, parse_date

from . import archive

STATIC = Path(__file__).resolve().parent / "static"
STALE_DAYS = 60
RECENT_DAYS = 14              # posts.json: свежие две недели, грузятся сразу; остальное — posts-older.json
FAIL_STREAK = 3               # «ошибку» показываем, только если сайт не ответил столько прогонов подряд
SAFE_URL = re.compile(r"^https?://", re.I)


def months_back(now, days: int) -> list[str]:
    months, d = set(), now - timedelta(days=days + 31)
    while d <= now:
        months.add(d.strftime("%Y-%m"))
        d += timedelta(days=27)
    months.add(now.strftime("%Y-%m"))
    return sorted(months)


def title_key(title: str) -> str:
    return re.sub(r"\W+", "", title.lower())[:80]


def is_junk(rec: dict, src) -> bool:
    if not SAFE_URL.match(rec["url"]):
        return True                   # только обычные ссылки: никаких javascript: и data:
    if rec.get("via") in ("sitemap", "page") and not src.unique and not url_ok(src, rec["url"]):
        return True                   # служебные страницы, попавшие до настройки фильтров
    title = rec["title"].strip()
    if not title or title == "(без заголовка)":
        return True
    if re.fullmatch(r"[0-9a-fA-F]{16,}", title.replace(" ", "")):
        return True                   # заголовок не догрузился — вместо него служебный id
    return False


def site_url() -> str:
    """Адрес сайта для превью ссылок (og:image должен быть полным адресом)."""
    if os.environ.get("SITE_URL"):
        return os.environ["SITE_URL"].rstrip("/") + "/"
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner.lower()}.github.io/{name}/"
    return ""


def source_status(s, st: dict, now) -> tuple[str, str]:
    h = st.get("health", {})
    status = "reference" if s.mode == "reference" else h.get("status", "pending")
    message = h.get("message", "")
    if status == "not_modified":
        status = "ok"
    if status == "robots" or (status == "error" and "HTTP 40" in message):
        status = "blocked"
    if (status in ("error", "blocked", "limited") and st.get("last_ok")
            and st.get("fail_streak", 0) < FAIL_STREAK):
        status, message = "ok", f"последняя попытка не удалась: {message}"   # разовый сбой — не тревога
    if status == "ok" and st.get("last_post"):
        lp = parse_date(st["last_post"])
        if lp and now - lp > timedelta(days=STALE_DAYS):
            status = "stale"
    return status, message


def build(data_dir: Path, out_dir: Path, sources_path: Path, days: int = 31, now=None,
          search: bool = False) -> dict:
    now = now or now_utc()
    sections, sources = config.load(sources_path)
    src_by_id = {s.id: s for s in sources}
    sec_by_name = {sec.name: sec for sec in sections}
    state = {}
    state_path = data_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    sstate = state.get("sources", {})

    border = now - timedelta(days=days)
    posts, totals, by_key, archive_recs = [], Counter(), {}, []
    for rec in iter_posts(data_dir):
        src = src_by_id.get(rec["source"])
        if not src or src.mode == "reference":
            continue                  # у справочников постов нет, даже собранных до перевода в справочники
        if is_junk(rec, src):
            continue
        totals[rec["source"]] += 1
        date = parse_date(rec.get("published")) or parse_date(rec["seen"])
        if not date or date > now + timedelta(hours=12):
            continue
        title = clean_title(rec["title"])
        if search:
            archive_recs.append({"url": rec["url"], "title": title, "summary": rec.get("summary", ""),
                                 "source": src.name, "section": src.section, "date": iso(date)})
        if rec.get("baseline") or date < border:
            continue
        # одна статья из ленты сайта и из его Telegram-канала — показываем один раз, ссылку на сайт
        key = (rec["source"], title_key(title))
        prev = by_key.get(key)
        if prev is not None:
            if prev["_via"] == "telegram" and rec.get("via") != "telegram":
                prev.update(u=rec["url"], _via=rec.get("via"))
            continue
        item = {"i": rec["id"], "s": rec["source"], "u": rec["url"], "t": title, "d": iso(date),
                "_via": rec.get("via")}
        if rec.get("summary"):
            item["m"] = rec["summary"]
        if not rec.get("published"):
            item["k"] = 1          # даты нет: показано время, когда сборщик нашёл пост
        by_key[key] = item
        posts.append(item)
    for p in posts:
        p.pop("_via", None)
    posts.sort(key=lambda p: p["d"], reverse=True)
    recent_border = iso(now - timedelta(days=RECENT_DAYS))
    recent = [p for p in posts if p["d"] >= recent_border]
    older = [p for p in posts if p["d"] < recent_border]

    fav_dir = data_dir / "favicons"
    fav_index = {}
    if (fav_dir / "index.json").exists():
        fav_index = json.loads((fav_dir / "index.json").read_text(encoding="utf-8"))

    out_sources = []
    for s in sources:
        st = sstate.get(s.id, {})
        h = st.get("health", {})
        status, message = source_status(s, st, now)
        host = urlsplit(s.url).netloc.lower().removeprefix("www.")
        fav = (fav_index.get(host) or {}).get("file")
        out_sources.append({
            "id": s.id, "name": s.name, "section": s.section, "url": s.url, "lang": s.lang,
            "about": s.about, "host": host, "icon": f"fav/{fav}" if fav else None,
            "method": h.get("method", s.mode) if s.mode != "reference" else "reference",
            "status": status, "message": message,
            "checked": h.get("checked"), "last_ok": st.get("last_ok"), "last_post": st.get("last_post"),
            "failing_since": st.get("failing_since") if st.get("fail_streak", 0) >= FAIL_STREAK else None,
            "total": totals.get(s.id, 0),
        })

    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(STATIC, out_dir)
    url = site_url()
    index_html = out_dir / "index.html"
    index_html.write_text(index_html.read_text(encoding="utf-8").replace("__SITE_URL__", url), encoding="utf-8")
    sw = out_dir / "sw.js"      # новая версия кэша при каждой сборке — телефон подхватит свежий сайт
    sw.write_text(sw.read_text(encoding="utf-8").replace("__VERSION__", iso(now)), encoding="utf-8")
    if fav_dir.exists():
        shutil.copytree(fav_dir, out_dir / "fav", ignore=shutil.ignore_patterns("index.json"))

    archived = 0
    if search and archive_recs:
        if archive.available():
            archived = archive.build_index(archive_recs, out_dir / "pagefind")
        else:
            print("pagefind не установлен — поиск по архиву пропущен")

    runs = state.get("runs", [])
    meta = {
        "generated": iso(now),
        "last_run": state.get("last_run"),
        "window_days": days,
        "recent_days": RECENT_DAYS,
        "has_older": bool(older),
        "archive": archived,
        "sections": [{"id": sec.id, "name": sec.name, "udc": sec.udc} for sec in sections],
        "last_runs": runs[-24:],
    }
    (out_dir / "data").mkdir(exist_ok=True)
    for name, obj in (("posts", recent), ("posts-older", older), ("sources", out_sources), ("meta", meta)):
        (out_dir / "data" / f"{name}.json").write_text(
            json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"posts": len(posts), "recent": len(recent), "sources": len(out_sources), "archive": archived}


def check(out_dir: Path, sources_path: Path) -> list[str]:
    """Быстрая проверка собранного сайта перед публикацией. Пустой список — всё в порядке."""
    problems = []
    for f in ("index.html", "app.js", "app.css", "sw.js", "manifest.webmanifest",
              "data/posts.json", "data/sources.json", "data/meta.json"):
        if not (out_dir / f).exists():
            problems.append(f"нет файла {f}")
    if problems:
        return problems
    _, sources = config.load(sources_path)
    got = json.loads((out_dir / "data" / "sources.json").read_text(encoding="utf-8"))
    if len(got) != len(sources):
        problems.append(f"источников {len(got)}, а в sources.yaml {len(sources)}")
    posts = json.loads((out_dir / "data" / "posts.json").read_text(encoding="utf-8"))
    if not posts:
        problems.append("posts.json пустой: за две недели ни одного поста")
    if any(not SAFE_URL.match(p["u"]) for p in posts):
        problems.append("в posts.json есть ссылки не http/https")
    return problems


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Собрать статический дашборд")
    ap.add_argument("--data", default=str(config.ROOT / "data"))
    ap.add_argument("--out", default=str(config.ROOT / "public"))
    ap.add_argument("--sources", default=str(config.ROOT / "sources.yaml"))
    ap.add_argument("--days", type=int, default=31)
    ap.add_argument("--no-search", action="store_true", help="не строить поиск по архиву")
    ap.add_argument("--check", action="store_true", help="проверить собранный сайт; ошибка — код 1")
    args = ap.parse_args(argv)
    if args.check:
        problems = check(Path(args.out), Path(args.sources))
        for p in problems:
            print("Проблема:", p)
        if problems:
            raise SystemExit(1)
        print("Проверка сайта: всё в порядке")
        return
    res = build(Path(args.data), Path(args.out), Path(args.sources), args.days, search=not args.no_search)
    print(f"Дашборд собран: {res['posts']} постов ({res['recent']} за две недели), "
          f"{res['sources']} источников, в поиске по архиву {res['archive']} -> {args.out}")
