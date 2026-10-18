"""Один прогон сборщика: обойти все источники и сохранить новые посты.

Запуск:  python -m collector [--only id1,id2] [--data data] [--workers 8]
"""
from __future__ import annotations

import argparse
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from . import config
from .fetch import Fetcher, FetchError
from .methods import discover, feed, page, sitemap, telegram
from .store import Store
from .util import iso, item_id, now_utc, parse_date

log = logging.getLogger("collector")

RESOLVE_EVERY = timedelta(days=7)    # как часто заново искать способ для режима auto
META_PER_RUN = 8                     # сколько новых статей догружать для заголовка/даты
RESOLVE_BUDGET = 150                 # секунд на поиск способа для одного сайта


class NothingFound(Exception):
    pass


class RobotsBlocked(Exception):
    pass


# ---------- способы получения постов ----------

def get_feed(url: str, f: Fetcher, st: dict) -> tuple[list[dict], bool]:
    """Лента с условным запросом. Возвращает (посты, not_modified)."""
    cache = st.setdefault("http", {}).get(url, {})
    resp = f.get(url, cache.get("etag"), cache.get("last_modified"))
    if resp.status == 304:
        return [], True
    items = feed.parse_feed(resp.content, resp.url)
    st["http"][url] = {k: v for k, v in (("etag", resp.headers.get("ETag")),
                                         ("last_modified", resp.headers.get("Last-Modified"))) if v}
    return items, False


def get_allowed(url: str, f: Fetcher):
    if not f.allowed(url):
        raise RobotsBlocked(url)
    return f.get(url)


def try_feed(url: str, f: Fetcher) -> bool:
    try:
        resp = f.get(url)
    except FetchError:
        return False
    if not feed.looks_like_feed(resp.content):
        return False
    try:
        return bool(feed.parse_feed(resp.content, resp.url))
    except feed.NotAFeed:
        return False


def root_of(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}/"


def resolve(src: config.Source, f: Fetcher) -> dict:
    """Режим auto: найти ленту, карту сайта или страницу со списком статей."""
    if src.feed_hint and try_feed(src.feed_hint, f):
        return {"method": "rss", "url": src.feed_hint}

    deadline = time.monotonic() + RESOLVE_BUDGET

    def out_of_time() -> bool:
        return time.monotonic() > deadline

    pages = []
    blocked = 0
    network_errors = 0
    for url in dict.fromkeys([src.url, root_of(src.url)]):
        try:
            resp = get_allowed(url, f)
        except RobotsBlocked:
            blocked += 1
            continue
        except FetchError as e:
            network_errors += str(e).startswith("сеть")
            continue
        pages.append((url, resp.content))
        for candidate in discover.feed_links(resp.content, resp.url)[:3]:
            if try_feed(candidate, f):
                return {"method": "rss", "url": candidate}

    if not pages and network_errors:
        raise FetchError("сайт не отвечает")

    for candidate in discover.common_candidates(src.url):
        if out_of_time():
            raise NothingFound("не уложился в отведённое время при поиске ленты")
        if try_feed(candidate, f):
            return {"method": "rss", "url": candidate}

    for sm in (f.sitemaps_from_robots(src.url) or [root_of(src.url) + "sitemap.xml"])[:3]:
        if out_of_time():
            break
        try:
            if collect_sitemap(sm, f, seen=set(), limit_meta=0):
                return {"method": "sitemap", "url": sm}
        except (FetchError, RobotsBlocked, Exception):  # noqa: BLE001 — любая поломка карты = идём дальше
            continue

    for url, content in pages:
        if len(page.harvest(content, url, src.html)) >= 3:
            return {"method": "page", "url": url}

    if blocked and not pages:
        raise RobotsBlocked("robots.txt запрещает обход")
    raise NothingFound("не нашёл ни ленты, ни карты сайта, ни списка статей")


def collect_sitemap(url: str, f: Fetcher, seen: set[str], limit_meta: int = META_PER_RUN) -> list[dict]:
    resp = get_allowed(url, f)
    pages, children = sitemap.parse(resp.content)
    for child in sitemap.pick_children(children):
        try:
            more, _ = sitemap.parse(get_allowed(child, f).content)
            pages.extend(more)
        except (FetchError, RobotsBlocked):
            continue
    fresh = sitemap.recent(pages)
    items = []
    fetched = 0
    for p in fresh:
        item = {"url": p["loc"], "title": p["title"], "summary": "",
                "published": p["lastmod"], "via": "sitemap"}
        if item_id(p["loc"]) not in seen and fetched < limit_meta:
            fetched += 1
            try:
                m = page.meta(get_allowed(p["loc"], f).content)
                item["title"] = m["title"] or item["title"]
                item["summary"] = m["summary"]
                item["published"] = m["published"] or item["published"]
            except (FetchError, RobotsBlocked):
                pass
        if not item["title"]:
            slug = [s for s in urlsplit(p["loc"]).path.split("/") if s]
            item["title"] = slug[-1].replace("-", " ").replace("_", " ").capitalize() if slug else p["loc"]
        items.append(item)
    return items


def collect_page(url: str, src: config.Source, f: Fetcher, seen: set[str], enrich: bool) -> list[dict]:
    resp = get_allowed(url, f)
    items = page.harvest(resp.content, resp.url, src.html)
    if enrich:
        fetched = 0
        for item in items:
            if fetched >= META_PER_RUN:
                break
            if item_id(item["url"]) in seen:
                continue
            fetched += 1
            try:
                m = page.meta(get_allowed(item["url"], f).content)
            except (FetchError, RobotsBlocked):
                continue
            item["summary"] = m["summary"]
            item["published"] = m["published"]
    return items


# ---------- один источник ----------

def run_source(src: config.Source, f: Fetcher, st: dict, seen: set[str], is_first: bool,
               now: datetime) -> tuple[list[dict], dict]:
    health = {"checked": iso(now), "status": "ok", "method": src.mode, "message": "", "found": 0}
    if src.mode == "reference":
        health.update(status="reference", method="reference")
        return [], health

    items: list[dict] = []
    try:
        if src.feeds:
            health["method"] = "rss"
            not_modified = True
            for url in src.feeds:
                got, nm = get_feed(url, f, st)
                items += got
                not_modified &= nm
            if not_modified:
                health["status"] = "not_modified"
        else:
            res = st.get("resolved")
            fresh = res and parse_date(res.get("at")) and now - parse_date(res["at"]) < RESOLVE_EVERY
            for attempt in (0, 1):
                if not fresh or attempt == 1:
                    res = resolve(src, f)
                    res["at"] = iso(now)
                    st["resolved"] = res
                try:
                    if res["method"] == "rss":
                        got, nm = get_feed(res["url"], f, st)
                        if nm:
                            health["status"] = "not_modified"
                        items += got
                    elif res["method"] == "sitemap":
                        items += collect_sitemap(res["url"], f, seen)
                    else:
                        items += collect_page(res["url"], src, f, seen, enrich=not is_first)
                    break
                except (FetchError, feed.NotAFeed) as e:
                    if attempt == 1 or not fresh:
                        raise
                    log.info("%s: сохранённый способ сломался (%s), ищу заново", src.id, e)
            health["method"] = res["method"]
            health["via_url"] = res["url"]

        if src.telegram:
            resp = f.get(telegram.channel_url(src.telegram))
            items += telegram.parse(resp.content, src.telegram, src.url)
            health["method"] += "+telegram"
    except RobotsBlocked as e:
        health.update(status="robots", message=f"robots.txt запрещает обход ({e})"[:200])
    except NothingFound as e:
        health.update(status="error", message=str(e))
    except FetchError as e:
        health.update(status="error", message=str(e))
    except feed.NotAFeed as e:
        health.update(status="error", message=f"лента не читается: {e}")
    except Exception as e:  # noqa: BLE001 — один сломанный сайт не должен ронять весь прогон
        log.exception("%s: неожиданная ошибка", src.id)
        health.update(status="error", message=f"{type(e).__name__}: {e}"[:200])

    records = []
    for it in items:
        pub = it["published"]
        if pub and pub > now + timedelta(hours=12):
            pub = now
        rec = {"id": item_id(it["url"]), "source": src.id, "url": it["url"],
               "title": it["title"], "summary": it.get("summary", ""),
               "published": iso(pub), "seen": iso(now), "via": it["via"]}
        if is_first and not pub:
            rec["baseline"] = True       # первый прогон: старые статьи без даты не считаем «новыми»
        records.append(rec)
    health["found"] = len(records)
    return records, health


# ---------- весь прогон ----------

def collect_all(sources, store: Store, fetcher: Fetcher, workers: int = 8,
                now: datetime | None = None) -> dict:
    now = now or now_utc()
    started = time.monotonic()
    states = {s.id: store.source_state(s.id) for s in sources}
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(run_source, s, fetcher, states[s.id], store.seen,
                               store.count[s.id] == 0, now): s for s in sources}
        for fut in as_completed(futures):
            src = futures[fut]
            results[src.id] = fut.result()

    total_new, errors = 0, 0
    for src in sources:
        records, health = results[src.id]
        st = states[src.id]
        new = store.add(records)
        total_new += new
        health["new"] = new
        if health["status"] in ("ok", "not_modified"):
            st["last_ok"] = health["checked"]
        elif health["status"] != "reference":
            errors += 1
        dates = [r["published"] or r["seen"] for r in records if not r.get("baseline")]
        if dates:
            st["last_post"] = max([d for d in dates] + ([st["last_post"]] if st.get("last_post") else []))
        st["health"] = health
        log.info("%-32s %-13s %-8s найдено %3d, новых %3d %s", src.id, health["method"],
                 health["status"], health["found"], new, health["message"])

    summary = {"at": iso(now), "seconds": round(time.monotonic() - started, 1),
               "new": total_new, "errors": errors, "sources": len(sources)}
    store.state["runs"] = (store.state.get("runs", []) + [summary])[-48:]
    store.state["last_run"] = iso(now)
    store.save()
    return summary


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Собрать новые посты со всех источников")
    ap.add_argument("--only", help="id источников через запятую")
    ap.add_argument("--data", default=str(config.ROOT / "data"))
    ap.add_argument("--sources", default=str(config.ROOT / "sources.yaml"))
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(message)s")
    _, sources = config.load(Path(args.sources))
    if args.only:
        wanted = set(args.only.split(","))
        sources = [s for s in sources if s.id in wanted]
    summary = collect_all(sources, Store(Path(args.data)), Fetcher(), workers=args.workers)
    log.info("Готово: %d новых постов, %d источников с ошибками, %.0f с",
             summary["new"], summary["errors"], summary["seconds"])
