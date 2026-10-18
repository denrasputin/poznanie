"""Поиск ленты на странице: <link rel="alternate"> и типовые адреса."""
from __future__ import annotations

from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

FEED_TYPES = ("application/rss+xml", "application/atom+xml", "application/rdf+xml",
              "application/feed+json", "application/xml", "text/xml")
COMMON_PATHS = ("/feed/", "/feed", "/rss/", "/rss", "/rss.xml", "/atom.xml", "/feed.xml",
                "/index.xml", "/blog-feed.xml", "/?feed=rss2")
SKIP_WORDS = ("comments", "комментар", "/comments/")


def feed_links(html: bytes | str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    found = []
    for link in soup.find_all("link", href=True):
        rel = " ".join(link.get("rel", [])).lower()
        typ = (link.get("type") or "").lower()
        if "alternate" in rel and typ in FEED_TYPES:
            title = (link.get("title") or "").lower()
            href = urljoin(base_url, link["href"])
            if any(w in title or w in href.lower() for w in SKIP_WORDS):
                continue
            if href not in found:
                found.append(href)
    return found


def common_candidates(url: str) -> list[str]:
    p = urlsplit(url)
    root = f"{p.scheme}://{p.netloc}"
    return [root + path for path in COMMON_PATHS]
