"""Какие адреса из карты сайта или со страницы считать статьями."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from .methods.page import BAD_EXT, BAD_PATH
from .util import normalize_url


def url_ok(src, url: str) -> bool:
    path = urlsplit(url).path or "/"
    if not path.strip("/"):
        return False                                   # главная страница
    if normalize_url(url) in {normalize_url(u) for u in (src.url, src.list_url) if u}:
        return False                                   # сама страница-список
    if src.match and not re.search(src.match, url):
        return False
    return not (BAD_PATH.search(path) or BAD_EXT.search(path))
