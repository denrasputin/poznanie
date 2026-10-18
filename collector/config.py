from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Source:
    id: str
    name: str
    section: str
    url: str
    lang: str = ""
    mode: str = "feed"          # feed | auto | reference
    feeds: list[str] = field(default_factory=list)
    feed_hint: str | None = None
    telegram: str | None = None
    html: dict | None = None     # {item, link, title}
    about: str = ""              # краткое описание сайта для каталога
    list_url: str | None = None  # страница со списком статей, если это не главная
    match: str | None = None     # регулярное выражение: какие адреса считать статьями
    unique: str | None = None    # "title": у всех записей один адрес, различаем по заголовку
    min_title: int = 20          # минимальная длина заголовка при разборе страницы

    def fingerprint(self) -> str:
        """Меняется, когда меняются настройки поиска — тогда способ ищется заново."""
        return "|".join(str(x) for x in (self.url, self.list_url, self.match, self.html,
                                         self.feed_hint, self.unique, self.min_title))


@dataclass
class Section:
    id: str
    name: str
    udc: str = ""


def load(path: Path | None = None) -> tuple[list[Section], list[Source]]:
    path = path or ROOT / "sources.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    sections = [Section(**s) for s in data["sections"]]
    names = {s.name for s in sections}
    sources: list[Source] = []
    seen: set[str] = set()
    for raw in data["sources"]:
        src = Source(**raw)
        if src.feeds and src.mode == "feed":
            pass
        elif not src.feeds and src.mode == "feed":
            src.mode = "auto"
        if src.section not in names:
            raise ValueError(f"{src.id}: неизвестный раздел «{src.section}»")
        if src.id in seen:
            raise ValueError(f"повторяющийся id: {src.id}")
        seen.add(src.id)
        sources.append(src)
    return sections, sources
