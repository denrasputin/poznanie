"""Склейка одинаковых новостей и «похожие статьи»."""
from dashboard.similar import Related, duplicates, tokens


def test_tokens_stem_words():
    assert tokens("Сознание, сознания и сознанию") == ["сознан"] * 3
    assert tokens("Washing machines") == ["wash", "machin"]
    assert tokens("Washington") == ["washing"]          # не путаем со стиркой


def test_same_story_from_two_sites_is_glued():
    hour = 3600
    posts = [
        {"i": "a", "s": "vc", "t": "ФАС признала недостоверной рекламу «режима 5G» у «Мегафона»", "ts": 10 * hour},
        {"i": "b", "s": "kod", "t": "ФАС признала рекламу МегаФона о 5G недостоверной", "ts": 11 * hour},
        {"i": "d", "s": "nplus", "t": "ФАС признала рекламу МегаФона о 5G недостоверной", "ts": 200 * hour},  # через неделю
        {"i": "e", "s": "nplus", "t": "Учёные измерили рассеяние радиоволн у галактической перемычки", "ts": 11 * hour},
    ]
    assert duplicates(posts) == {"b": "a"}
    same_site = [{"i": "x", "s": "vc", "t": "ФАС признала рекламу Мегафона недостоверной", "ts": 0},
                 {"i": "y", "s": "vc", "t": "ФАС признала рекламу Мегафона недостоверной: подробности", "ts": hour}]
    assert duplicates(same_site) == {}                    # два поста одного сайта — не повтор новости


def test_related_needs_two_shared_words():
    corpus = [
        {"url": "u1", "title": "Miranda Fricker on Epistemic Injustice", "summary": "testimony and credibility", "source": "pb"},
        {"url": "u2", "title": "Washington and the American Revolution", "summary": "", "source": "iot"},
        {"url": "u3", "title": "Epistemic injustice and testimony in courts", "summary": "credibility deficits", "source": "aeon"},
        {"url": "u4", "title": "Why washing machines took decades", "summary": "", "source": "jstor"},
    ] + [{"url": f"z{i}", "title": f"Unrelated topic number {i} about gardens", "summary": "", "source": "x"} for i in range(30)]
    rel = Related(corpus)
    assert rel.find("Miranda Fricker on Blame and epistemic injustice", "testimony", skip_urls={"u1"}) == [2]
    assert rel.find("Why Washing Machines Took Decades to Catch On", skip_urls={"u4"}) == []
