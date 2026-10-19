"""Один прогон сборщика: обойти все источники и сохранить новые посты.

Запуск:  python -m collector [--only id1,id2] [--data data] [--workers 8]
"""
from __future__ import annotations

import argparse
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from . import config
from .fetch import Fetcher, FetchError
from .filters import url_ok
from .methods import discover, feed, page, sitemap, telegram
from .store import Store
from .util import clean_title, iso, item_id, key_id, now_utc, parse_date

log = logging.getLogger("collector")

RESOLVE_EVERY = timedelta(days=7)    # как часто заново искать способ для режима auto
RESOLVE_BUDGET = 150                 # секунд на поиск способа для одного сайта
META_PER_RUN = 8                     # сколько новых статей догружать для заголовка/даты
FLOOD_LIMIT = 40                     # больше новых записей без даты за раз — это переиндексация, а не новости
OUTAGE_SHARE = 0.5                   # не ответило больше половины сайтов — это сбой сети у нас, а не у сайтов
OUTAGE_MIN = 6                       # ...если в прогоне хотя бы столько источников (иначе выборка мала)
BLOCKED_HTTP = re.compile(r"HTTP (401|403|451)")
LIMITED_HTTP = re.compile(r"HTTP 429")       # «слишком часто» — временное ограничение, а не запрет
NUM_TAIL = re.compile(r"^(.*/)(\d+)/?$")      # адрес вида site/articles/621


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

    start = src.list_url or src.url
    pages, blocked, network_errors = [], 0, 0
    for url in dict.fromkeys([start, src.url, root_of(src.url)]):
        try:
            resp = get_allowed(url, f)
        except RobotsBlocked:
            blocked += 1
            continue
        except FetchError as e:
            network_errors += str(e).startswith("сеть")
            continue
        pages.append((url, resp.content))
        if src.html or src.match:
            continue              # для сайтов с ручной настройкой ленту не ищем — нужна именно страница
        for candidate in discover.feed_links(resp.content, resp.url)[:3]:
            if try_feed(candidate, f):
                return {"method": "rss", "url": candidate}

    if not pages and network_errors:
        raise FetchError("сайт не отвечает")

    def harvest_ok(url, content) -> bool:
        items = page.harvest(content, url, src.html, match=src.match, min_title=src.min_title,
                             unique=src.unique)
        return len([i for i in items if src.unique or url_ok(src, i["url"])]) >= 3 or \
            (bool(src.html) and len(items) >= 1)

    if src.html:                  # заданы селекторы — разбираем только страницу
        for url, content in pages:
            if harvest_ok(url, content):
                return {"method": "page", "url": url}
        raise NothingFound("селекторы из sources.yaml ничего не нашли на странице")

    if not src.match:
        for candidate in discover.common_candidates(src.url):
            if out_of_time():
                raise NothingFound("не уложился в отведённое время при поиске ленты")
            if try_feed(candidate, f):
                return {"method": "rss", "url": candidate}

    undated_sitemap = None
    for sm in (f.sitemaps_from_robots(src.url) or [root_of(src.url) + "sitemap.xml"])[:3]:
        if out_of_time():
            break
        try:
            items, dated = collect_sitemap(sm, src, f, seen=set(), limit_meta=0, probe=True)
        except Exception:  # noqa: BLE001 — любая поломка карты = идём дальше
            continue
        if items and dated:
            return {"method": "sitemap", "url": sm}
        if len(items) >= 3 and not undated_sitemap:
            undated_sitemap = sm

    for url, content in pages:
        if harvest_ok(url, content):
            return {"method": "page", "url": url}

    if undated_sitemap:
        return {"method": "sitemap", "url": undated_sitemap}

    if blocked and not pages:
        raise RobotsBlocked("robots.txt запрещает обход")
    raise NothingFound("не нашёл ни ленты, ни карты сайта, ни списка статей")


def collect_sitemap(url: str, src: config.Source, f: Fetcher, seen: set[str],
                    limit_meta: int = META_PER_RUN, meta_only_dated: bool = False,
                    probe: bool = False) -> tuple[list[dict], bool]:
    """Посты из карты сайта. Возвращает (посты, есть_ли_даты)."""
    resp = get_allowed(url, f)
    pages, children = sitemap.parse(resp.content)
    for child in sitemap.pick_children(children):
        try:
            more, _ = sitemap.parse(get_allowed(child, f).content)
            pages.extend(more)
        except (FetchError, RobotsBlocked):
            continue
    pages = [p for p in pages if url_ok(src, p["loc"])]
    dated = any(p["lastmod"] for p in pages)
    chosen = sitemap.recent(pages) if dated else pages[-2000:]
    if meta_only_dated and not dated:
        limit_meta = 0
    items, fetched = [], 0
    for p in chosen:
        item = {"url": p["loc"], "title": p["title"], "summary": "",
                "published": p["lastmod"], "via": "sitemap"}
        got_meta = False
        if item_id(p["loc"]) not in seen and fetched < limit_meta:
            fetched += 1
            try:
                m = page.meta(get_allowed(p["loc"], f).content)
                item["title"] = m["title"] or item["title"]
                item["summary"] = m["summary"]
                item["published"] = m["published"] or item["published"]
                got_meta = True
            except (FetchError, RobotsBlocked):
                pass
        if not item["title"] and dated and not got_meta and not probe:
            continue          # заголовок догрузим в одном из следующих прогонов
        if not item["title"]:
            slug = [s for s in urlsplit(p["loc"]).path.split("/") if s]
            item["title"] = slug[-1].replace("-", " ").replace("_", " ").capitalize() if slug else p["loc"]
        item["title"] = clean_title(item["title"])
        items.append(item)
    return items, dated


def collect_page(url: str, src: config.Source, f: Fetcher, seen: set[str], enrich: bool) -> list[dict]:
    resp = get_allowed(url, f)
    items = page.harvest(resp.content, resp.url, src.html, match=src.match,
                         min_title=src.min_title, unique=src.unique)
    if not src.unique:
        items = [i for i in items if url_ok(src, i["url"])]
    if enrich and not src.unique:
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


def _rec_id(it: dict) -> str:
    return key_id(it["key"]) if it.get("key") else item_id(it["url"])


def _url_number(url: str) -> tuple[str, int] | None:
    p = urlsplit(url)
    m = NUM_TAIL.match(p.netloc.lower().removeprefix("www.") + p.path)
    return (m.group(1), int(m.group(2))) if m else None


def mark_old_numbers(records: list[dict], st: dict, seen: set[str]) -> None:
    """Номера статей обычно растут. Запись без даты с номером не больше уже виденного —
    это старый материал, всплывший на главной, а не новый пост."""
    nums = st.setdefault("max_num", {})
    known = dict(nums)
    for rec in records:
        got = _url_number(rec["url"])
        if not got:
            continue
        prefix, n = got
        if (not rec["published"] and rec["id"] not in seen and prefix in known
                and n <= known[prefix]):
            rec["baseline"] = True
        nums[prefix] = max(nums.get(prefix, 0), n)


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
            not_modified, errors, ok = True, [], 0
            for url in src.feeds:
                try:
                    got, nm = get_feed(url, f, st)
                except (FetchError, feed.NotAFeed) as e:
                    errors.append(e)
                    continue
                ok += 1
                items += got
                not_modified &= nm
            if not ok:
                raise errors[0]
            if not_modified:
                health["status"] = "not_modified"
            if errors:
                health["message"] = f"одна из лент недоступна: {errors[0]}"
        else:
            res = st.get("resolved")
            fp = src.fingerprint()
            fresh = (res and res.get("fp") == fp and parse_date(res.get("at"))
                     and now - parse_date(res["at"]) < RESOLVE_EVERY)
            for attempt in (0, 1):
                if not fresh or attempt == 1:
                    old = (res or {}).get("method"), (res or {}).get("url")
                    res = resolve(src, f)
                    res.update(at=iso(now), fp=fp)
                    if old != (res["method"], res["url"]):
                        is_first = True          # новый способ: всё найденное сейчас — не «новое»
                    st["resolved"] = res
                try:
                    if res["method"] == "rss":
                        got, nm = get_feed(res["url"], f, st)
                        if nm:
                            health["status"] = "not_modified"
                        items += got
                    elif res["method"] == "sitemap":
                        # первый прогон: страницам с датой догружаем заголовки щедрее,
                        # карты без дат пойдут в «архив», им заголовки не нужны
                        got, dated = collect_sitemap(res["url"], src, f, seen,
                                                     limit_meta=20 if is_first else META_PER_RUN,
                                                     meta_only_dated=is_first)
                        items += got
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
        health.update(status="blocked", message=f"robots.txt просит роботов не заходить ({e})"[:200])
    except NothingFound as e:
        health.update(status="error", message=str(e))
    except FetchError as e:
        msg = str(e)
        if BLOCKED_HTTP.search(msg):
            health.update(status="blocked", message=f"сайт не пускает сборщик ({msg})")
        elif LIMITED_HTTP.search(msg):
            health.update(status="limited", message="сайт просит заходить реже (HTTP 429), повторим позже")
        else:
            health.update(status="error", message=msg)
    except feed.NotAFeed as e:
        health.update(status="error", message=f"лента не читается: {e}")
    except Exception as e:  # noqa: BLE001 — один сломанный сайт не должен ронять весь прогон
        log.exception("%s: неожиданная ошибка", src.id)
        health.update(status="error", message=f"{type(e).__name__}: {e}"[:200])

    records, undated_new = [], 0
    for it in items:
        pub = it["published"]
        if pub and pub > now + timedelta(hours=12):
            pub = now
        rid = _rec_id(it)
        rec = {"id": rid, "source": src.id, "url": it["url"],
               "title": it["title"], "summary": it.get("summary", ""),
               "published": iso(pub), "seen": iso(now), "via": it["via"]}
        if not pub and rid not in seen:
            undated_new += 1
        records.append(rec)
    mark_old_numbers(records, st, seen)
    baseline = is_first or undated_new > FLOOD_LIMIT
    if baseline:
        for rec in records:
            if not rec["published"]:
                rec["baseline"] = True   # старые статьи без даты не считаем «новыми»
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

    live = [s for s in sources if s.mode != "reference"]
    failed = [s for s in live if results[s.id][1]["status"] not in ("ok", "not_modified")]
    outage = len(live) >= OUTAGE_MIN and len(failed) > len(live) * OUTAGE_SHARE
    if outage:
        log.warning("Не ответили %d из %d источников — похоже на сбой сети; неудачи источникам не засчитываю",
                    len(failed), len(live))

    total_new, errors = 0, 0
    for src in sources:
        records, health = results[src.id]
        st = states[src.id]
        new = store.add(records)
        total_new += new
        health["new"] = new
        if health["status"] in ("ok", "not_modified", "reference"):
            if health["status"] != "reference":
                st["last_ok"] = health["checked"]
            st.pop("fail_streak", None)
            st.pop("failing_since", None)
        elif outage:
            pass                         # общий сбой: серию неудач источника не продлеваем
        else:
            # сколько прогонов подряд не удалось: «ошибку» дашборд покажет только после нескольких
            st["fail_streak"] = st.get("fail_streak", 0) + 1
            st.setdefault("failing_since", health["checked"])
            if health["status"] == "error":
                errors += 1
        dates = [r["published"] or r["seen"] for r in records if not r.get("baseline")]
        if dates:
            st["last_post"] = max(dates + ([st["last_post"]] if st.get("last_post") else []))
        st["health"] = health
        log.info("%-32s %-13s %-8s найдено %3d, новых %3d %s", src.id, health["method"],
                 health["status"], health["found"], new, health["message"])

    summary = {"at": iso(now), "seconds": round(time.monotonic() - started, 1),
               "new": total_new, "errors": errors, "sources": len(sources)}
    if outage:
        summary["outage"] = True
    store.state["runs"] = (store.state.get("runs", []) + [summary])[-48:]
    store.state["last_run"] = iso(now)
    store.save()
    return summary


def too_soon(store: Store, min_minutes: int, now: datetime | None = None) -> bool:
    """Прошло ли с прошлого сбора меньше min_minutes: тогда этот запуск лишний."""
    last = parse_date(store.state.get("last_run"))
    return bool(min_minutes and last and (now or now_utc()) - last < timedelta(minutes=min_minutes))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Собрать новые посты со всех источников")
    ap.add_argument("--only", help="id источников через запятую")
    ap.add_argument("--data", default=str(config.ROOT / "data"))
    ap.add_argument("--sources", default=str(config.ROOT / "sources.yaml"))
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--min-interval", type=int, default=0, metavar="МИНУТ",
                    help="не собирать, если прошлый сбор был меньше стольких минут назад")
    ap.add_argument("--force", action="store_true", help="собрать, даже если недавно собирали")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(message)s")
    _, sources = config.load(Path(args.sources))
    configured = {s.id for s in sources}
    if args.only:
        wanted = set(args.only.split(","))
        sources = [s for s in sources if s.id in wanted]
    store = Store(Path(args.data))
    if not args.force and too_soon(store, args.min_interval):
        log.info("Прошлый сбор был %s — меньше %d мин назад, этот запуск пропускаю",
                 store.state.get("last_run"), args.min_interval)
        return
    gone = store.prune(configured)
    if gone:
        log.info("Убраны из состояния источники, которых нет в sources.yaml: %s", ", ".join(gone))
    summary = collect_all(sources, store, Fetcher(), workers=args.workers)
    log.info("Готово: %d новых постов, %d источников с ошибками, %.0f с",
             summary["new"], summary["errors"], summary["seconds"])
