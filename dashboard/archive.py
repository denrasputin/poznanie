"""Поиск по всему архиву: индекс Pagefind из data/posts/*.jsonl.

Pagefind нарезает индекс на мелкие файлы; браузер скачивает только те, что нужны для запроса,
поэтому поиск работает на статическом GitHub Pages без сервера.

Каждая статья записывается во временную HTML-страничку, и консольный Pagefind индексирует их за раз:
так в десятки раз быстрее, чем добавлять записи по одной через его Python-интерфейс.
"""
from __future__ import annotations

import html
import subprocess
import sys
import tempfile
from pathlib import Path


def available() -> bool:
    try:
        import pagefind  # noqa: F401
    except ImportError:
        return False
    return True


def page(r: dict) -> str:
    e = lambda s: html.escape(s or "", quote=True)  # noqa: E731
    # мета и фильтры — вне data-pagefind-body: их Pagefind сохраняет, но в текст поиска они не попадают
    return (
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>'
        f'<span data-pagefind-meta="url">{e(r["url"])}</span>'
        f'<span data-pagefind-meta="source">{e(r["source"])}</span>'
        f'<span data-pagefind-meta="date">{e(r["date"])}</span>'
        f'<span data-pagefind-filter="section">{e(r["section"])}</span>'
        f'<span data-pagefind-filter="year">{e(r["date"][:4])}</span>'
        f'<span data-pagefind-sort="date">{e(r["date"])}</span>'
        f'<main data-pagefind-body><h1 data-pagefind-meta="title">{e(r["title"])}</h1><p>{e(r["summary"])}</p></main>'
        "</body></html>")


def build_index(records: list[dict], out_dir: Path) -> int:
    """records: {url, title, summary, source, section, date}. Пишет индекс в out_dir."""
    with tempfile.TemporaryDirectory() as tmp:
        site = Path(tmp)
        for i, r in enumerate(records):
            sub = site / str(i // 1000)          # не больше тысячи файлов в папке
            sub.mkdir(exist_ok=True)
            (sub / f"{i}.html").write_text(page(r), encoding="utf-8")
        # одна языковая часть индекса: иначе с русской страницы не нашлись бы английские посты
        subprocess.run([sys.executable, "-m", "pagefind", "--site", str(site), "--output-path", str(out_dir),
                        "--force-language", "ru", "--quiet"], check=True)
    return len(records)
