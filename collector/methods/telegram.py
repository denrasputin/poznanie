"""Публичный Telegram-канал через веб-превью t.me/s/<канал>."""
from __future__ import annotations

from bs4 import BeautifulSoup

import re

from ..util import parse_date, same_site, truncate


def _text(node) -> str:
    for br in node.find_all("br"):
        br.replace_with("\n")
    text = node.get_text("")
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def channel_url(name: str) -> str:
    return f"https://t.me/s/{name.lstrip('@')}"


def parse(content: bytes | str, channel: str, site_url: str | None = None) -> list[dict]:
    soup = BeautifulSoup(content, "lxml")
    items = []
    for msg in soup.select("div.tgme_widget_message[data-post]"):
        text_node = msg.select_one(".tgme_widget_message_text")
        text = _text(text_node) if text_node else ""
        if not text:
            continue
        url = f"https://t.me/{msg['data-post']}"
        if site_url and text_node:
            for a in text_node.find_all("a", href=True):
                if same_site(a["href"], site_url):
                    url = a["href"]
                    break
        first_line = text.split("\n", 1)[0]
        title = truncate(first_line, 140)
        t = msg.select_one("a.tgme_widget_message_date time[datetime]")
        items.append({
            "url": url,
            "title": title,
            "summary": truncate(" ".join(text[len(first_line):].split()), 300),
            "published": parse_date(t["datetime"]) if t else None,
            "via": "telegram",
        })
    return items
