"""Собирает public/: страница дашборда + данные в JSON.

Запуск:  python -m dashboard [--data data] [--out public] [--days 45]
"""
from __future__ import annotations

import argparse
import json
import shutil
from collections import Counter
from datetime import timedelta
from pathlib import Path

from collector import config
from collector.store import iter_posts
from collector.util import iso, now_utc, parse_date

STATIC = Path(__file__).resolve().parent / "static"
STALE_DAYS = 60


def months_back(now, days: int) -> list[str]:
    months, d = set(), now - timedelta(days=days + 31)
    while d <= now:
        months.add(d.strftime("%Y-%m"))
        d += timedelta(days=27)
    months.add(now.strftime("%Y-%m"))
    return sorted(months)


def build(data_dir: Path, out_dir: Path, sources_path: Path, days: int = 31, now=None) -> dict:
    now = now or now_utc()
    sections, sources = config.load(sources_path)
    src_by_id = {s.id: s for s in sources}
    state = {}
    state_path = data_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    sstate = state.get("sources", {})

    border = now - timedelta(days=days)
    posts, totals = [], Counter()
    for rec in iter_posts(data_dir):
        totals[rec["source"]] += 1
    for rec in iter_posts(data_dir, months_back(now, days)):
        if rec["source"] not in src_by_id or rec.get("baseline"):
            continue
        date = parse_date(rec.get("published")) or parse_date(rec["seen"])
        if not date or date < border:
            continue
        item = {"i": rec["id"], "s": rec["source"], "u": rec["url"], "t": rec["title"],
                "d": iso(date)}
        if rec.get("summary"):
            item["m"] = rec["summary"]
        if not rec.get("published"):
            item["k"] = 1          # дата = момент, когда сборщик увидел пост
        posts.append(item)
    posts.sort(key=lambda p: p["d"], reverse=True)

    out_sources = []
    for s in sources:
        st = sstate.get(s.id, {})
        h = st.get("health", {})
        status = "reference" if s.mode == "reference" else h.get("status", "pending")
        if status == "not_modified":
            status = "ok"
        last_post = st.get("last_post")
        if status == "ok" and last_post:
            lp = parse_date(last_post)
            if lp and now - lp > timedelta(days=STALE_DAYS):
                status = "stale"
        out_sources.append({
            "id": s.id, "name": s.name, "section": s.section, "url": s.url, "lang": s.lang,
            "method": h.get("method", s.mode) if s.mode != "reference" else "reference",
            "status": status, "message": h.get("message", ""),
            "checked": h.get("checked"), "last_ok": st.get("last_ok"), "last_post": last_post,
            "total": totals.get(s.id, 0),
        })

    runs = state.get("runs", [])
    meta = {
        "generated": iso(now),
        "last_run": state.get("last_run"),
        "window_days": days,
        "sections": [{"id": sec.id, "name": sec.name, "udc": sec.udc} for sec in sections],
        "last_runs": runs[-24:],
    }

    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(STATIC, out_dir)
    (out_dir / "data").mkdir(exist_ok=True)
    for name, obj in (("posts", posts), ("sources", out_sources), ("meta", meta)):
        (out_dir / "data" / f"{name}.json").write_text(
            json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"posts": len(posts), "sources": len(out_sources)}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Собрать статический дашборд")
    ap.add_argument("--data", default=str(config.ROOT / "data"))
    ap.add_argument("--out", default=str(config.ROOT / "public"))
    ap.add_argument("--sources", default=str(config.ROOT / "sources.yaml"))
    ap.add_argument("--days", type=int, default=31)
    args = ap.parse_args(argv)
    res = build(Path(args.data), Path(args.out), Path(args.sources), args.days)
    print(f"Дашборд собран: {res['posts']} постов, {res['sources']} источников -> {args.out}")
