"""Разбор HTML: список статей на странице и метаданные отдельной статьи."""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from ..util import html_to_text, parse_date, same_site, truncate

BAD_PATH = re.compile(
    r"/(tag|tags|category|categories|rubric|rubrics|author|authors|page|login|signin|signup|register|"
    r"search|about|contacts?|subscribe|subscription|privacy|terms|policy|donate|shop|cart|account|"
    r"feed|rss|archive|archives|events?|podcasts?|video|newsletters?|topics?|series|people|team|"
    r"adv|ads|reklama|o-proekte|kontakty|avtory?|teg|tegi|rubrika)(/|$)", re.I)
BAD_EXT = re.compile(r"\.(jpe?g|png|gif|webp|svg|pdf|zip|mp3|mp4|docx?|xlsx?)$", re.I)


def _looks_like_article(url: str) -> bool:
    path = urlsplit(url).path
    if not path or path == "/" or BAD_PATH.search(path) or BAD_EXT.search(path):
        return False
    last = [seg for seg in path.split("/") if seg]
    if not last:
        return False
    tail = last[-1]
    return bool(re.search(r"\d", tail)) or tail.count("-") >= 2 or len(tail) >= 25


def harvest(content: bytes | str, base_url: str, selectors: dict | None = None,
            limit: int = 40) -> list[dict]:
    """Ссылки на статьи со страницы-списка. Без селекторов — эвристика."""
    soup = BeautifulSoup(content, "lxml")
    for junk in soup.select("header nav, footer, nav, script, style, noscript"):
        junk.decompose()
    results, seen = [], set()

    if selectors and selectors.get("item"):
        for node in soup.select(selectors["item"]):
            a = node.select_one(selectors.get("link", "a[href]")) if node.name != "a" else node
            if not a or not a.get("href"):
                continue
            t = node.select_one(selectors["title"]) if selectors.get("title") else a
            url = urljoin(base_url, a["href"]).split("#")[0]
            title = html_to_text(t.get_text(" ") if t else a.get_text(" "))
            if url not in seen and title:
                seen.add(url)
                results.append({"url": url, "title": truncate(title, 240), "summary": "",
                                "published": None, "via": "page"})
        return results[:limit]

    scope = soup.find("main") or soup.body or soup
    for a in scope.find_all("a", href=True):
        url = urljoin(base_url, a["href"]).split("#")[0]
        if url in seen or not same_site(url, base_url) or not _looks_like_article(url):
            continue
        title = html_to_text(a.get_text(" "))
        if not (20 <= len(title) <= 220):
            heading = a.find(["h1", "h2", "h3", "h4"])
            title = html_to_text(heading.get_text(" ")) if heading else title
            if not (20 <= len(title) <= 220):
                continue
        seen.add(url)
        results.append({"url": url, "title": truncate(title, 240), "summary": "",
                        "published": None, "via": "page"})
        if len(results) >= limit:
            break
    return results


def meta(content: bytes | str) -> dict:
    """Заголовок, описание и дата публикации статьи из её HTML."""
    soup = BeautifulSoup(content, "lxml")

    def prop(*names):
        for n in names:
            tag = soup.find("meta", attrs={"property": n}) or soup.find("meta", attrs={"name": n})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return ""

    title = prop("og:title", "twitter:title") or (soup.title.get_text(" ").strip() if soup.title else "")
    desc = prop("og:description", "description", "twitter:description")
    date = prop("article:published_time", "og:published_time", "pubdate", "date", "dc.date")
    if not date:
        t = soup.find("time", datetime=True)
        date = t["datetime"] if t else ""
    return {"title": truncate(html_to_text(title), 240),
            "summary": truncate(html_to_text(desc), 300),
            "published": parse_date(date)}
