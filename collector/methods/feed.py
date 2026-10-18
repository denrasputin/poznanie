"""RSS / Atom / YouTube-ленты."""
from __future__ import annotations

import feedparser

from ..util import html_to_text, parse_date, truncate


class NotAFeed(Exception):
    pass


def parse_feed(content: bytes, base_url: str) -> list[dict]:
    parsed = feedparser.parse(content, response_headers={"content-location": base_url})
    if not parsed.entries:
        if parsed.bozo and not parsed.feed:
            raise NotAFeed("не RSS/Atom")
        if not parsed.feed and not parsed.version:
            raise NotAFeed("не RSS/Atom")
        return []
    items = []
    for e in parsed.entries:
        link = e.get("link") or ""
        if not link.startswith("http"):
            eid = e.get("id", "")
            link = eid if eid.startswith("http") else ""
        if not link:
            continue
        title = html_to_text(e.get("title")) or "(без заголовка)"
        summary = e.get("summary") or ""
        if not summary and e.get("media_description"):
            summary = e["media_description"]
        published = parse_date(e.get("published_parsed") or e.get("updated_parsed")
                               or e.get("published") or e.get("updated"))
        items.append({
            "url": link,
            "title": truncate(title, 240),
            "summary": truncate(html_to_text(summary), 300),
            "published": published,
            "via": "rss",
        })
    return items


def looks_like_feed(content: bytes) -> bool:
    head = content[:2000].lstrip().lower()
    return head.startswith(b"<?xml") and (b"<rss" in head or b"<feed" in head or b"<rdf" in head) \
        or head.startswith(b"<rss") or head.startswith(b"<feed")
