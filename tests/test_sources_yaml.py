"""Проверка настоящего sources.yaml: опечатка в нём не должна молча ломать сбор."""
import re

import yaml

from collector import config


def test_sources_yaml_is_valid():
    sections, sources = config.load()           # сам по себе ловит неизвестные разделы и повторы id
    assert 5 <= len(sections) <= 12
    assert len({s.id for s in sections}) == len(sections)
    used = {s.section for s in sources}
    assert used == {s.name for s in sections}, "у каждого раздела должен быть хотя бы один источник"
    for s in sources:
        assert re.fullmatch(r"[a-z0-9-]+", s.id), s.id
        assert s.url.startswith(("http://", "https://")), s.id
        assert s.lang in ("ru", "en"), s.id
        assert s.mode in ("feed", "auto", "reference"), s.id
        for f in s.feeds + ([s.feed_hint] if s.feed_hint else []) + ([s.list_url] if s.list_url else []):
            assert f.startswith(("http://", "https://")), f"{s.id}: {f}"
        if s.match:
            re.compile(s.match)
        if s.html:
            assert set(s.html) <= {"item", "link", "title"}, s.id


def test_sources_yaml_has_no_unknown_fields():
    raw = yaml.safe_load(config.ROOT.joinpath("sources.yaml").read_text(encoding="utf-8"))
    known = set(config.Source.__dataclass_fields__)
    for src in raw["sources"]:
        assert set(src) <= known, f"{src['id']}: лишние поля {set(src) - known}"
