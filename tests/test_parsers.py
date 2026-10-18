from datetime import timedelta

from collector.methods import discover, feed, page, sitemap, telegram
from collector.util import item_id, normalize_url, now_utc, truncate
from tests.fakes import fx


def test_normalize_strips_tracking_and_www():
    a = normalize_url("http://www.Site.ru/path/?utm_source=x&id=5#top")
    assert a == "https://site.ru/path?id=5"
    assert item_id("https://site.ru/path?id=5&utm_medium=y") == item_id("http://www.site.ru/path/?id=5")


def test_truncate_on_word_boundary():
    assert truncate("слово " * 100, 20).endswith("…")
    assert len(truncate("слово " * 100, 20)) <= 21


def test_rss_and_atom():
    items = feed.parse_feed(fx("feed.rss"), "https://rss.example/feed")
    assert [i["title"] for i in items] == ["Тестовая статья один", "Тестовая статья два"]
    assert items[0]["summary"] == "Первый анонс статьи."
    assert items[0]["published"].isoformat().startswith("2026-10-17T09:00")
    atom = feed.parse_feed(fx("feed.atom"), "https://atom.example/")
    assert atom[0]["url"] == "https://atom.example/a1" and atom[0]["summary"] == "Short"


def test_html_is_not_a_feed():
    assert not feed.looks_like_feed(fx("discover.html"))
    assert feed.looks_like_feed(fx("feed.rss"))


def test_discovery_skips_comment_feeds():
    assert discover.feed_links(fx("discover.html"), "https://d.example/") == ["https://d.example/feed/"]


def test_sitemap_index_and_recent(monkeypatch):
    pages, children = sitemap.parse(fx("sitemap_index.xml"))
    assert not pages and sitemap.pick_children(children)[0].endswith("sitemap-posts.xml")
    pages, _ = sitemap.parse(fx("sitemap_posts.xml"))
    fresh = sitemap.recent(pages, days=36500)
    assert fresh[0]["loc"].endswith("kak-ustroeno-pervoe")
    assert len(sitemap.recent(pages, days=1)) <= 1


def test_harvest_heuristic():
    items = page.harvest(fx("listing.html"), "https://list.example/news/")
    urls = [i["url"] for i in items]
    assert urls == [
        "https://list.example/2026/10/pervaya-testovaya-zametka-o-knigah",
        "https://list.example/2026/10/vtoraya-testovaya-zametka-o-kino",
        "https://list.example/materials/12345",
    ]
    assert items[0]["title"] == "Первая тестовая заметка о книгах"


def test_harvest_with_selectors():
    items = page.harvest(fx("listing.html"), "https://list.example/", {"item": "article", "title": "h2"})
    assert len(items) == 3


def test_meta():
    m = page.meta(fx("article.html"))
    assert m["title"].startswith("Как устроено первое")
    assert m["published"].isoformat().startswith("2026-10-17T05:00")


def test_telegram():
    items = telegram.parse(fx("telegram.html"), "testchan", "https://site.example/")
    assert items[0]["url"] == "https://site.example/news/tg-statya"
    assert items[0]["title"] == "Заголовок поста в канале"
    assert "Подробности" in items[0]["summary"]
    assert items[1]["url"] == "https://t.me/testchan/102"
