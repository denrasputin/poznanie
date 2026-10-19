"use strict";
(() => {
  const PAGE = 100;
  const DAY = 86400000;
  const SESSION_GAP = 30 * 60e3;        // перерыв дольше получаса — новый визит (для метки «новое»)
  const CHATTY = 4;                     // столько постов одного сайта за день и больше — сайт сворачивается в одну строку
  const FIREHOSE = 2;                   // в среднем столько постов в день и больше — новостной сайт, не для «Главного»
  const LATE_HOURS = 8;                 // сбор раз в 3 часа + запас на задержки GitHub
  const PERIODS = [["1", "24 ч"], ["3", "3 дня"], ["7", "7 дней"], ["30", "30 дней"]];
  const PERIOD_TEXT = { 1: "за сутки", 3: "за 3 дня", 7: "за 7 дней", 30: "за 30 дней" };
  const LANGS = [["all", "Все"], ["ru", "Русские"], ["en", "Английские"]];
  const DENSITY = [["full", "С анонсами"], ["dense", "Только заголовки"]];
  const THEMES = [["auto", "Как в системе"], ["light", "Светлая"], ["dark", "Тёмная"]];
  const FEED_ORDER = [["smart", "Сначала интересное"], ["time", "Строго по времени"]];
  const SWIPE_RIGHT = [["open", "Открывает статью"], ["queue", "Кладёт в очередь"]];
  const DECK_MODES = [["order", "По порядку"], ["shuffle", "Вперемешку"]];
  const EXAMPLES = ["стоицизм", "память", "Византия", "сознание", "Достоевский", "искусственный интеллект", "климат", "Платон"];
  const METHOD = { rss: "RSS-лента", sitemap: "карта сайта", page: "страница сайта", auto: "ищет способ", reference: "справочник", pending: "—" };
  const STATUS = {
    ok: "Работает", stale: "Давно без постов", blocked: "Не пускает сборщик", limited: "Временно ограничил доступ",
    error: "Не работает", pending: "Ещё не проверялся", reference: "Справочник",
  };
  const PROBLEM = ["error", "blocked", "limited", "pending"];
  const TABS = ["feed", "saved", "search", "more"];
  const SAVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.5L7 20z"/></svg>';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("pz:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pz:" + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
    del(k) { try { localStorage.removeItem("pz:" + k); } catch { /* нет доступа */ } },
  };
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;            // только для своих SVG-иконок
      else if (k === "style") el.setAttribute("style", v);
      else if (k === "href") el.setAttribute("href", safeUrl(v));
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const extLink = (href, attrs, ...kids) => h("a", { href, target: "_blank", rel: "noopener", ...attrs }, ...kids);

  function plural(n, forms) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }
  const fmtN = (n) => n.toLocaleString("ru-RU");
  const nPosts = (n) => `${fmtN(n)} ${plural(n, ["пост", "поста", "постов"])}`;
  const fmtTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long" });
  const fmtShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  const fmtShortYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  const fmtWd = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
  const dayKey = (d) => new Date(d).toLocaleDateString("sv-SE");
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  function relative(iso, now = Date.now()) {
    if (!iso) return "—";
    const d = new Date(iso), diff = now - d;
    if (diff < 60e3) return "только что";
    if (diff < 3600e3) return `${Math.round(diff / 60e3)} мин назад`;
    if (diff < DAY) return `${Math.round(diff / 3600e3)} ч назад`;
    if (diff < 30 * DAY) { const dd = Math.round(diff / DAY); return `${dd} ${plural(dd, ["день", "дня", "дней"])} назад`; }
    return (d.getFullYear() === new Date(now).getFullYear() ? fmtShort : fmtShortYear).format(d);
  }

  // значок сайта: свой файл из fav/; если его нет или он не открылся — значок от Google;
  // первая буква названия — только на самый крайний случай
  const googleIcon = (host) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  function favicon(src, cls = "fav") {
    const letter = () => h("span", { class: "fav-letter", "aria-hidden": "true", text: ((src.name || "").replace(/^[«"]/, "")[0] || "?").toUpperCase() });
    const urls = [src.icon, src.host ? googleIcon(src.host) : null].filter(Boolean);
    if (!urls.length) return letter();
    const img = h("img", { class: cls, alt: "", loading: "lazy", width: 22, height: 22, referrerpolicy: "no-referrer", src: urls.shift() });
    img.addEventListener("error", () => { if (urls.length) img.src = urls.shift(); else img.replaceWith(letter()); });
    return img;
  }

  let toastTimer;
  function toast(text) {
    const el = $("toast");
    el.textContent = text; el.hidden = false;
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function openDialog(id) {
    const dlg = $(id);
    if (dlg.open) return;
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  // ---------- состояние ----------
  const S = {
    meta: null, sources: [], posts: [], srcById: new Map(), secById: new Map(), secOfSrc: new Map(), secIdx: new Map(),
    freq: new Map(), olderLoaded: false, olderLoading: false,
    sections: new Set(store.get("sections", [])),
    period: store.get("period", "7"),
    lang: store.get("lang", "all"),
    muted: new Set(store.get("muted", [])),
    tab: store.get("tab", "feed"),
    theme: store.get("theme", "auto"),
    dense: store.get("dense", false),
    hideRead: store.get("hideRead", false),
    feedOrder: store.get("feedOrder", "smart"),
    swipeRight: store.get("swipeRight", "open"),
    deckMode: store.get("deckMode", "order"),
    hintDone: store.get("hintDone", false),
    shown: PAGE, expanded: new Set(), prevVisit: null, now: Date.now(),
    catSec: "", catKind: "all",
  };
  if (S.tab === "archive") S.tab = "search";
  if (["refs", "sources"].includes(S.tab)) S.tab = "more";
  if (!TABS.includes(S.tab)) S.tab = "feed";

  // ---------- метка «новое»: всё, что вышло после конца прошлого визита ----------
  function startVisit() {
    const now = Date.now();
    const last = store.get("lastActive", store.get("lastVisit", null));
    let prev = store.get("prevVisit", null);
    if (!last || now - Date.parse(last) > SESSION_GAP) prev = last;    // перезагрузка внутри визита ничего не сбрасывает
    store.set("prevVisit", prev);
    store.del("lastVisit");
    touchVisit();
    S.prevVisit = prev ? Date.parse(prev) : null;
  }
  const touchVisit = () => store.set("lastActive", new Date().toISOString());

  function readHash() {
    const m = location.hash.match(/^#s=([\w,-]*)$/);
    if (m) S.sections = new Set(m[1].split(",").filter(Boolean));
  }
  function save() {
    store.set("sections", [...S.sections]); store.set("period", S.period); store.set("lang", S.lang);
    store.set("muted", [...S.muted]); store.set("tab", S.tab); store.set("theme", S.theme);
    store.set("dense", S.dense); store.set("hideRead", S.hideRead); store.set("feedOrder", S.feedOrder);
    store.set("swipeRight", S.swipeRight); store.set("deckMode", S.deckMode); store.set("hintDone", S.hintDone);
    const hash = S.sections.size ? "#s=" + [...S.sections].join(",") : "";
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

  function applyTheme() {
    if (S.theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", S.theme);
  }

  // ---------- интересы: что вы открываете, откладываете и пролистываете (хранится только в браузере) ----------
  const Interest = {
    data: store.get("interest", {}),
    add(src, kind) {
      if (!src) return;
      const x = this.data[src] || (this.data[src] = { p: 0, n: 0 });
      if (kind === "skip") x.n += 1; else x.p += kind === "save" ? 1.5 : 1;
      store.set("interest", this.data);
    },
    // 1 — нейтрально; от 0,5 (всё время пролистываете) до 1,5 (часто открываете)
    weight(src) { const x = this.data[src]; return x ? 0.5 + (x.p + 1) / (x.p + 0.5 * x.n + 2) : 1; },
    actions() { return Object.values(this.data).reduce((a, x) => a + x.p + x.n, 0); },
    reset() { this.data = {}; store.del("interest"); },
  };

  // ---------- фильтры ----------
  function baseFilter() {
    return (p) => {
      if (S.muted.has(p.s)) return false;
      const src = S.srcById.get(p.s);
      if (!src) return false;
      return S.lang === "all" || src.lang === S.lang;
    };
  }
  const inSections = (srcId) => !S.sections.size || S.sections.has(S.secOfSrc.get(srcId));
  const sinceMs = () => S.now - Number(S.period) * DAY;
  const secColor = (secId) => `--c: var(--s${(S.secIdx.get(secId) ?? 8) % 9})`;
  const isDefaultFilters = () => !S.sections.size && S.period === "7" && S.lang === "all" && !S.dense;
  function feedPosts() {
    const base = baseFilter(), since = sinceMs();
    return S.posts.filter((p) => p.ts >= since && base(p) && inSections(p.s));
  }
  function filterText({ withView = true } = {}) {
    const names = [...S.sections].map((id) => S.secById.get(id)?.name).filter(Boolean);
    const parts = [names.length === 0 ? "Все разделы" : names.length <= 2 ? names.join(", ")
      : `${names.length} ${plural(names.length, ["раздел", "раздела", "разделов"])}`, PERIOD_TEXT[S.period]];
    if (S.lang !== "all") parts.push(S.lang === "ru" ? "только русские" : "только английские");
    if (withView && S.dense) parts.push("только заголовки");
    return parts.join(" · ");
  }
  function resetFilters() {
    S.sections.clear(); S.period = "7"; S.lang = "all"; S.dense = false;
    changed();
  }
  function changed() {
    S.shown = PAGE; S.expanded.clear(); save();
    renderStatus(); renderFilterBar(); renderFeed();
    if ($("filters").open) renderFilterSheet();
    if ($("pulse-panel").open) renderPulse();
  }

  // одна новость с нескольких сайтов: показываем одну запись, остальные — «и ещё в N источниках»
  function groupStories(list) {
    const groups = new Map();
    for (const p of list) {
      const k = p.dup || p.i;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const also = new Map(), hidden = new Set();
    for (const [k, ms] of groups) {
      if (ms.length < 2) continue;
      const main = ms.find((m) => m.i === k) || ms[ms.length - 1];   // самая ранняя запись — обычно первоисточник
      const rest = ms.filter((m) => m !== main);
      also.set(main.i, rest);
      rest.forEach((m) => hidden.add(m.i));
    }
    return { also, hidden };
  }

  // ---------- строка состояния: одна цифра ----------
  function renderStatus() {
    const base = baseFilter();
    const scoped = S.posts.filter((p) => !p.k && base(p) && inSections(p.s));
    const kids = [];
    if (S.prevVisit && S.now - S.prevVisit > DAY / 24) {
      const n = scoped.filter((p) => p.ts > S.prevVisit).length;
      kids.push(h("b", { text: fmtN(n) }), ` ${plural(n, ["новый пост", "новых поста", "новых постов"])} с прошлого визита`);
    } else {
      const n = scoped.filter((p) => S.now - p.ts <= DAY).length;
      kids.push(h("b", { text: fmtN(n) }), ` ${plural(n, ["новый пост", "новых поста", "новых постов"])} за сутки`);
    }
    const last = S.meta.last_run;
    if (last) {
      const late = S.now - Date.parse(last) > LATE_HOURS * 3600e3;
      kids.push(" · ", h("span", { class: late ? "late" : null, title: new Date(last).toLocaleString("ru-RU"),
        text: `обновлено ${relative(last, S.now)}${late ? " — сборщик задерживается" : ""}` }));
    } else {
      kids.push(" · сборщик ещё не запускался");
    }
    $("status").replaceChildren(...kids);
  }

  // ---------- фильтры: строка-сводка над лентой и панель ----------
  function renderFilterBar() {
    const kids = [h("span", { class: isDefaultFilters() ? null : "on", text: filterText() })];
    if (!isDefaultFilters()) kids.push(" · ", h("button", { type: "button", class: "link-btn", onclick: resetFilters }, "сбросить"));
    $("filter-sum").replaceChildren(...kids);
    const n = (S.sections.size ? 1 : 0) + (S.period !== "7" ? 1 : 0) + (S.lang !== "all" ? 1 : 0) + (S.dense ? 1 : 0);
    $("filter-count").hidden = !n;
    $("filter-count").textContent = n;
    $("filter-btn").setAttribute("aria-label", n ? `Фильтры: включено ${n}` : "Фильтры");
  }

  function renderSeg(id, options, value, onPick) {
    $(id).replaceChildren(...options.map(([v, label]) => h("button", {
      type: "button", role: "radio", "aria-checked": String(v === value),
      onclick: () => { if (v !== value) onPick(v); },
    }, label)));
  }

  function sectionChips(el, selected, onToggle, allLabel = "Все разделы") {
    const all = h("button", { type: "button", class: "chip", "aria-pressed": String(!selected.size), onclick: () => onToggle(null) }, allLabel);
    el.replaceChildren(all, ...S.meta.sections.map((sec) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(selected.has(sec.id)), title: `УДК ${sec.udc}`,
      onclick: () => onToggle(sec.id) }, h("i", { class: "dot", style: secColor(sec.id) }), sec.name)));
  }

  function renderFilterSheet() {
    sectionChips($("chips"), S.sections, (id) => {
      if (id === null) S.sections.clear(); else if (S.sections.has(id)) S.sections.delete(id); else S.sections.add(id);
      changed();
    });
    renderSeg("period", PERIODS, S.period, (v) => { S.period = v; changed(); });
    renderSeg("lang", LANGS, S.lang, (v) => { S.lang = v; changed(); });
    renderSeg("density", DENSITY, S.dense ? "dense" : "full", (v) => { S.dense = v === "dense"; changed(); });
    const n = feedPosts().length;
    $("filters-n").textContent = n ? nPosts(n) : "";
    $("filters-reset").hidden = isDefaultFilters();
  }

  // ---------- «Главное»: редкие и обстоятельные материалы за сутки ----------
  function pickHero(dated) {
    const recent = dated.filter((p) => S.now - p.ts <= 36 * 3600e3 && (p.m || "").length > 60);
    const scored = recent.map((p) => {
      const perDay = (S.freq.get(p.s) || 1) / 14;
      if (perDay >= FIREHOSE) return null;
      const fresh = S.now - p.ts <= DAY ? 1 : 0.7;
      return [p, fresh * Interest.weight(p.s) / Math.sqrt(perDay * 14)];
    }).filter(Boolean).sort((a, b) => b[1] - a[1]);
    const out = [], secs = new Set(), srcs = new Set();
    for (const [p] of scored) {
      const sec = S.secOfSrc.get(p.s);
      if (secs.has(sec) || srcs.has(p.s)) continue;
      out.push(p); secs.add(sec); srcs.add(p.s);
      if (out.length === 3) break;
    }
    return out;
  }

  function heroCard(p) {
    const src = S.srcById.get(p.s);
    return h("article", { class: "hero-card", style: secColor(S.secOfSrc.get(p.s)) },
      h("div", { class: "entry-meta" }, favicon(src), h("span", { class: "src", text: src.name }),
        h("span", { class: "sep", "aria-hidden": "true" }), h("time", { datetime: p.d }, relative(p.d, S.now))),
      h("h3", {}, extLink(p.u, { text: p.t, "data-src": p.s })),
      p.m ? h("p", { text: p.m }) : null,
      saveButton(p));
  }

  // внутри дня: сайты, которые вы чаще открываете, — выше (грубыми ступенями, чтобы лента не прыгала)
  function orderDay(items) {
    if (S.feedOrder !== "smart") return items;
    const step = (p) => Math.round(Interest.weight(p.s) * 2);
    return items.map((p, i) => [p, i]).sort((a, b) => step(b[0]) - step(a[0]) || a[1] - b[1]).map((x) => x[0]);
  }

  // ---------- лента ----------
  function renderFeed() {
    const list = feedPosts();
    const feed = $("feed");
    feed.removeAttribute("aria-busy");
    feed.classList.toggle("dense", S.dense);

    if (S.period === "30" && !S.olderLoaded) {
      loadOlder();
      if (S.olderLoading) { feed.replaceChildren(h("p", { class: "note", text: "Загружаю посты за месяц…" })); $("hero").replaceChildren(); }
    }
    if (!list.length) {
      $("hero").replaceChildren();
      if (S.period === "30" && S.olderLoading) return;
      const never = !S.meta.last_run;
      feed.replaceChildren(h("div", { class: "empty-state" },
        h("strong", { text: never ? "Постов пока нет" : "Ничего не нашлось" }),
        never ? "Сборщик ещё не запускался. Откройте вкладку Actions в репозитории и запустите «Сбор постов»."
          : "За выбранный период в этих разделах ничего не вышло.",
        never ? null : h("div", {}, h("button", { type: "button", class: "btn small", onclick: resetFilters }, "Сбросить фильтры"))));
      $("more").hidden = true;
      return;
    }

    const allDated = list.filter((p) => !p.k);
    const { also, hidden } = groupStories(allDated);
    const visible = allDated.filter((p) => !hidden.has(p.i));
    const hero = pickHero(visible);
    const heroIds = new Set(hero.map((p) => p.i));
    $("hero").replaceChildren(...(hero.length ? [h("section", { class: "hero", "aria-label": "Главное за сутки" },
      h("p", { class: "kicker", text: "Главное" }), h("div", { class: "hero-grid" }, hero.map(heroCard)))] : []));

    const dated = visible.filter((p) => !heroIds.has(p.i));
    const undated = list.filter((p) => p.k);
    const shown = dated.slice(0, S.shown);
    const allShown = shown.length === dated.length;
    const groups = new Map();
    for (const p of shown) {
      if (!groups.has(p.day)) groups.set(p.day, []);
      groups.get(p.day).push(p);
    }
    const todayK = dayKey(S.now), yestK = dayKey(S.now - DAY);
    const days = [...groups.keys()].sort().reverse();
    const kids = days.map((k) => {
      const label = k === todayK ? "Сегодня" : k === yestK ? "Вчера" : fmtDay.format(new Date(k + "T12:00"));
      return h("section", { class: "day" },
        h("header", { class: "day-head" }, h("h2", { text: label })),
        dayEntries(k, orderDay(groups.get(k)), also));
    });
    if (allShown && undated.length) kids.push(undatedBlock(undated));
    feed.replaceChildren(...kids);
    $("more").hidden = allShown;
    $("more").textContent = `Показать ещё (${fmtN(dated.length - shown.length)})`;
  }

  // «болтливый» сайт: много постов за день — одной строкой, раскрывается по нажатию
  function dayEntries(k, items, also) {
    const per = new Map();
    for (const p of items) per.set(p.s, (per.get(p.s) || 0) + 1);
    const done = new Set(), out = [];
    for (const p of items) {
      const n = per.get(p.s);
      if (n < CHATTY) { out.push(entry(p, also.get(p.i))); continue; }
      if (done.has(p.s)) continue;
      done.add(p.s);
      const key = `chatty|${k}|${p.s}`;
      const src = S.srcById.get(p.s);
      const mine = items.filter((x) => x.s === p.s);
      const toggle = () => { S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key); renderFeed(); };
      if (S.expanded.has(key)) {
        out.push(h("div", { class: "chatty-group" }, mine.map((x) => entry(x, also.get(x.i))),
          h("button", { type: "button", class: "chatty-fold", onclick: toggle }, `Свернуть ${src.name}`)));
      } else {
        out.push(h("button", { type: "button", class: "chatty", "aria-expanded": "false", onclick: toggle },
          favicon(src), h("span", {}, h("b", { text: src.name }), ` — ${nPosts(n)} за день`),
          h("span", { class: "chatty-n" }, "показать")));
      }
    }
    return out;
  }

  function undatedBlock(items) {
    const open = S.expanded.has("undated");
    const btn = h("button", { type: "button", class: "undated-btn", "aria-expanded": String(open),
      onclick: () => { open ? S.expanded.delete("undated") : S.expanded.add("undated"); renderFeed(); } },
    open ? "Скрыть материалы без даты"
      : `Ещё ${fmtN(items.length)} ${plural(items.length, ["материал", "материала", "материалов"])} без точной даты — показать`);
    return h("div", { class: "undated" }, btn, open ? items.map((p) => entry(p)) : null);
  }

  function entry(p, also) {
    const src = S.srcById.get(p.s);
    const secId = S.secOfSrc.get(p.s);
    const sec = S.secById.get(secId);
    const isNew = !p.k && S.prevVisit && p.ts > S.prevVisit;
    const time = p.k
      ? h("span", { title: "У источника нет даты публикации: это время, когда сборщик нашёл материал" }, "найдено " + fmtTime.format(p.ts))
      : h("time", { datetime: p.d }, fmtTime.format(p.ts));
    const body = h("div", { class: "entry-body" },
      h("div", { class: "entry-meta" },
        h("i", { class: "dot", style: secColor(secId), title: sec ? sec.name : "" }),
        h("span", { class: "src", title: src.about || "", text: src.name }),
        h("span", { class: "sep", "aria-hidden": "true" }), time,
        src.lang ? h("span", { class: "sep", "aria-hidden": "true" }) : null,
        src.lang ? h("span", { class: "lang", text: src.lang.toUpperCase() }) : null,
        isNew ? h("span", { class: "new", text: "новое" }) : null),
      h("h3", {}, extLink(p.u, { text: p.t, "data-src": p.s })),
      p.m ? h("p", { text: p.m }) : null);
    const extra = [];
    if (also && also.length) {
      extra.push(subToggle(`и ещё в ${also.length} ${plural(also.length, ["источнике", "источниках", "источниках"])}`,
        () => Promise.resolve(also.map((x) => [x.t, x.u, x.s, x.d]))));
    }
    if (p.r) extra.push(subToggle("ещё на эту тему", () => Related.get(p.i)));
    if (extra.length) body.append(h("div", { class: "entry-extra" }, extra));
    return h("article", { class: "entry" + (isNew ? " is-new" : "") }, favicon(src), body, saveButton(p));
  }

  // раскрывающийся список под статьёй: «и ещё в N источниках», «ещё на эту тему»
  function subToggle(label, load) {
    const btn = h("button", { type: "button", class: "mini-link", "aria-expanded": "false" }, label);
    btn.addEventListener("click", async () => {
      const box = btn.closest(".entry-body, .card-foot");
      const open = btn.getAttribute("aria-expanded") === "true";
      box.querySelectorAll(".sublist").forEach((x) => x.remove());
      box.querySelectorAll(".mini-link").forEach((b) => b.setAttribute("aria-expanded", "false"));
      if (open) return;
      btn.setAttribute("aria-expanded", "true");
      const list = h("ul", { class: "sublist" }, h("li", { class: "note", text: "Загружаю…" }));
      box.append(list);
      const items = await load();
      list.replaceChildren(...(items && items.length ? items.map(([t, u, s, d]) => {
        const src = S.srcById.get(s);
        return h("li", {}, extLink(u, { text: t, "data-src": s }),
          h("small", { text: [src ? src.name : "", d ? fmtShortYear.format(new Date(d)) : ""].filter(Boolean).join(" · ") }));
      }) : [h("li", { class: "note", text: "Похожих статей не нашлось" })]));
    });
    return btn;
  }

  const Related = {
    data: null, loading: null,
    async get(id) {
      this.loading ||= getJSON("related").then((d) => { this.data = d; }).catch(() => { this.data = {}; });
      await this.loading;
      return this.data[id] || [];
    },
  };

  function saveButton(p) {
    const on = Saved.has(p.i);
    return h("button", { type: "button", class: "save", "data-id": p.i, "aria-pressed": String(on), html: SAVE_ICON,
      "aria-label": on ? "Убрать из закладок" : "В закладки", title: on ? "Убрать из закладок" : "В закладки",
      onclick: (e) => {
        const adding = !Saved.has(p.i);
        Saved.toggle(p);
        if (adding) Interest.add(p.s, "save");
        const b = e.currentTarget;
        b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
        refreshSaveButtons(); renderSaved();
      } });
  }
  function refreshSaveButtons() {
    for (const b of document.querySelectorAll(".save[data-id]")) {
      const on = Saved.has(b.dataset.id);
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", on ? "Убрать из закладок" : "В закладки");
      b.title = b.getAttribute("aria-label");
    }
    const n = Saved.list().filter((x) => !x.read).length;
    $("saved-count").hidden = !n;
    $("saved-count").textContent = n;
  }

  // ---------- первая подсказка ----------
  function renderHint() {
    if (S.hintDone) { $("hint").replaceChildren(); return; }
    const done = () => { S.hintDone = true; save(); renderHint(); };
    $("hint").replaceChildren(h("div", { class: "hint" },
      h("p", { class: "hint-title", text: "Как здесь всё устроено" }),
      h("ol", {},
        h("li", {}, "Выберите разделы — кнопка «Фильтры» над лентой."),
        h("li", {}, "Откладывайте интересное значком закладки справа от статьи."),
        h("li", {}, "Установите сайт на телефон: он будет работать как приложение.")),
      h("div", { class: "hint-actions" },
        h("button", { type: "button", class: "btn small primary", onclick: done }, "Понятно"),
        h("button", { type: "button", class: "link-btn", onclick: () => { done(); openGuide(); } }, "Подробная инструкция"))));
  }
  function openGuide() {
    const live = S.sources.filter((s) => s.status !== "reference").length;
    if (live) $("guide-count").textContent = `${fmtN(live)} ${plural(live, ["сайта", "сайтов", "сайтов"])}`;
    openDialog("guide");
  }

  // ---------- закладки: хранятся в браузере, по желанию синхронизируются через GitHub Gist ----------
  const SYNC_FILE = "poznanie-saved.json";
  const TOMBSTONE_DAYS = 90;
  function normItem(x) {
    return { id: x.id, u: x.u, t: x.t, s: x.s || "", sn: x.sn || "", d: x.d || "", at: x.at || "",
      read: !!x.read, del: !!x.del, upd: Number(x.upd) || 0 };
  }
  function normData(data) {
    const items = {};
    for (const [id, x] of Object.entries((data && data.items) || {})) if (x && x.u && /^https?:\/\//i.test(x.u)) items[id] = normItem({ ...x, id });
    return { v: 1, items };
  }
  const serialize = (data) => JSON.stringify({ v: 1, items: Object.fromEntries(Object.keys(data.items).sort().map((k) => [k, data.items[k]])) });
  function mergeData(a, b) {
    const items = { ...a.items };
    for (const [id, x] of Object.entries(b.items)) if (!items[id] || x.upd > items[id].upd) items[id] = x;
    const border = Date.now() - TOMBSTONE_DAYS * DAY;
    for (const [id, x] of Object.entries(items)) if (x.del && x.upd < border) delete items[id];
    return { v: 1, items };
  }

  const Saved = {
    data: normData(store.get("saved", null)),
    has(id) { const x = this.data.items[id]; return !!x && !x.del; },
    list() { return Object.values(this.data.items).filter((x) => !x.del).sort((a, b) => (a.at < b.at ? 1 : -1)); },
    put(x) { this.data.items[x.id] = normItem({ ...x, upd: Date.now() }); store.set("saved", this.data); Sync.schedule(); },
    toggle(p) {
      if (this.has(p.i)) { this.put({ ...this.data.items[p.i], del: true }); return; }
      const src = S.srcById.get(p.s);
      this.put({ id: p.i, u: p.u, t: p.t, s: p.s, sn: src ? src.name : "", d: p.d, at: new Date().toISOString(), read: false, del: false });
      persistStorage();
    },
    setRead(id, read) { this.put({ ...this.data.items[id], read }); },
    remove(id) { this.put({ ...this.data.items[id], del: true }); },
    replace(data) { this.data = data; store.set("saved", data); },
  };
  // просим браузер не стирать данные сайта при нехватке места
  function persistStorage() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* нет поддержки */ }
  }

  const Sync = {
    token: store.get("ghToken", ""), gist: store.get("gistId", ""), last: store.get("syncAt", null),
    state: "", msg: "", busy: false, again: false, timer: null,
    async api(path, opts = {}) {
      const r = await fetch("https://api.github.com" + path, { ...opts, cache: "no-store", headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
      if (!r.ok) { const e = new Error(`GitHub: HTTP ${r.status}`); e.status = r.status; throw e; }
      return r.status === 204 ? null : r.json();
    },
    async findOrCreate() {
      for (let page = 1; page <= 10; page++) {
        const list = await this.api(`/gists?per_page=100&page=${page}`);
        const g = list.find((x) => x.files && x.files[SYNC_FILE]);
        if (g) return g.id;
        if (list.length < 100) break;
      }
      const g = await this.api("/gists", { method: "POST", body: JSON.stringify({
        description: "Сайты для познания — закладки (синхронизация между устройствами)", public: false,
        files: { [SYNC_FILE]: { content: serialize(Saved.data) } } }) });
      return g.id;
    },
    async readRemote() {
      const g = await this.api(`/gists/${this.gist}`);
      const f = g.files && g.files[SYNC_FILE];
      if (!f) return { v: 1, items: {} };
      const text = f.truncated ? await fetch(f.raw_url, { cache: "no-store" }).then((r) => r.text()) : f.content;
      try { return normData(JSON.parse(text || "{}")); } catch { return { v: 1, items: {} }; }
    },
    async run() {
      if (!this.token) return;
      if (this.busy) { this.again = true; return; }
      this.busy = true; this.setState("busy", "синхронизирую…");
      try {
        if (!this.gist) { this.gist = await this.findOrCreate(); store.set("gistId", this.gist); }
        let remote;
        try { remote = await this.readRemote(); } catch (e) {
          if (e.status !== 404) throw e;
          this.gist = await this.findOrCreate(); store.set("gistId", this.gist);   // gist удалили — найдём или создадим заново
          remote = await this.readRemote();
        }
        const merged = mergeData(Saved.data, remote);
        const text = serialize(merged);
        if (text !== serialize(Saved.data)) { Saved.replace(merged); renderSaved(); refreshSaveButtons(); }
        if (text !== serialize(remote)) {
          await this.api(`/gists/${this.gist}`, { method: "PATCH", body: JSON.stringify({ files: { [SYNC_FILE]: { content: text } } }) });
        }
        this.last = new Date().toISOString(); store.set("syncAt", this.last);
        this.setState("ok", "синхронизировано");
      } catch (e) {
        this.setState("error", e.status === 401 ? "ключ не подходит или отозван"
          : e.status === 403 || e.status === 404 ? "у ключа нет права gist или исчерпан лимит запросов"
            : "нет связи с GitHub — попробую позже");
      } finally {
        this.busy = false;
        if (this.again) { this.again = false; this.schedule(500); }
      }
    },
    schedule(delay = 1500) {
      if (!this.token) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), delay);
    },
    setState(state, msg) { this.state = state; this.msg = msg; renderSyncState(); },
    connect(token) {
      this.token = token.trim(); this.gist = ""; store.set("ghToken", this.token); store.del("gistId");
      renderSync(); renderSaved(); this.run();
    },
    disconnect() {
      this.token = ""; this.gist = ""; this.state = ""; this.last = null;
      store.del("ghToken"); store.del("gistId"); store.del("syncAt"); renderSync(); renderSaved();
    },
  };

  function goSync() {
    setTab("more");
    $("sync").open = true;
    $("sync").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderSaved() {
    const all = Saved.list();
    const items = S.hideRead ? all.filter((x) => !x.read) : all;
    $("hide-read").checked = S.hideRead;
    const exported = store.get("exportAt", null);
    $("saved-note").replaceChildren(...(all.length && !Sync.token ? [h("div", { class: "notice" },
      h("p", { text: "Закладки хранятся только в этом браузере. Safari может стереть их, если долго не заходить на сайт. "
        + (exported ? `Последняя копия — ${relative(exported)}.` : "Копии пока нет.") }),
      h("div", { class: "hint-actions" },
        h("button", { type: "button", class: "btn small", onclick: exportSaved }, "Сохранить копию"),
        h("button", { type: "button", class: "link-btn", onclick: goSync }, "Включить синхронизацию")))] : []));
    if (!items.length) {
      $("saved-list").replaceChildren(h("div", { class: "empty-state" },
        h("strong", { text: all.length ? "Всё прочитано" : "Пока ничего не отложено" }),
        all.length ? "Снимите галочку «Скрыть прочитанное», чтобы увидеть всё." : "Нажмите на значок закладки справа от статьи — она появится здесь и не пропадёт через месяц."));
      return;
    }
    $("saved-list").replaceChildren(h("div", { class: "list" }, items.map((x) => {
      const src = S.srcById.get(x.s) || { name: x.sn || "", icon: null };
      return h("div", { class: "row" + (x.read ? " is-read" : "") },
        favicon(src),
        h("div", { class: "row-main" },
          extLink(x.u, { class: "row-name", text: x.t, "data-src": x.s,
            onclick: () => { if (!x.read) { Saved.setRead(x.id, true); setTimeout(() => { renderSaved(); refreshSaveButtons(); }, 300); } } }),
          h("div", { class: "row-facts" },
            h("span", { text: src.name }),
            x.d ? h("span", { text: `вышло ${relative(x.d)}` }) : null,
            h("span", { text: `отложено ${relative(x.at)}` }))),
        h("div", { class: "row-actions" },
          h("button", { type: "button", class: "mini-btn", onclick: () => { Saved.setRead(x.id, !x.read); renderSaved(); refreshSaveButtons(); } },
            x.read ? "Не прочитано" : "Прочитано"),
          h("button", { type: "button", class: "mini-btn", "aria-label": "Удалить из закладок", title: "Удалить",
            onclick: () => { Saved.remove(x.id); renderSaved(); refreshSaveButtons(); } }, "×")));
    })));
  }

  // копия закладок файлом и восстановление из него
  function exportSaved() {
    const url = URL.createObjectURL(new Blob([serialize(Saved.data)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `poznanie-zakladki-${dayKey(Date.now())}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    store.set("exportAt", new Date().toISOString());
    $("backup-note").textContent = "Копия сохранена в «Загрузки».";
    renderSaved();
  }
  async function importSaved(file) {
    try {
      const data = normData(JSON.parse(await file.text()));
      const n = Object.values(data.items).filter((x) => !x.del).length;
      if (!n) throw new Error("пусто");
      Saved.replace(mergeData(Saved.data, data));
      Sync.schedule();
      renderSaved(); refreshSaveButtons();
      $("backup-note").textContent = `Восстановлено: ${n} ${plural(n, ["закладка", "закладки", "закладок"])}.`;
    } catch {
      $("backup-note").textContent = "Не получилось прочитать файл: нужна копия, сохранённая этой кнопкой.";
    }
  }

  function renderSyncState() {
    const el = $("sync-state");
    if (!Sync.token) { el.textContent = "выключена"; el.className = ""; return; }
    el.className = "sync-state " + (Sync.state || "");
    el.textContent = Sync.state === "ok" && Sync.last ? `синхронизировано ${relative(Sync.last)}` : Sync.msg || "включена";
  }

  function renderSync() {
    renderSyncState();
    const body = $("sync-body");
    if (Sync.token) {
      body.replaceChildren(
        h("p", { text: "Закладки хранятся в этом браузере и копируются в ваш секретный gist на GitHub. На другом устройстве вставьте тот же ключ — списки объединятся." }),
        h("div", { class: "sync-form" },
          h("button", { type: "button", class: "btn", onclick: () => Sync.run() }, "Синхронизировать сейчас"),
          h("button", { type: "button", class: "btn", onclick: () => Sync.disconnect() }, "Отключить на этом устройстве")));
      return;
    }
    const input = h("input", { type: "password", placeholder: "ghp_…", autocomplete: "off", "aria-label": "Ключ GitHub" });
    body.replaceChildren(
      h("p", { text: "Без синхронизации закладки живут только в этом браузере. Чтобы они были одинаковыми на телефоне и компьютере, их можно хранить в секретном gist (заметке) на вашем GitHub." }),
      h("ol", {},
        h("li", {}, "Откройте ", extLink("https://github.com/settings/tokens/new?scopes=gist&description=%D0%A1%D0%B0%D0%B9%D1%82%D1%8B%20%D0%B4%D0%BB%D1%8F%20%D0%BF%D0%BE%D0%B7%D0%BD%D0%B0%D0%BD%D0%B8%D1%8F", { text: "создание ключа на GitHub" }),
          " — галочка уже стоит только на ", h("code", { text: "gist" }), ". Срок действия выберите сами."),
        h("li", {}, "Нажмите «Generate token» и скопируйте ключ (начинается с ", h("code", { text: "ghp_" }), ")."),
        h("li", {}, "Вставьте его сюда — на каждом своём устройстве по одному разу.")),
      h("p", { text: "Ключ хранится только в этом браузере и даёт доступ лишь к вашим gist, не к коду." }),
      h("form", { class: "sync-form", onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) Sync.connect(input.value); } },
        input, h("button", { type: "submit", class: "btn primary" }, "Подключить")));
  }

  // ---------- «Ещё»: настройки, каталог, интересы, пульс, состояние сборщика ----------
  function setting(name, segId, note) {
    return h("div", { class: "setting" }, h("span", { class: "setting-name", text: name }),
      h("div", { class: "seg", role: "radiogroup", "aria-label": name, id: segId }), note ? h("small", { text: note }) : null);
  }
  function renderSettings() {
    $("settings-body").replaceChildren(
      setting("Тема", "set-theme"),
      setting("Порядок внутри дня", "set-order", "Сайты, которые вы чаще открываете и откладываете, поднимаются выше."),
      setting("Свайп вправо в карточках", "set-swipe", "Очередь — чтобы не выходить из карточек после каждой статьи: открыть её можно кнопкой «Очередь» вверху карточек."),
      h("div", { class: "setting" }, h("button", { type: "button", class: "link-btn",
        onclick: () => { S.hintDone = false; save(); renderHint(); setTab("feed"); } }, "Показать подсказку для новичков снова")));
    renderSeg("set-theme", THEMES, S.theme, (v) => { S.theme = v; applyTheme(); save(); renderSettings(); });
    renderSeg("set-order", FEED_ORDER, S.feedOrder, (v) => { S.feedOrder = v; save(); renderSettings(); renderFeed(); });
    renderSeg("set-swipe", SWIPE_RIGHT, S.swipeRight, (v) => { S.swipeRight = v; save(); renderSettings(); });
  }

  function renderCatalog() {
    const live = S.sources.filter((s) => s.status !== "reference");
    $("catalog-sum").textContent = `${fmtN(live.length)} ${plural(live.length, ["источник", "источника", "источников"])}, `
      + `${fmtN(S.sources.length - live.length)} ${plural(S.sources.length - live.length, ["справочник", "справочника", "справочников"])}`;
    if (!$("catalog").open) return;
    const pool = S.sources.filter((s) => (!S.catSec || S.secOfSrc.get(s.id) === S.catSec)
      && (S.catKind === "all" || (S.catKind === "refs") === (s.status === "reference")));
    const groups = S.meta.sections.map((sec) => ({ sec, rows: pool.filter((s) => S.secOfSrc.get(s.id) === sec.id) })).filter((g) => g.rows.length);
    const chips = h("div", { class: "chips" });
    sectionChips(chips, new Set(S.catSec ? [S.catSec] : []), (id) => { S.catSec = id === S.catSec ? "" : id || ""; renderCatalog(); }, "Все");
    const kind = h("div", { class: "seg small", role: "radiogroup", "aria-label": "Что показать", id: "cat-kind" });
    $("catalog-body").replaceChildren(
      h("p", { text: "Переключатель «в ленте» убирает сайт из ленты и карточек. Справочники — сайты без потока статей: к ним приходят с вопросом." }),
      h("div", { class: "catalog-tools" }, chips, kind),
      ...groups.map(({ sec, rows }) => h("section", { class: "group" },
        h("h2", { class: "group-head", title: `УДК ${sec.udc}` }, h("i", { class: "dot", style: secColor(sec.id) }), sec.name),
        h("div", { class: "list" }, rows.map(catalogRow)))));
    renderSeg("cat-kind", [["all", "Все"], ["live", "С лентой"], ["refs", "Справочники"]], S.catKind, (v) => { S.catKind = v; renderCatalog(); });
  }
  function catalogRow(s) {
    const muted = S.muted.has(s.id);
    const side = s.status === "reference" ? h("span", { class: "tag", text: "справочник" }) : (() => {
      const box = h("input", { type: "checkbox", checked: !muted, "aria-label": `Показывать ${s.name} в ленте` });
      box.addEventListener("change", () => {
        box.checked ? S.muted.delete(s.id) : S.muted.add(s.id);
        save(); renderStatus(); renderFeed(); renderCatalog();
      });
      return h("label", { class: "switch", title: muted ? "Скрыт из ленты" : "Показывается в ленте" }, box, "в ленте");
    })();
    return h("div", { class: "row" + (muted ? " is-muted" : "") },
      favicon(s),
      h("div", { class: "row-main" }, extLink(s.url, { class: "row-name", text: s.name }),
        s.about ? h("p", { class: "row-about", text: s.about }) : null),
      side);
  }

  function renderInterest() {
    const acts = Interest.actions();
    $("interest-sum").textContent = acts ? `по ${fmtN(Math.round(acts))} ${plural(Math.round(acts), ["действию", "действиям", "действиям"])}` : "пока не знаю";
    if (!$("interest").open) return;
    const rows = Object.entries(Interest.data).filter(([id, x]) => S.srcById.has(id) && x.p + x.n >= 2)
      .map(([id]) => [S.srcById.get(id), Interest.weight(id)]);
    const liked = rows.filter(([, w]) => w > 1.05).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const skipped = rows.filter(([, w]) => w < 0.95).sort((a, b) => a[1] - b[1]).slice(0, 6);
    const col = (title, list) => h("div", {}, h("h4", { text: title }),
      list.length ? h("ul", {}, list.map(([s]) => h("li", {}, favicon(s), s.name))) : h("p", { class: "note", text: "Пока никого" }));
    $("interest-body").replaceChildren(
      h("p", { text: "Сайт запоминает, какие статьи вы открываете, откладываете и пролистываете в карточках. Это влияет на «Главное», порядок внутри дня и карточки «вперемешку». Данные хранятся только в этом браузере." }),
      h("div", { class: "interest-cols" }, col("Чаще открываете", liked), col("Чаще пролистываете", skipped)),
      acts ? h("button", { type: "button", class: "btn small", onclick: () => { Interest.reset(); renderInterest(); renderFeed(); } }, "Забыть всё и начать заново") : null);
  }

  // пульс: разделы × 14 дней (считается, только когда открыт)
  function renderPulse() {
    if (!$("pulse-panel").open) return;
    const base = baseFilter();
    const secOn = (secId) => !S.sections.size || S.sections.has(secId);
    const today = startOfDay(S.now);
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(today.getTime() - i * DAY));
    const idx = new Map(days.map((d, i) => [dayKey(d), i]));
    const grid = new Map(S.meta.sections.map((s) => [s.id, new Array(14).fill(0)]));
    for (const p of S.posts) {
      if (p.k || !base(p)) continue;
      const i = idx.get(p.day);
      if (i === undefined) continue;
      const row = grid.get(S.secOfSrc.get(p.s));
      if (row) row[i]++;
    }
    const totals = days.map((_, i) => S.meta.sections.reduce((a, s) => a + (secOn(s.id) ? grid.get(s.id)[i] : 0), 0));
    const maxCell = Math.max(1, ...[...grid.values()].flat());
    const maxTotal = Math.max(1, ...totals);
    const level = (v) => (v === 0 ? 0 : Math.min(5, 1 + Math.floor((v / maxCell) * 4.999)));
    const el = $("pulse-grid");
    const kids = [h("div")];
    totals.forEach((v, i) => kids.push(h("div", { class: "pg-bar" + (i === 13 ? " today" : ""), "data-col": i, "data-total": v },
      v && (v === maxTotal || i === 13) ? h("em", { text: v }) : null, h("i", { style: `--h:${Math.round((v / maxTotal) * 34)}px` }))));
    kids.push(h("div"));
    for (const sec of S.meta.sections) {
      const row = grid.get(sec.id);
      const dim = S.sections.size && !S.sections.has(sec.id) ? "opacity:.35" : null;
      kids.push(h("div", { class: "pg-label", style: dim, title: `${sec.name} · УДК ${sec.udc}` },
        h("i", { class: "dot", style: secColor(sec.id) }), h("span", { text: sec.name })));
      row.forEach((v, i) => kids.push(h("div", { class: `pg-cell lv${level(v)}`, style: dim, "data-sec": sec.id, "data-col": i, "data-v": v })));
      kids.push(h("div", { class: "pg-total", style: dim, text: row.reduce((a, b) => a + b, 0) }));
    }
    kids.push(h("div"));
    days.forEach((d, i) => kids.push(h("div", { class: "pg-days" + (i === 13 ? " today" : ""),
      text: i === 13 ? "сег." : (i % 2 === 1 ? d.getDate() : "") })));
    kids.push(h("div"));
    el.replaceChildren(...kids);
    el._days = days;
    const sc = el.parentElement;
    if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;
  }

  function wirePulse() {
    const el = $("pulse-grid"), tip = $("tooltip");
    el.addEventListener("pointerover", (e) => {
      const cell = e.target.closest(".pg-cell, .pg-bar");
      if (!cell) { tip.hidden = true; return; }
      const day = el._days[Number(cell.dataset.col)];
      const isBar = cell.classList.contains("pg-bar");
      const v = Number(isBar ? cell.dataset.total : cell.dataset.v);
      tip.replaceChildren(h("strong", { text: fmtN(v) }), isBar
        ? `${plural(v, ["пост", "поста", "постов"])} · ${fmtShort.format(day)}, ${fmtWd.format(day)}`
        : `${S.secById.get(cell.dataset.sec).name} · ${fmtShort.format(day)}`);
      tip.hidden = false;
      const fig = $("pulse").getBoundingClientRect(), r = cell.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(r.left - fig.left + r.width / 2, 80), fig.width - 80) + "px";
      tip.style.top = (r.top - fig.top) + "px";
    });
    el.addEventListener("pointerleave", () => { tip.hidden = true; });
  }

  function renderDiag() {
    const live = S.sources.filter((s) => s.status !== "reference");
    const count = (st) => live.filter((s) => st.includes(s.status)).length;
    const ok = count(["ok"]), stale = count(["stale"]), bad = count(PROBLEM);
    $("diag-summary").textContent = `работают ${ok} · давно молчат ${stale}` + (bad ? ` · с проблемами ${bad}` : "");
    if (!$("diag").open) return;
    const problems = live.filter((s) => PROBLEM.includes(s.status) || s.status === "stale" || s.message);
    const runs = (S.meta.last_runs || []).slice(-6).reverse();
    const method = (s) => {
      let m = METHOD[(s.method || "").split("+")[0]] || s.method || "—";
      if ((s.method || "").includes("+telegram")) m += " + Telegram";
      return m;
    };
    $("diag-body").replaceChildren(
      h("h4", { text: "Последние запуски" }),
      runs.length ? h("table", { class: "diag-table" },
        h("thead", {}, h("tr", {}, h("th", { text: "Когда" }), h("th", { text: "Новых постов" }), h("th", { text: "Ошибок" }), h("th", { text: "Длился" }))),
        h("tbody", {}, runs.map((r) => h("tr", {}, h("td", { text: `${fmtShort.format(new Date(r.at))}, ${fmtTime.format(new Date(r.at))}` }),
          h("td", { text: r.new }), h("td", { text: r.outage ? `${r.errors} · сбой сети, не засчитан` : r.errors }),
          h("td", { text: `${Math.round(r.seconds)} с` })))))
        : h("p", { text: "Запусков ещё не было." }),
      h("h4", { text: "Источники, требующие внимания" }),
      problems.length ? h("table", { class: "diag-table" },
        h("thead", {}, h("tr", {}, h("th", { text: "Источник" }), h("th", { text: "Состояние" }), h("th", { text: "Подробности" }))),
        h("tbody", {}, problems.map((s) => h("tr", {},
          h("td", {}, extLink(s.url, { text: s.name })),
          h("td", {}, h("span", { class: "sdot " + s.status }), STATUS[s.status] || s.status,
            s.failing_since ? h("div", { text: `с ${fmtShort.format(new Date(s.failing_since))}` }) : null),
          h("td", { text: [s.message, `способ: ${method(s)}`, `последний пост: ${relative(s.last_post)}`].filter(Boolean).join(" · ") })))))
        : h("p", { text: "Все источники работают." }),
      h("p", { class: "note", text: "Разовый сбой сайта не считается проблемой: «Не работает» появляется, только если сайт не ответил три запуска подряд. Если за один запуск не ответила больше половины сайтов, это сбой сети, и он никому не засчитывается." }));
  }

  // ---------- поиск: одно поле — источники, свежее и весь архив ----------
  const Archive = { pf: null, results: [], shown: 0, token: 0, skip: new Set() };
  async function pagefind() {
    if (!Archive.pf) {
      Archive.pf = await import(new URL("pagefind/pagefind.js", location.href).href);
      await Archive.pf.options({ excerptLength: 26 });
    }
    return Archive.pf;
  }
  function excerptNodes(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    return [...doc.body.firstChild.childNodes].map((n) => (n.nodeName === "MARK" ? h("mark", { text: n.textContent }) : n.textContent));
  }
  const recentQueries = () => store.get("recentQ", []);
  function rememberQuery(q) {
    q = q.trim();
    if (q.length < 3) return;
    store.set("recentQ", [q, ...recentQueries().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8));
  }
  function setupSearch() {
    const sel = $("a-section");
    if (!sel.options.length) sel.append(h("option", { value: "" }, "Все разделы"), ...S.meta.sections.map((s) => h("option", { value: s.name }, s.name)));
  }
  function renderSearchEmpty() {
    const recent = recentQueries();
    const pick = (q) => { $("q").value = q; runSearch(); rememberQuery(q); };
    $("search-empty").replaceChildren(h("div", { class: "examples" },
      recent.length ? h("h2", {}, "Вы искали · ", h("button", { type: "button", class: "link-btn",
        onclick: () => { store.del("recentQ"); renderSearchEmpty(); } }, "очистить")) : null,
      recent.length ? h("div", { class: "chips" }, recent.map((q) => h("button", { type: "button", class: "chip", onclick: () => pick(q) }, q))) : null,
      h("h2", { text: "Например" }),
      h("div", { class: "chips" }, EXAMPLES.map((q) => h("button", { type: "button", class: "chip", onclick: () => pick(q) }, q))),
      h("p", { class: "note", text: S.meta.archive
        ? `В архиве ${fmtN(S.meta.archive)} ${plural(S.meta.archive, ["статья", "статьи", "статей"])} — всё, что сборщик нашёл с первого дня, и ${fmtN(S.sources.length)} ${plural(S.sources.length, ["источник", "источника", "источников"])}.`
        : "Поиск по архиву появится после следующей сборки сайта." })));
  }
  const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  const hasAll = (hay, ws) => { hay = hay.toLowerCase(); return ws.every((w) => hay.includes(w)); };

  async function runSearch() {
    const q = $("q").value.trim();
    const section = $("a-section").value;
    const my = ++Archive.token;
    $("search-empty").hidden = !!(q || section);
    $("a-more").hidden = true;
    if (!q && !section) { $("search-results").replaceChildren(); renderSearchEmpty(); return; }
    const ws = words(q);
    const out = [];
    const secOk = (srcId) => !section || S.srcById.get(srcId)?.section === section;
    if (ws.length) {
      const srcs = S.sources.filter((s) => secOk(s.id) && hasAll(`${s.name} ${s.about || ""} ${s.host}`, ws)).slice(0, 6);
      if (srcs.length) {
        out.push(h("section", { class: "search-group" }, h("h2", { text: "Источники" }),
          h("div", { class: "list" }, srcs.map((s) => h("div", { class: "row" }, favicon(s),
            h("div", { class: "row-main" }, extLink(s.url, { class: "row-name", text: s.name }), s.about ? h("p", { class: "row-about", text: s.about }) : null),
            h("span", { class: "tag", text: s.status === "reference" ? "справочник" : S.muted.has(s.id) ? "скрыт из ленты" : "" }))))));
      }
      const fresh = S.posts.filter((p) => secOk(p.s) && hasAll(`${p.t} ${p.m || ""} ${S.srcById.get(p.s)?.name || ""}`, ws));
      Archive.skip = new Set(fresh.slice(0, 5).map((p) => p.u));
      if (fresh.length) {
        const box = h("div", { class: "list" }, fresh.slice(0, 5).map(freshHit));
        const more = fresh.length > 5 ? h("button", { type: "button", class: "link-btn", onclick: (e) => {
          box.replaceChildren(...fresh.slice(0, 50).map(freshHit)); fresh.slice(0, 50).forEach((p) => Archive.skip.add(p.u)); e.currentTarget.remove(); } },
        `Ещё ${fmtN(fresh.length - 5)} в ленте`) : null;
        out.push(h("section", { class: "search-group" }, h("h2", { text: "Свежее" }), box, more));
      }
    } else {
      Archive.skip = new Set();
    }
    const archiveBox = h("section", { class: "search-group", id: "archive-group" }, h("h2", { text: "Во всём архиве" }),
      h("p", { class: "note", text: S.meta.archive ? "Ищу…" : "Поиск по архиву появится после следующей сборки сайта." }));
    out.push(archiveBox);
    $("search-results").replaceChildren(...out);
    if (!S.meta.archive) return;
    try {
      const pf = await pagefind();
      const opts = { filters: section ? { section } : {} };
      if ($("a-sort").value === "new" || !q) opts.sort = { date: "desc" };
      const res = await pf.search(q || null, opts);
      if (my !== Archive.token) return;
      Archive.results = res.results; Archive.shown = 0;
      archiveBox.replaceChildren(h("h2", { text: "Во всём архиве" }), h("p", { class: "note", text: res.results.length
        ? `Нашлось в архиве: ${fmtN(res.results.length)}` : "В архиве ничего не нашлось. Попробуйте другое слово." }));
      await moreArchive(my);
    } catch (e) {
      archiveBox.replaceChildren(h("h2", { text: "Во всём архиве" }), h("p", { class: "note", text: `Поиск не загрузился: ${e.message}` }));
    }
  }
  function freshHit(p) {
    const src = S.srcById.get(p.s);
    return h("div", { class: "hit" },
      h("div", { class: "hit-meta" }, h("span", { text: src ? src.name : "" }), h("span", { text: relative(p.d, S.now) })),
      h("h3", {}, extLink(p.u, { text: p.t, "data-src": p.s })),
      p.m ? h("p", { text: p.m }) : null);
  }
  async function moreArchive(my = Archive.token) {
    const box = $("archive-group");
    if (!box) return;
    const chunk = Archive.results.slice(Archive.shown, Archive.shown + 20);
    const datas = await Promise.all(chunk.map((r) => r.data()));
    if (my !== Archive.token) return;
    Archive.shown += chunk.length;
    box.append(...datas.filter((d) => !Archive.skip.has(d.meta.url)).map((d) => h("div", { class: "hit" },
      h("div", { class: "hit-meta" }, h("span", { text: d.meta.source }), h("span", { text: d.meta.date ? fmtShortYear.format(new Date(d.meta.date)) : "" })),
      h("h3", {}, extLink(d.meta.url, { text: d.meta.title })),
      d.excerpt ? h("p", {}, excerptNodes(d.excerpt)) : null)));
    $("a-more").hidden = Archive.shown >= Archive.results.length;
    if ($("a-more").hidden && Archive.results.length && !box.querySelector(".hit")) {
      box.querySelector(".note").textContent = "Всё, что нашлось в архиве, уже показано выше.";
    }
  }

  // ---------- карточки: по одной статье, свайп вправо — открыть, влево — дальше, вверх — в закладки ----------
  const Deck = {
    pool: [], seen: new Set(store.get("deckSeen", [])), shuffled: new Set(), upcoming: [], history: [],
    queue: store.get("queue", []), openedAt: 0,

    open() {
      openDialog("deck");
      document.documentElement.style.overflow = "hidden";
      this.build();
      this.render({ first: true });
    },
    close() { document.documentElement.style.overflow = ""; $("deck-queue").hidden = true; },
    build() {
      const { hidden } = groupStories(feedPosts().filter((p) => !p.k));
      this.pool = feedPosts().filter((p) => !p.k && !hidden.has(p.i));
      this.history = [];
      this.upcoming = [];
      this.fill();
    },
    // «вперемешку»: случайно, но чаще — с сайтов, которые вам интересны, и с тех, что пишут редко
    pickRandom(exclude) {
      const pool = this.pool.filter((p) => !this.shuffled.has(p.i) && !exclude.has(p.i));
      if (!pool.length) return null;
      const w = pool.map((p) => Interest.weight(p.s) / Math.sqrt(S.freq.get(p.s) || 1));
      let r = Math.random() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i]; }
      return pool[pool.length - 1];
    },
    fill() {
      if (S.deckMode !== "shuffle") return;
      while (this.upcoming.length < 3) {
        const p = this.pickRandom(new Set(this.upcoming.map((x) => x.i)));
        if (!p) break;
        this.upcoming.push(p);
      }
    },
    next(k = 0) {
      if (S.deckMode === "shuffle") return this.upcoming[k] || null;
      let n = -1;
      for (const p of this.pool) if (!this.seen.has(p.i) && ++n === k) return p;
      return null;
    },
    markSeen(p) {
      if (S.deckMode === "shuffle") { this.shuffled.add(p.i); this.upcoming.shift(); this.fill(); return; }
      this.seen.add(p.i);
      store.set("deckSeen", [...this.seen].slice(-4000));
    },
    undo() {
      const p = this.history.pop();
      if (!p) return;
      if (S.deckMode === "shuffle") { this.shuffled.delete(p.i); this.upcoming.unshift(p); this.upcoming.length = Math.min(this.upcoming.length, 3); }
      else { this.seen.delete(p.i); store.set("deckSeen", [...this.seen].slice(-4000)); }
      this.render({ back: true });
    },
    act(kind, drag) {
      const p = this.next();
      if (!p) return;
      if (kind === "open") {
        if (S.swipeRight === "queue") {
          Queue.add(p);
          toast(`В очереди ${this.queue.length}`);
        } else {
          window.open(safeUrl(p.u), "_blank", "noopener");
        }
        Interest.add(p.s, "open");
      } else if (kind === "save") {
        if (!Saved.has(p.i)) Saved.toggle(p);
        Interest.add(p.s, "save");
        refreshSaveButtons(); renderSaved();
        toast("В закладках");
      } else {
        Interest.add(p.s, "skip");
      }
      const el = $("deck-stage").querySelector(".card.front");
      if (el) this.fly(el, kind, drag);
      this.markSeen(p);
      this.history.push(p);
      this.render();
    },
    fly(el, kind, drag = { dx: 0, dy: 0 }) {
      el.classList.remove("front", "dragging");
      el.classList.add("flying");
      el.querySelectorAll(".stamp").forEach((s) => { s.style.opacity = 0; });
      const stamp = el.querySelector(`.stamp-${kind}`);
      if (stamp) stamp.style.opacity = 1;
      const w = window.innerWidth, hgt = window.innerHeight;
      const tx = kind === "open" ? w : kind === "skip" ? -w : drag.dx;
      const ty = kind === "save" ? -hgt : drag.dy + 40;
      el.style.transition = "transform .38s cubic-bezier(.4,0,.8,.6), opacity .38s ease-in";
      requestAnimationFrame(() => {
        el.style.transform = `translate(${tx}px, ${ty}px) rotate(${kind === "save" ? 0 : kind === "open" ? 20 : -20}deg)`;
        el.style.opacity = "0";
      });
      setTimeout(() => el.remove(), 400);
    },
    render({ first = false, back = false } = {}) {
      const stage = $("deck-stage");
      const cur = this.next(), n1 = this.next(1), n2 = this.next(2);
      const total = this.pool.length;
      const seenHere = this.pool.filter((p) => this.seen.has(p.i)).length;
      renderSeg("deck-mode", DECK_MODES, S.deckMode, (v) => { S.deckMode = v; save(); this.build(); this.render({ first: true }); });
      const filters = isDefaultFilters() ? "" : ` · ${filterText({ withView: false })}`;
      $("deck-info").textContent = !total ? filterText({ withView: false })
        : S.deckMode === "shuffle" ? `Просмотрено ${fmtN(this.shuffled.size)}${filters}`
          : `${fmtN(Math.min(seenHere + 1, total))} из ${fmtN(total)}${filters}`;
      $("deck-hint").textContent = `← дальше · ↑ в закладки · → ${S.swipeRight === "queue" ? "в очередь" : "открыть"}`
        + (matchMedia("(hover: hover)").matches ? " · ↓ вернуть · стрелки на клавиатуре" : "");
      $("deck-undo").disabled = !this.history.length;
      for (const id of ["deck-skip", "deck-save", "deck-open"]) $(id).disabled = !cur;
      $("deck-open").setAttribute("aria-label", S.swipeRight === "queue" ? "В очередь" : "Открыть статью");
      $("deck-queue-btn").hidden = !this.queue.length;
      $("deck-queue-n").textContent = this.queue.length;

      const keep = new Map([...stage.querySelectorAll(".card:not(.flying)")].map((el) => [el.dataset.id, el]));
      stage.querySelectorAll(".deck-end").forEach((x) => x.remove());
      const want = [[n2, "behind-2"], [n1, "behind"], [cur, "front"]].filter(([p]) => p);
      const ids = new Set(want.map(([p]) => p.i));
      for (const [id, el] of keep) if (!ids.has(id)) el.remove();
      for (const [p, cls] of want) {
        let el = keep.get(p.i);
        if (!el) {
          el = cardEl(p);
          if (cls === "front" && (first || back)) el.classList.add("enter");
        }
        el.classList.remove("front", "behind", "behind-2");
        el.classList.add(cls);
        el.style.transform = "";
        el.setAttribute("aria-hidden", cls === "front" ? "false" : "true");
        stage.append(el);
        if (cls === "front") wireDrag(el);
      }
      if (!cur) stage.append(this.endScreen());
    },
    endScreen() {
      const shuffle = S.deckMode === "shuffle";
      const q = this.queue.length;
      return h("div", { class: "deck-end" },
        h("h3", { text: this.pool.length ? "Вы всё просмотрели" : "Карточек нет" }),
        h("p", { text: !this.pool.length ? "В выбранных разделах за этот период ничего не вышло. Измените фильтры над лентой."
          : shuffle ? "Все карточки из выбранных разделов уже были."
            : `Это все статьи (${filterText({ withView: false }).toLowerCase()}). Загляните позже — сборщик приносит новые раз в три часа.` }),
        q ? h("p", { text: `В очереди ${q} ${plural(q, ["статья", "статьи", "статей"])}.` }) : null,
        h("div", { class: "btns" },
          q ? h("button", { type: "button", class: "btn primary", onclick: () => Queue.show() }, "Открыть очередь") : null,
          this.pool.length ? h("button", { type: "button", class: "btn", onclick: () => {
            if (shuffle) this.shuffled.clear(); else { this.pool.forEach((p) => this.seen.delete(p.i)); store.set("deckSeen", [...this.seen]); }
            this.build(); this.render({ first: true });
          } }, "Начать сначала") : null,
          !shuffle && this.pool.length ? h("button", { type: "button", class: "btn", onclick: () => { S.deckMode = "shuffle"; save(); this.build(); this.render({ first: true }); } }, "Вперемешку") : null));
    },
  };

  function cardEl(p) {
    const src = S.srcById.get(p.s), secId = S.secOfSrc.get(p.s), sec = S.secById.get(secId);
    const story = p.dup || p.i;
    const others = S.posts.filter((x) => x !== p && !x.k && (x.dup || x.i) === story);
    const foot = h("div", { class: "card-foot" },
      Saved.has(p.i) ? h("span", { class: "is-saved", text: "В закладках" }) : null,
      others.length ? subToggle(`и ещё в ${others.length} ${plural(others.length, ["источнике", "источниках", "источниках"])}`,
        () => Promise.resolve(others.map((x) => [x.t, x.u, x.s, x.d]))) : null,
      p.r ? subToggle("ещё на эту тему", () => Related.get(p.i)) : null);
    return h("article", { class: "card", style: secColor(secId), "data-id": p.i, "aria-roledescription": "карточка" },
      h("span", { class: "stamp stamp-open", text: S.swipeRight === "queue" ? "В очередь" : "Открыть" }),
      h("span", { class: "stamp stamp-skip", text: "Дальше" }),
      h("span", { class: "stamp stamp-save", text: "В закладки" }),
      h("p", { class: "card-sec" }, h("i", { class: "dot" }), sec ? sec.name : ""),
      h("div", { class: "card-meta" }, favicon(src), h("span", { class: "src", text: src.name }),
        h("span", { text: "·" }), h("time", { datetime: p.d, text: relative(p.d, S.now) }),
        src.lang ? h("span", { text: "· " + src.lang.toUpperCase() }) : null),
      h("h3", {}, extLink(p.u, { text: p.t, "data-src": p.s, draggable: "false" })),
      p.m ? h("p", { class: "card-text", text: p.m }) : null,
      foot);
  }

  // перетаскивание карточки пальцем или мышью
  function wireDrag(el) {
    if (el._wired) return;
    el._wired = true;
    let sx = 0, sy = 0, dx = 0, dy = 0, pid = null, moved = false;
    const stamps = { open: el.querySelector(".stamp-open"), skip: el.querySelector(".stamp-skip"), save: el.querySelector(".stamp-save") };
    const limit = () => Math.min(110, el.offsetWidth * 0.26);
    const decide = () => {
      const T = limit();
      if (dy < -T && Math.abs(dy) > Math.abs(dx) * 1.1) return "save";
      if (dx > T) return "open";
      if (dx < -T) return "skip";
      return null;
    };
    const paint = () => {
      const T = limit();
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.06}deg)`;
      const up = dy < 0 && Math.abs(dy) > Math.abs(dx) ? Math.min(1, -dy / T) : 0;
      stamps.open.style.opacity = dx > 0 && !up ? Math.min(1, dx / T) : 0;
      stamps.skip.style.opacity = dx < 0 && !up ? Math.min(1, -dx / T) : 0;
      stamps.save.style.opacity = up;
    };
    el.addEventListener("pointerdown", (e) => {
      if (!el.classList.contains("front") || e.button > 0 || e.target.closest("button, .sublist")) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0; moved = false;
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 6) {
        moved = true;                      // палец поехал — это перетаскивание, а не нажатие на заголовок
        el.setPointerCapture(pid);
        el.classList.add("dragging");
      }
      if (moved) paint();
    });
    const finish = (e, cancel) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (!moved) return;
      el.classList.remove("dragging");
      const kind = cancel ? null : decide();
      if (kind) { Deck.act(kind, { dx, dy }); return; }
      el.style.transform = "";
      Object.values(stamps).forEach((s) => { s.style.opacity = 0; });
    };
    el.addEventListener("pointerup", (e) => finish(e, false));
    el.addEventListener("pointercancel", (e) => finish(e, true));
    // клик по заголовку после перетаскивания — не переход по ссылке
    el.addEventListener("click", (e) => { if (moved && e.target.closest("a")) { e.preventDefault(); moved = false; } }, true);
  }

  // очередь на чтение: правый свайп в режиме «в очередь»
  const Queue = {
    add(p) {
      if (Deck.queue.some((x) => x.i === p.i)) return;
      Deck.queue.push({ i: p.i, u: p.u, t: p.t, s: p.s, d: p.d });
      store.set("queue", Deck.queue);
    },
    remove(id) { Deck.queue = Deck.queue.filter((x) => x.i !== id); store.set("queue", Deck.queue); },
    show() {
      const box = $("deck-queue");
      box.hidden = false;
      const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Закрыть очередь", style: "float:right",
        html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: () => { box.hidden = true; } });
      if (!Deck.queue.length) {
        box.replaceChildren(close, h("h3", { text: "Очередь пуста" }), h("p", { class: "note", text: "Свайп вправо кладёт статью в очередь, если так выбрано в настройках." }));
        return;
      }
      box.replaceChildren(close, h("h3", { text: "Очередь на чтение" }),
        h("p", { class: "note", text: "Статья уходит из очереди, когда вы её открываете." }),
        h("div", { class: "list" }, Deck.queue.map((x) => {
          const src = S.srcById.get(x.s) || { name: "" };
          return h("div", { class: "row" }, favicon(src),
            h("div", { class: "row-main" }, extLink(x.u, { class: "row-name", text: x.t,
              onclick: () => { setTimeout(() => { Queue.remove(x.i); Queue.show(); Deck.render(); }, 200); } }),
            h("div", { class: "row-facts" }, h("span", { text: src.name }), h("span", { text: relative(x.d) }))),
            h("button", { type: "button", class: "mini-btn", "aria-label": "Убрать из очереди", onclick: () => { Queue.remove(x.i); Queue.show(); Deck.render(); } }, "×"));
        })),
        h("button", { type: "button", class: "link-btn", onclick: () => { Deck.queue = []; store.set("queue", []); Queue.show(); Deck.render(); } }, "Очистить очередь"));
    },
  };

  // ---------- вкладки ----------
  function setTab(tab) {
    S.tab = tab;
    for (const b of document.querySelectorAll(".tabs [role=tab]")) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const t of TABS) $("tab-" + t).hidden = tab !== t;
    if (tab === "search" && S.meta) { setupSearch(); if (!$("q").value) renderSearchEmpty(); }
    save();
  }

  function render() {
    S.now = Date.now();
    renderHint();
    renderStatus();
    renderFilterBar();
    renderFeed();
    renderSaved();
    renderSettings();
    renderCatalog();
    renderInterest();
    renderDiag();
    renderPulse();
    refreshSaveButtons();
    setTab(S.tab);
  }

  const getJSON = (n) => fetch(`data/${n}.json`, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`${n}.json: HTTP ${r.status}`);
    return r.json();
  });
  const prep = (p) => { p.ts = Date.parse(p.d); p.day = dayKey(p.ts); return p; };   // даты разбираем один раз

  function countFreq() {
    S.freq = new Map();
    const border = Date.now() - 14 * DAY;
    for (const p of S.posts) if (p.ts >= border) S.freq.set(p.s, (S.freq.get(p.s) || 0) + 1);
  }

  async function loadOlder() {
    if (S.olderLoaded || S.olderLoading || !S.meta.has_older) { S.olderLoaded ||= !S.meta.has_older; return; }
    S.olderLoading = true;
    try {
      const older = (await getJSON("posts-older")).map(prep);
      S.posts = S.posts.concat(older).sort((a, b) => b.ts - a.ts);
      S.olderLoaded = true;
    } catch { /* без старых постов лента всё равно работает */ S.olderLoaded = true; }
    S.olderLoading = false;
    renderFeed();
    if ($("filters").open) renderFilterSheet();
  }

  async function load() {
    const [meta, sources, posts] = await Promise.all([getJSON("meta"), getJSON("sources"), getJSON("posts")]);
    S.meta = meta; S.sources = sources; S.posts = posts.map(prep);
    const secByName = new Map(meta.sections.map((s) => [s.name, s]));
    meta.sections.forEach((s, i) => { S.secById.set(s.id, s); S.secIdx.set(s.id, i); });
    for (const s of sources) {
      if (s.status === "robots") s.status = "blocked";
      S.srcById.set(s.id, s);
      S.secOfSrc.set(s.id, secByName.get(s.section)?.id);
    }
    const known = new Set(meta.sections.map((s) => s.id));
    S.sections = new Set([...S.sections].filter((id) => known.has(id)));
    countFreq();
  }

  function wire() {
    const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
    tabs.forEach((b, i) => {
      b.addEventListener("click", () => { setTab(b.dataset.tab); window.scrollTo({ top: 0 }); });
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); next.click();
      });
    });
    $("filter-btn").addEventListener("click", () => { if (S.meta) { renderFilterSheet(); openDialog("filters"); } });
    $("filters-reset").addEventListener("click", resetFilters);
    $("info-btn").addEventListener("click", openGuide);
    $("guide-link").addEventListener("click", openGuide);
    $("deck-btn").addEventListener("click", () => { if (S.meta) Deck.open(); });
    $("deck-close").addEventListener("click", () => $("deck").close());
    $("deck").addEventListener("close", () => Deck.close());
    $("deck-skip").addEventListener("click", () => Deck.act("skip"));
    $("deck-save").addEventListener("click", () => Deck.act("save"));
    $("deck-open").addEventListener("click", () => Deck.act("open"));
    $("deck-undo").addEventListener("click", () => Deck.undo());
    $("deck-queue-btn").addEventListener("click", () => ($("deck-queue").hidden ? Queue.show() : ($("deck-queue").hidden = true)));
    $("deck").addEventListener("keydown", (e) => {
      if (!$("deck-queue").hidden || e.target.closest("input, select")) return;
      const act = { ArrowLeft: "skip", ArrowRight: "open", ArrowUp: "save" }[e.key];
      if (act) { e.preventDefault(); Deck.act(act); } else if (e.key === "ArrowDown" || e.key === "Backspace") { e.preventDefault(); Deck.undo(); }
    });
    for (const id of ["filters", "guide", "deck"]) {
      $(id).addEventListener("click", (e) => { if (e.target === $(id)) $(id).close(); });   // нажатие мимо окна закрывает его
    }
    let tq, tr;
    $("q").addEventListener("input", (e) => {
      clearTimeout(tq); clearTimeout(tr);
      tq = setTimeout(runSearch, 220);
      tr = setTimeout(() => rememberQuery(e.target.value), 1800);
    });
    $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { rememberQuery(e.target.value); e.target.blur(); } });
    $("a-section").addEventListener("change", runSearch);
    $("a-sort").addEventListener("change", runSearch);
    $("a-more").addEventListener("click", () => moreArchive());
    $("more").addEventListener("click", () => { S.shown += PAGE; renderFeed(); });
    $("hide-read").addEventListener("change", (e) => { S.hideRead = e.target.checked; save(); renderSaved(); });
    $("export-btn").addEventListener("click", exportSaved);
    $("import-file").addEventListener("change", (e) => { if (e.target.files[0]) importSaved(e.target.files[0]); e.target.value = ""; });
    $("diag").addEventListener("toggle", renderDiag);
    $("catalog").addEventListener("toggle", renderCatalog);
    $("interest").addEventListener("toggle", renderInterest);
    $("pulse-panel").addEventListener("toggle", renderPulse);
    // открытые статьи — сигнал интереса к сайту
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-src]");
      if (a && !e.defaultPrevented) Interest.add(a.dataset.src, "open");
    });
    window.addEventListener("hashchange", () => { readHash(); if (S.meta) changed(); });
    wirePulse();
    // на телефоне шапка прячется при прокрутке вниз и возвращается при прокрутке вверх
    let lastY = window.scrollY;
    window.addEventListener("scroll", () => {
      const y = window.scrollY;
      document.body.classList.toggle("scrolled", y > 4);
      if (Math.abs(y - lastY) < 8) return;
      document.body.classList.toggle("head-hidden", y > lastY && y > 140);
      lastY = y;
    }, { passive: true });
    // визит продолжается, пока страница открыта; вернулись после долгого перерыва — новый визит
    setInterval(() => { if (!document.hidden) touchVisit(); }, 60e3);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { touchVisit(); return; }
      const last = Date.parse(store.get("lastActive", "")) || 0;
      if (Date.now() - last > SESSION_GAP && S.meta) { startVisit(); render(); }
      Sync.schedule(300);
    });
    setInterval(() => { if (!document.hidden && S.meta) renderStatus(); }, 5 * 60e3);
    setInterval(() => { if (!document.hidden) Sync.schedule(0); }, 5 * 60e3);
  }

  applyTheme();
  readHash();
  startVisit();
  wire();
  renderSync();
  setTab(S.tab);
  load().then(() => { render(); Sync.schedule(0); })
    .catch((err) => {
      $("status").textContent = "Не удалось загрузить данные";
      $("feed").removeAttribute("aria-busy");
      $("feed").replaceChildren(h("div", { class: "empty-state" }, h("strong", { text: "Данные не загрузились" }),
        `Проверьте связь или соберите сайт командой python -m dashboard. Ошибка: ${err.message}`));
    });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* без офлайн-режима сайт тоже работает */ });
  }
})();
