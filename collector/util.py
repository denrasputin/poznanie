from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup
from dateutil import parser as dateparser

TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$|ref$|ref_src$|from$)")


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_date(value) -> datetime | None:
    """Строка, struct_time или datetime -> aware datetime в UTC (или None)."""
    if not value:
        return None
    try:
        if isinstance(value, datetime):
            dt = value
        elif hasattr(value, "tm_year"):
            dt = datetime(*value[:6], tzinfo=timezone.utc)
        else:
            dt = dateparser.parse(str(value))
    except (ValueError, OverflowError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    if dt.year < 1990:
        return None
    return dt


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                       if not TRACKING.match(k)])
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(("https", host, path, query, ""))


def item_id(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()[:16]


def html_to_text(value: str | None) -> str:
    if not value:
        return ""
    if "<" in value:
        value = BeautifulSoup(value, "lxml").get_text(" ")
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def truncate(text: str, limit: int = 300) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",.;:—- ")
    return cut + "…"


def same_site(url: str, base: str) -> bool:
    a = urlsplit(url).netloc.lower().removeprefix("www.")
    b = urlsplit(base).netloc.lower().removeprefix("www.")
    return bool(a) and (a == b or a.endswith("." + b) or b.endswith("." + a))


def key_id(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


_SUFFIX = re.compile(r"\s+[|–—-]\s+([^|–—]{2,40})$")


def clean_title(title: str) -> str:
    """Убирает хвост вида « | Название сайта» из заголовков страниц."""
    t = title.strip()
    m = _SUFFIX.search(t)
    if m and len(t) - len(m.group(0)) >= 15:
        t = t[: m.start()].rstrip()
    t = re.sub(r"^(Обновлено|Новое|Updated|New)\s+(?=[A-ZА-ЯЁ«\"])", "", t)
    return t
