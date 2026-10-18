"""Одноразовый генератор sources.yaml из «Сайты для познания.md».
Дальше sources.yaml редактируется вручную; скрипт оставлен для истории."""
import re, sys, yaml

MD = sys.argv[1]
OUT = sys.argv[2]

# Ленты, проверенные 17.10.2026 (адрес сайта из подборки -> лента)
FEEDS = {
 "https://iep.utm.edu/": "https://iep.utm.edu/feed/",
 "https://1000wordphilosophy.com/": "https://1000wordphilosophy.com/feed/",
 "https://historyofphilosophy.net/": "https://historyofphilosophy.net/rss.xml",
 "https://www.thephilosopher1923.org/articles": "https://www.thephilosopher1923.org/blog-feed.xml",
 "https://philosophynow.org/": "https://philosophynow.org/rss",
 "https://thepointmag.com/": "https://thepointmag.com/feed/",
 "https://philosophybites.com/": "https://philosophybites.libsyn.com/rss",
 "https://www.noemamag.com/article-topic/philosophy-culture/": "https://www.noemamag.com/feed/",
 "https://modernstoicism.com/": "https://stoicismtoday.substack.com/feed",
 "https://daily.jstor.org/": "https://daily.jstor.org/feed/",
 "https://www.anthropology-news.org/": "https://www.anthropology-news.org/feed/",
 "https://publicdomainreview.org/": "https://publicdomainreview.org/rss.xml",
 "https://provereno.media/": "https://provereno.media/feed/",
 "https://retractionwatch.com/": "https://retractionwatch.com/feed/",
 "https://www.clearerthinking.org/": "https://www.clearerthinking.org/blog-feed.xml",
 "https://www.lesswrong.com/library": "https://www.lesswrong.com/feed.xml?view=curated-rss",
 "https://www.publicbooks.org/": "https://www.publicbooks.org/feed/",
 "https://sysblok.ru/": "https://sysblok.ru/feed/",
 "https://www.asymptotejournal.com/": "https://www.asymptotejournal.com/blog/feed/",
 "https://newochem.io/": "https://newochem.io/feed/",
 "https://pchela.media/": "https://pchela.media/feed/",
 "https://knife.media/": "https://knife.media/feed/",
 "https://discours.io/guide": "https://discours.io/rss",
 "https://www.honest-broker.com/": "https://www.honest-broker.com/feed",
 "https://ncase.me/": "https://ncase.me/feed.xml",
 "https://ciechanow.ski/": "https://ciechanow.ski/atom.xml",
 "https://pudding.cool/": "https://pudding.cool/rss.xml",
 "https://spectrum.ieee.org/": "https://spectrum.ieee.org/feeds/feed.rss",
 "https://habr.com/ru/feed/": "https://habr.com/ru/rss/best/weekly/",
 "https://kod.ru/": "https://kod.ru/rss/",
 "https://kinzhal.media/": "https://kinzhal.media/feed/",
 "https://vc.ru/new": "https://vc.ru/rss",
 "https://aeon.co/": "https://aeon.co/feed.rss",
 "https://psyche.co/": "https://psyche.co/feed",
 "https://fivebooks.com/": "https://fivebooks.com/feed/",
 "https://www.themarginalian.org/": "https://www.themarginalian.org/feed/",
 "https://reminder.media/": "https://reminder.media/rss",
 "https://ideanomics.ru/": "https://ideanomics.ru/feed",
 "https://behavioralscientist.org/": "https://behavioralscientist.org/feed/",
 "https://www.in-mind.org/": "https://www.in-mind.org/rss.xml",
 "https://psyjournals.ru/": "https://psyjournals.ru/rss/news.rss",
 "https://www.quantamagazine.org/": "https://www.quantamagazine.org/feed/",
 "https://knowablemagazine.org/": "https://knowablemagazine.org/rss",
 "https://elementy.ru/": "https://elementy.ru/rss/news",
 "https://nplus1.ru/": "https://nplus1.ru/rss",
 "https://ourworldindata.org/": "https://ourworldindata.org/atom.xml",
 "https://postnauka.org/": "https://postnauka.org/feed",
 "https://www.trv-science.ru/": "https://www.trv-science.ru/feed/",
 "https://nautil.us/": "https://nautil.us/feed/",
 "https://naked-science.ru/": "https://naked-science.ru/feed",
 # рабочие, но давно не обновлявшиеся ленты
 "https://gefter.ru/": "https://gefter.ru/feed",
 "https://antropogenez.ru/": "https://antropogenez.ru/rss/",
 "https://perito.media/": "https://perito.media/feed",
 "https://www.symmetrymagazine.org/": "https://www.symmetrymagazine.org/feed",
 "https://what-if.xkcd.com/": "https://what-if.xkcd.com/feed.atom",
}
# Предполагаемые ленты, которые не удалось проверить автоматически
HINTS = {
 "https://plato.stanford.edu/": "https://plato.stanford.edu/rss/sep.xml",
 "https://www.3blue1brown.com/": "https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw",
 "https://www.bbc.co.uk/programmes/b006qykl": "https://podcasts.files.bbci.co.uk/b006qykl.rss",
 "https://www.sapiens.org/": "https://www.sapiens.org/feed/",
 "https://skepticalinquirer.org/": "https://skepticalinquirer.org/feed/",
 "https://www.wi-phi.com/": "https://www.wi-phi.com/feed/",
}
# Справочники и инструменты: новых постов нет
REFERENCE = {
 "https://www.earlymoderntexts.com/", "https://philpapers.org/", "https://philarchive.org/",
 "https://www.denizcemonduygu.com/philo/browse/#", "https://suttacentral.net/",
 "https://www.gapminder.org/dollar-street", "https://hraf.yale.edu/ehc/", "https://russiainphoto.ru/",
 "https://pastvu.com/", "https://undsci.berkeley.edu/", "https://callingbullshit.org/",
 "https://artsandculture.google.com/", "https://musicmap.info/", "https://ioling.org/problems/",
 "https://wals.info/", "https://ruscorpora.ru/", "https://explorabl.es/", "https://shir-man.com/",
 "https://seeing-theory.brown.edu/", "https://jackschaedler.github.io/circles-sines-signals/",
 "https://forrt.org/reversals/", "https://books.core-econ.org/", "https://learn.mruniversity.com/",
}

TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
  ["a","b","v","g","d","e","e","zh","z","i","y","k","l","m","n","o","p","r","s","t","u","f","h","ts","ch","sh","sch","","y","","e","yu","ya"]))
def slug(s):
    s = s.lower()
    s = "".join(TR.get(c, c) for c in s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:40].strip("-")

def lang_of(desc):
    m = re.search(r"\((?:преимущественно |частично )?(англ|рус)", desc)
    return {"англ": "en", "рус": "ru"}.get(m.group(1), "") if m else ""

sections, sources, seen_ids = [], [], set()
sec = None
for line in open(MD, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.startswith("## "):
        sec = line[3:].strip()
        if "Случайн" in sec:
            sec = None
            continue
        sections.append(sec)
        continue
    if sec and line.startswith("- "):
        m = re.match(r"- (?:🆕 )?\[([^\]]+)\]\(([^)]+)\)(.*)", line)
        if not m:
            continue
        name, url, desc = m.group(1), m.group(2), m.group(3)
        sid = slug(name.split(" — ")[0].strip("«»")) or slug(url)
        base = sid; i = 2
        while sid in seen_ids:
            sid = f"{base}-{i}"; i += 1
        seen_ids.add(sid)
        src = {"id": sid, "name": name, "section": sec, "url": url, "lang": lang_of(desc)}
        if url in REFERENCE:
            src["mode"] = "reference"
        elif url in FEEDS:
            src["feeds"] = [FEEDS[url]]
        else:
            src["mode"] = "auto"
            if url in HINTS:
                src["feed_hint"] = HINTS[url]
        sources.append(src)

used = {u for u in list(FEEDS) + list(HINTS) + list(REFERENCE)}
missing = used - {s["url"] for s in sources}
assert not missing, missing

palette = ["#d97757", "#6a9bcc", "#788c5d", "#c9a273"]
doc = {
  "sections": [{"id": slug(s), "name": s, "color": palette[i % 4]} for i, s in enumerate(sections)],
  "sources": sources,
}
header = """# Источники дашборда «Сайты для познания».
#
# Поля источника:
#   id        — короткий латинский идентификатор (не меняйте после первого запуска)
#   name      — название, как в подборке
#   section   — раздел (должен совпадать с одним из sections.name)
#   url       — адрес сайта
#   lang      — ru / en
#   feeds     — список RSS/Atom-лент (проверены 17.10.2026)
#   mode      — auto: сборщик сам ищет ленту, карту сайта или разбирает страницу
#               reference: справочник, новых постов нет, только ссылка на дашборде
#   feed_hint — предполагаемая лента для режима auto (пробуется первой)
#   telegram  — имя публичного Telegram-канала (без @), чтобы брать посты оттуда
#   html      — свои CSS-селекторы для разбора страницы: {item: ..., link: ..., title: ...}
#
"""
with open(OUT, "w", encoding="utf-8") as f:
    f.write(header)
    yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False, width=1000)
modes = {}
for s in sources:
    k = s.get("mode", "feed"); modes[k] = modes.get(k, 0) + 1
print(len(sections), "разделов;", len(sources), "источников;", modes,
      "; с подсказкой:", sum('feed_hint' in s for s in sources))
