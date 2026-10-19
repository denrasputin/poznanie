"""Одинаковые новости с разных сайтов и «похожие статьи» — простым сравнением слов, без внешних сервисов.

Слова приводятся к «основе» грубо: русские — по первым шести буквам («сознание», «сознания» и «сознанию»
совпадают), английские — без окончаний (machines → machin, washing → wash, но Washington → washing).
Для склейки новостей и подбора статей на одну тему этого хватает.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

WORD = re.compile(r"[a-zа-я0-9]+")
STEM = 6

STOP = set("""
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня
еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там
потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже
себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее
сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про
всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им
более всегда конечно всю между это как почему также который которые которая которых свой своих своей своего
очень год года году лет новый новые новая новое новых весь вся всё всем главное
the a an and or but if of to in on at by for with from as is are was were be been being it its this that these
those there their they them he she his her you your we our not no nor so than then too very can could will would
should may might must do does did done has have had having what which who whom whose why how when where all any
both each few more most other some such only own same about into over after before between through during
without within under again further once here new how why what s t just also us one two three
thing things right now like make makes way ways really get gets got say says said many much even still every
first last year years time times day days part best good great big little back
""".split())


EN_SUFFIXES = ("ations", "ation", "ingly", "ings", "ing", "edly", "ies", "ied", "ers", "er", "ed", "es", "ly", "s")


def stem(w: str) -> str:
    if not w.isascii():
        return w[:STEM]
    for suf in EN_SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            w = w[: -len(suf)]
            break
    if len(w) > 3 and w[-1] in "ey":
        w = w[:-1]
    return w[:STEM + 1]


def tokens(text: str) -> list[str]:
    out = []
    for w in WORD.findall((text or "").lower().replace("ё", "е")):
        if len(w) < 3 or w in STOP or w.isdigit():
            continue
        out.append(stem(w))
    return out


def duplicates(posts: list[dict], hours: float = 48, min_shared: int = 3, min_jaccard: float = 0.4) -> dict:
    """Одна новость на разных сайтах. posts: {i, s, t, ts}; ts — секунды.
    Возвращает {id повтора: id самой ранней записи этой новости}."""
    items = sorted(posts, key=lambda p: p["ts"])
    words = [set(tokens(p["t"])) for p in items]
    parent = list(range(len(items)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    index: dict[str, list[int]] = defaultdict(list)
    for j, p in enumerate(items):
        shared: Counter = Counter()
        for w in words[j]:
            for i in index[w]:
                shared[i] += 1
        for i, n in shared.items():
            if n < min_shared or items[i]["s"] == p["s"] or p["ts"] - items[i]["ts"] > hours * 3600:
                continue
            if n / len(words[i] | words[j]) >= min_jaccard:
                parent[root(j)] = root(i)
        for w in words[j]:
            index[w].append(j)
    return {items[j]["i"]: items[root(j)]["i"] for j in range(len(items)) if root(j) != j}


class Related:
    """Похожие статьи по всему архиву: вес слова — TF-IDF, сходство — косинус.
    Заголовок весит вдвое больше анонса."""

    def __init__(self, corpus: list[dict]):
        self.corpus = corpus
        self.vecs = [self._tf(d["title"], d.get("summary", "")) for d in corpus]
        df: Counter = Counter()
        for v in self.vecs:
            df.update(v.keys())
        n = max(len(corpus), 1)
        self.idf = {w: math.log(n / c) for w, c in df.items()}
        self.common = {w for w, c in df.items() if c > max(n * 0.05, 30)}   # слишком частые слова не сравниваем
        self.index: dict[str, list[tuple[int, float]]] = defaultdict(list)
        for i, v in enumerate(self.vecs):
            w = self._weigh(v)
            self.vecs[i] = w
            for t, x in w.items():
                if t not in self.common:
                    self.index[t].append((i, x))

    @staticmethod
    def _tf(title: str, summary: str) -> Counter:
        tf: Counter = Counter()
        for t in tokens(title):
            tf[t] += 2
        for t in tokens(summary):
            tf[t] += 1
        return tf

    def _weigh(self, tf: Counter) -> dict[str, float]:
        w = {t: (1 + math.log(c)) * self.idf.get(t, 0.0) for t, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in w.values())) or 1.0
        return {t: x / norm for t, x in w.items() if x > 0}

    def find(self, title: str, summary: str = "", skip_urls: set[str] = frozenset(), k: int = 3,
             min_score: float = 0.22, min_shared: int = 2, per_source: int = 2) -> list[int]:
        """Индексы в corpus самых похожих статей: хотя бы два общих значимых слова, не больше двух с одного сайта."""
        q = self._weigh(self._tf(title, summary))
        scores: Counter = Counter()
        shared: Counter = Counter()
        for t, x in q.items():
            for i, y in self.index.get(t, ()):
                scores[i] += x * y
                shared[i] += 1
        key = title_key(title)
        out, seen_keys, per = [], {key}, Counter()
        for i, score in scores.most_common():
            if score < min_score or len(out) >= k:
                break
            d = self.corpus[i]
            tk = title_key(d["title"])
            if (shared[i] < min_shared or d["url"] in skip_urls or tk in seen_keys
                    or per[d["source"]] >= per_source):
                continue
            seen_keys.add(tk)
            per[d["source"]] += 1
            out.append(i)
        return out


def title_key(title: str) -> str:
    return re.sub(r"\W+", "", (title or "").lower())[:80]
