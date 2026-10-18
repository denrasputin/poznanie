"""Демо-данные для предпросмотра дашборда до первого запуска сборщика.

    python tools/demo_data.py /tmp/demo-data && python -m dashboard --data /tmp/demo-data --out /tmp/demo-public

Заголовки — заглушки, а не реальные статьи источников.
"""
import json
import random
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from collector import config  # noqa: E402
from collector.util import iso, item_id, now_utc  # noqa: E402

TITLES = [
    "Пример заголовка: здесь будет название свежей статьи",
    "Демо-запись: так выглядит длинный заголовок, который переносится на вторую строку в узкой колонке",
    "Заглушка заголовка для предпросмотра",
    "Пример: короткий заголовок",
    "Demo entry: an English headline will look like this",
    "Пример заголовка эссе с подзаголовком: вторая часть после двоеточия",
]
SUMMARY = ("Здесь появится анонс из ленты источника: первые одно-два предложения статьи, "
           "обрезанные по границе слова, чтобы карточка оставалась компактной.")

out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/demo-data")
(out / "posts").mkdir(parents=True, exist_ok=True)
_, sources = config.load()
rnd = random.Random(7)
now = now_utc()
state = {"sources": {}, "runs": [], "last_run": iso(now - timedelta(minutes=23))}
lines = []
for s in sources:
    if s.mode == "reference":
        state["sources"][s.id] = {"health": {"status": "reference", "method": "reference"}}
        continue
    status = rnd.choices(["ok", "error", "robots", "stale"], [0.84, 0.08, 0.04, 0.04])[0]
    method = "rss" if s.feeds else rnd.choice(["rss", "sitemap", "page"])
    msg = {"error": "HTTP 403", "robots": "robots.txt запрещает обход"}.get(status, "")
    last = None
    if status in ("ok",):
        for _ in range(rnd.randint(1, 14)):
            d = now - timedelta(hours=rnd.uniform(0, 14 * 24) ** 1.0)
            title = rnd.choice(TITLES)
            url = f"{s.url.rstrip('/')}/demo/{rnd.randint(1, 10**9)}"
            rec = {"id": item_id(url), "source": s.id, "url": url, "title": title,
                   "summary": SUMMARY if rnd.random() < 0.7 else "", "published": iso(d),
                   "seen": iso(now), "via": method}
            if method == "page":
                rec["published"] = None
                rec["seen"] = iso(d)
            lines.append(rec)
            last = max(last or iso(d), iso(d))
    elif status == "stale":
        last = iso(now - timedelta(days=rnd.randint(90, 900)))
    state["sources"][s.id] = {"health": {"status": status, "method": method, "message": msg,
                                         "checked": state["last_run"]}, "last_post": last,
                              "last_ok": state["last_run"]}
by_month = {}
for rec in lines:
    by_month.setdefault(rec["seen"][:7], []).append(rec)
for m, recs in by_month.items():
    (out / "posts" / f"{m}.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n", encoding="utf-8")
(out / "state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
print(f"Демо: {len(lines)} записей -> {out}")
