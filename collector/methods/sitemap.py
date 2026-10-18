"""Карта сайта (sitemap.xml): свежие адреса с датой lastmod."""
from __future__ import annotations

import gzip
import re
from datetime import timedelta

from bs4 import BeautifulSoup

from ..util import now_utc, parse_date


def _soup(content: bytes):
    if content[:2] == b"\x1f\x8b":
        content = gzip.decompress(content)
    return BeautifulSoup(content, "xml")


def parse(content: bytes) -> tuple[list[dict], list[dict]]:
    """Возвращает (страницы, вложенные карты). Каждая запись: {loc, lastmod, title}."""
    soup = _soup(content)
    pages, children = [], []
    for node in soup.find_all("sitemap"):
        loc = node.find("loc")
        if loc and loc.text.strip():
            children.append({"loc": loc.text.strip(),
                             "lastmod": parse_date(node.find("lastmod").text if node.find("lastmod") else None)})
    for node in soup.find_all("url"):
        loc = node.find("loc")
        if not loc or not loc.text.strip():
            continue
        title_node = node.find(re.compile(r"(^|:)title$"))
        lastmod = node.find("lastmod") or node.find(re.compile(r"(^|:)publication_date$"))
        pages.append({"loc": loc.text.strip(),
                      "lastmod": parse_date(lastmod.text if lastmod else None),
                      "title": title_node.text.strip() if title_node else ""})
    return pages, children


def pick_children(children: list[dict], limit: int = 3) -> list[str]:
    """Из индекса карт выбираем самые свежие (по lastmod или по году/месяцу в имени)."""
    if not children:
        return []
    dated = [c for c in children if c["lastmod"]]
    if dated:
        dated.sort(key=lambda c: c["lastmod"], reverse=True)
        return [c["loc"] for c in dated[:limit]]
    year = str(now_utc().year)
    with_year = [c["loc"] for c in children if year in c["loc"]]
    if with_year:
        return sorted(with_year, reverse=True)[:limit]
    news = [c["loc"] for c in children if re.search(r"news|post|article|statj|stat", c["loc"])]
    return (news or [c["loc"] for c in children])[-limit:]


def recent(pages: list[dict], days: int = 14, limit: int = 40) -> list[dict]:
    border = now_utc() - timedelta(days=days)
    fresh = [p for p in pages if p["lastmod"] and p["lastmod"] >= border]
    fresh.sort(key=lambda p: p["lastmod"], reverse=True)
    return fresh[:limit]
