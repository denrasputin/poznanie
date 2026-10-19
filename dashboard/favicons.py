"""Значки сайтов: скачиваются сборщиком изредка и хранятся вместе с данными (data/favicons/).

Страница берёт их у себя, а не у Google, поэтому открывается быстрее и никому не сообщает, что вы читаете.

Запуск:  python -m dashboard.favicons [--data data] [--sources sources.yaml]
"""
from __future__ import annotations

import argparse
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from collector import config
from collector.fetch import Fetcher, FetchError
from collector.util import iso, now_utc, parse_date

log = logging.getLogger("favicons")

REFRESH = timedelta(days=60)          # найденный значок перепроверяем раз в два месяца
RETRY_MISSING = timedelta(days=7)     # не найденный — раз в неделю
MAX_SIZE = 300 * 1024
GOOGLE = "https://www.google.com/s2/favicons?domain={host}&sz=64"


def host_of(url: str) -> str:
    return urlsplit(url).netloc.lower().removeprefix("www.")


def sniff(data: bytes) -> str | None:
    """Расширение по содержимому; None — это не картинка."""
    head = data[:256].lstrip()
    if data.startswith(b"\x89PNG"):
        return "png"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "ico"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in data[:1024]):
        return "svg"
    return None


def candidates(html: bytes, base: str) -> list[str]:
    """Адреса значков со страницы: сначала крупные apple-touch-icon, потом обычные icon."""
    soup = BeautifulSoup(html, "lxml")
    found: list[tuple[int, str]] = []
    for link in soup.find_all("link", href=True):
        rel = " ".join(link.get("rel", [])).lower()
        if "icon" not in rel or "mask-icon" in rel:
            continue
        sizes = re.findall(r"(\d+)x\d+", link.get("sizes") or "")
        size = max(map(int, sizes)) if sizes else (180 if "apple" in rel else 32)
        score = size if size <= 256 else 256 - (size - 256) / 100   # большие тоже годятся, но не лучше 256
        found.append((score, urljoin(base, link["href"])))
    found.sort(key=lambda x: -x[0])
    urls = [u for _, u in found]
    root = f"{urlsplit(base).scheme}://{urlsplit(base).netloc}/"
    return list(dict.fromkeys(urls + [root + "apple-touch-icon.png", root + "favicon.ico"]))


def find_icon(url: str, f: Fetcher) -> tuple[bytes, str] | None:
    try:
        page = f.get(url)
        urls = candidates(page.content, page.url)
    except FetchError:
        root = f"{urlsplit(url).scheme}://{urlsplit(url).netloc}/"
        urls = [root + "favicon.ico"]
    for u in urls[:5] + [GOOGLE.format(host=host_of(url))]:
        try:
            data = f.get(u).content
        except FetchError:
            continue
        ext = sniff(data)
        if ext and 0 < len(data) <= MAX_SIZE:
            return data, ext
    return None


def update(sources, out_dir: Path, fetcher: Fetcher | None = None, now=None, workers: int = 8) -> dict:
    """Докачивает недостающие значки. Возвращает индекс {host: {"file", "at"}}."""
    now = now or now_utc()
    fetcher = fetcher or Fetcher()
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}

    todo = {}
    for s in sources:
        host = host_of(s.url)
        rec = index.get(host)
        at = parse_date(rec.get("at")) if rec else None
        due = REFRESH if rec and rec.get("file") else RETRY_MISSING
        if not at or now - at > due:
            todo.setdefault(host, s.url)

    def work(item):
        host, url = item
        return host, find_icon(url, fetcher)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for host, got in pool.map(work, todo.items()):
            old = index.get(host, {}).get("file")
            if got:
                data, ext = got
                name = f"{re.sub(r'[^a-z0-9.-]', '_', host)}.{ext}"
                if old and old != name:
                    (out_dir / old).unlink(missing_ok=True)
                (out_dir / name).write_bytes(data)
                index[host] = {"file": name, "at": iso(now)}
            else:
                index[host] = {"file": old, "at": iso(now)}   # не нашли — оставляем прежний, если был
            log.info("%-36s %s", host, index[host]["file"] or "—")

    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    return index


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Скачать значки сайтов")
    ap.add_argument("--data", default=str(config.ROOT / "data"))
    ap.add_argument("--sources", default=str(config.ROOT / "sources.yaml"))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    _, sources = config.load(Path(args.sources))
    index = update(sources, Path(args.data) / "favicons")
    print(f"Значков: {sum(1 for v in index.values() if v.get('file'))} из {len(index)}")


if __name__ == "__main__":
    main()
