"""Хранилище: посты в JSONL по месяцам (удобно для git), состояние источников в state.json."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path


class Store:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir)
        self.posts_dir = self.dir / "posts"
        self.posts_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / "state.json"
        self.state = (json.loads(self.state_path.read_text(encoding="utf-8"))
                      if self.state_path.exists() else {"sources": {}, "runs": []})
        self.seen: set[str] = set()
        self.count: Counter = Counter()
        for path in sorted(self.posts_dir.glob("*.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    rec = json.loads(line)
                    self.seen.add(rec["id"])
                    self.count[rec["source"]] += 1

    def source_state(self, source_id: str) -> dict:
        return self.state["sources"].setdefault(source_id, {})

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
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                yield json.loads(line)
