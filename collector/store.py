"""Хранилище: посты в JSONL по месяцам (удобно для git), состояние источников в state.json."""
from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from pathlib import Path

log = logging.getLogger("collector")

REQUIRED = ("id", "source", "url", "title", "seen")


def read_jsonl(path: Path):
    """Записи из файла. Испорченная строка пропускается с предупреждением, а не останавливает сбор и сайт."""
    for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            rec = None
        if not isinstance(rec, dict) or not all(isinstance(rec.get(k), str) for k in REQUIRED):
            log.warning("%s, строка %d: испорченная запись пропущена", path.name, n)
            continue
        yield rec


def read_state(path: Path) -> dict:
    """state.json; если он испорчен — откладываем копию и начинаем с чистого состояния."""
    empty = {"sources": {}, "runs": []}
    if not path.exists():
        return empty
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        state = None
    if not isinstance(state, dict) or not isinstance(state.get("sources"), dict):
        log.warning("%s испорчен: копия в %s, начинаю с чистого состояния", path.name, path.name + ".broken")
        path.with_name(path.name + ".broken").write_bytes(path.read_bytes())
        return empty
    state.setdefault("runs", [])
    return state


class Store:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir)
        self.posts_dir = self.dir / "posts"
        self.posts_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / "state.json"
        self.state = read_state(self.state_path)
        self.seen: set[str] = set()
        self.count: Counter = Counter()
        for path in sorted(self.posts_dir.glob("*.jsonl")):
            for rec in read_jsonl(path):
                self.seen.add(rec["id"])
                self.count[rec["source"]] += 1

    def source_state(self, source_id: str) -> dict:
        return self.state["sources"].setdefault(source_id, {})

    def prune(self, keep: set[str]) -> list[str]:
        """Убирает из состояния источники, которых больше нет в sources.yaml."""
        gone = sorted(k for k in self.state["sources"] if k not in keep)
        for k in gone:
            del self.state["sources"][k]
        return gone

    def add(self, records: list[dict]) -> int:
        by_month = defaultdict(list)
        for rec in records:
            if rec["id"] in self.seen:
                continue
            self.seen.add(rec["id"])
            self.count[rec["source"]] += 1
            by_month[rec["seen"][:7]].append(rec)
        for month, recs in by_month.items():
            with (self.posts_dir / f"{month}.jsonl").open("a", encoding="utf-8") as f:
                for rec in recs:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return sum(len(v) for v in by_month.values())

    def save(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1, sort_keys=True),
                       encoding="utf-8")
        tmp.replace(self.state_path)


def iter_posts(data_dir: Path, months: list[str] | None = None):
    posts_dir = Path(data_dir) / "posts"
    for path in sorted(posts_dir.glob("*.jsonl")):
        if months and path.stem not in months:
            continue
        yield from read_jsonl(path)
