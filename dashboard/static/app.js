"use strict";
(() => {
  const PAGE = 120;
  const DAY = 86400000;
  const PERIODS = [["1", "24 ч"], ["3", "3 дня"], ["7", "7 дней"], ["30", "30 дней"]];
  const LANGS = [["all", "Все языки"], ["ru", "Рус"], ["en", "Англ"]];
  const METHOD = { rss: "RSS", sitemap: "карта сайта", page: "страница сайта", auto: "ищет способ", reference: "справочник", pending: "—" };
  const STATUS = {
    ok: "Работает", stale: "Давно без постов", blocked: "Не пускает сборщик",
    error: "Ошибка", pending: "Ещё не проверялся", reference: "Справочник",
  };
  const STATUS_ORDER = ["ok", "stale", "blocked", "error", "pending", "reference"];
  const THEMES = ["auto", "light", "dark"];
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  };
  const THEME_LABEL = { auto: "Тема: как в системе", light: "Тема: светлая", dark: "Тема: тёмная" };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("pz:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pz:" + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }
  const nPosts = (n) => `${n.toLocaleString("ru-RU")} ${plural(n, ["пост", "поста", "постов"])}`;
  const fmtTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long" });
  const fmtShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  const fmtShortYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  const fmtWd = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
  const dayKey = (d) => d.toLocaleDateString("sv-SE");
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  function relative(iso, now) {
    if (!iso) return "—";
    const d = new Date(iso), diff = now - d;
    if (diff < 60e3) return "только что";
    if (diff < 3600e3) return `${Math.round(diff / 60e3)} мин назад`;
    if (diff < DAY) return `${Math.round(diff / 3600e3)} ч назад`;
    if (diff < 30 * DAY) { const dd = Math.round(diff / DAY); return `${dd} ${plural(dd, ["день", "дня", "дней"])} назад`; }
    return (d.getFullYear() === now.getFullYear() ? fmtShort : fmtShortYear).format(d);
  }

  function favicon(src) {
    const letter = h("span", { class: "fav-letter", "aria-hidden": "true", text: (src.name.replace(/^[«"]/, "")[0] || "?").toUpperCase() });
    if (!src.host) return letter;
    const img = h("img", { class: "fav", alt: "", loading: "lazy", width: 22, height: 22, referrerpolicy: "no-referrer",
      src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(src.host)}&sz=64` });
    img.addEventListener("error", () => img.replaceWith(letter), { once: true });
    return img;
  }

  // ---------- состояние ----------
  const S = {
    meta: null, sources: [], posts: [], srcById: new Map(), secById: new Map(), secOfSrc: new Map(),
    sections: new Set(store.get("sections", [])),
    period: store.get("period", "7"),
    lang: store.get("lang", "all"),
    muted: new Set(store.get("muted", [])),
    tab: store.get("tab", "feed"),
    theme: store.get("theme", "auto"),
    statusFilter: null, q: "", sq: "", shown: PAGE,
    prevVisit: store.get("lastVisit", null),
    now: new Date(), firstRender: true, heroShown: 0,
  };
  store.set("lastVisit", new Date().toISOString());

  function readHash() {
    const m = location.hash.match(/^#s=([\w,-]*)$/);
    if (m) S.sections = new Set(m[1].split(",").filter(Boolean));
  }
  function save() {
    store.set("sections", [...S.sections]); store.set("period", S.period); store.set("lang", S.lang);
    store.set("muted", [...S.muted]); store.set("tab", S.tab); store.set("theme", S.theme);
    const hash = S.sections.size ? "#s=" + [...S.sections].join(",") : "";
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

  // ---------- тема ----------
  function applyTheme() {
    const root = document.documentElement;
    if (S.theme === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", S.theme);
    const btn = $("theme-btn");
    btn.innerHTML = THEME_ICON[S.theme];
    btn.setAttribute("aria-label", THEME_LABEL[S.theme] + ". Нажмите, чтобы сменить");
    btn.title = THEME_LABEL[S.theme];
  }

  // ---------- фильтры ----------
  const words = () => S.q.toLowerCase().split(/\s+/).filter(Boolean);
  function baseFilter({ useText = true } = {}) {
    const ws = useText ? words() : [];
    return (p) => {
      if (S.muted.has(p.s)) return false;
      const src = S.srcById.get(p.s);
      if (!src) return false;
      if (S.lang !== "all" && src.lang !== S.lang) return false;
      if (ws.length) {
        const hay = (p.t + " " + (p.m || "") + " " + src.name).toLowerCase();
        if (!ws.every((w) => hay.includes(w))) return false;
      }
      return true;
    };
  }
  const inSections = (id) => !S.sections.size || S.sections.has(S.secOfSrc.get(id));
  const sinceMs = () => S.now - Number(S.period) * DAY;

  // плавная смена содержимого, где браузер это умеет
  function transition(fn) {
    if (document.startViewTransition && !reduceMotion && !S.firstRender) document.startViewTransition(fn);
    else fn();
  }

  // ---------- шапка ----------
  function renderHeader() {
    const m = S.meta;
    const live = S.sources.filter((s) => s.status !== "reference").length;
    $("eyebrow").textContent = `Каталог · ${S.sources.length} источников · ${m.sections.length} разделов · ${live} с лентами`;
    renderNextRun();
  }

  function renderNextRun() {
    const now = new Date();
    const minute = S.meta?.cron_minute ?? 17;
    const next = new Date(now); next.setUTCSeconds(0, 0); next.setUTCMinutes(minute);
    if (next <= now) next.setTime(next.getTime() + 3600e3);
    const mins = Math.max(1, Math.round((next - now) / 60e3));
    const progress = 1 - (next - now) / 3600e3;
    $("ring").style.strokeDashoffset = String(94.25 * (1 - progress));
    $("next-run-label").textContent = `Следующий сбор ≈ через ${mins} мин`;
    const up = $("updated");
    if (S.meta?.last_run) {
      const d = new Date(S.meta.last_run);
      const late = now - d > 3 * 3600e3;
      up.textContent = late ? `последний сбор ${relative(S.meta.last_run, now)} — задерживается`
        : `обновлено ${fmtTime.format(d)}, ${relative(S.meta.last_run, now)}`;
      up.classList.toggle("late", late);
    } else {
      up.textContent = "сборщик ещё не запускался";
    }
  }

  // бегущая строка
  function renderTicker() {
    const base = baseFilter({ useText: false });
    const items = S.posts.filter((p) => base(p) && !p.k).slice(0, 16);
    const track = $("ticker-track");
    if (!items.length) { $("ticker").hidden = true; return; }
    $("ticker").hidden = false;
    const make = () => items.map((p) => h("a", { class: "ticker-item", href: p.u, target: "_blank", rel: "noopener" },
      h("b", { text: S.srcById.get(p.s).name.replace(/[«»]/g, "") }), h("span", { text: p.t })));
    track.replaceChildren(...make(), ...make().map((a) => { a.setAttribute("aria-hidden", "true"); a.tabIndex = -1; return a; }));
    requestAnimationFrame(() => track.style.setProperty("--dur", `${Math.max(40, track.scrollWidth / 2 / 55)}s`));
  }

  // ---------- сводка ----------
  function animateNumber(el, to) {
    const from = S.heroShown;
    S.heroShown = to;
    if (reduceMotion || from === to) { el.textContent = to.toLocaleString("ru-RU"); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString("ru-RU");
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderSummary() {
    const base = baseFilter({ useText: false });
    const scoped = S.posts.filter((p) => base(p) && inSections(p.s));
    const day = scoped.filter((p) => S.now - new Date(p.d) <= DAY).length;
    const week = scoped.filter((p) => S.now - new Date(p.d) <= 7 * DAY).length;
    animateNumber($("hero-value"), day);
    $("hero-label").textContent = `${plural(day, ["новый пост", "новых поста", "новых постов"])} за сутки${S.sections.size ? " в выбранных разделах" : ""}`;
    $("stat-week").textContent = week.toLocaleString("ru-RU");
    const live = S.sources.filter((s) => s.status !== "reference" && inSections(s.id));
    const ok = live.filter((s) => s.status === "ok" || s.status === "stale").length;
    $("stat-sources").textContent = `${ok} из ${live.length}`;
    renderPulse(base);
  }

  // пульс: разделы × 14 дней + столбики итогов по дням
  function renderPulse(base) {
    const today = startOfDay(S.now);
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(today.getTime() - i * DAY));
    const keys = days.map(dayKey);
    const idx = new Map(keys.map((k, i) => [k, i]));
    const grid = new Map(S.meta.sections.map((s) => [s.id, new Array(14).fill(0)]));
    for (const p of S.posts) {
      if (!base(p)) continue;
      const i = idx.get(dayKey(new Date(p.d)));
      if (i === undefined) continue;
      const row = grid.get(S.secOfSrc.get(p.s));
      if (row) row[i]++;
    }
    const totals = keys.map((_, i) => S.meta.sections.reduce((a, s) => a + (inSections2(s.id) ? grid.get(s.id)[i] : 0), 0));
    const maxCell = Math.max(1, ...[...grid.values()].flat());
    const maxTotal = Math.max(1, ...totals);
    const level = (v) => (v === 0 ? 0 : Math.min(5, 1 + Math.floor((v / maxCell) * 4.999)));
    const anim = S.firstRender && !reduceMotion;

    const el = $("pulse");
    el.classList.toggle("has-sel", S.sections.size > 0);
    const kids = [h("div", { class: "pg-corner", text: "за день" })];
    totals.forEach((v, i) => {
      const isToday = i === 13;
      kids.push(h("div", { class: "pg-bar" + (isToday ? " today" : ""), "data-col": i, "data-total": v },
        v && (v === maxTotal || isToday) ? h("em", { text: v }) : null,
        h("i", { style: `--h:${Math.round((v / maxTotal) * 44)}px;--d:${anim ? i * 35 : 0}ms` })));
    });
    kids.push(h("div", { class: "pg-total-head", text: "Σ 14д" }));
    S.meta.sections.forEach((sec, r) => {
      const row = grid.get(sec.id);
      const on = S.sections.has(sec.id);
      const dim = S.sections.size && !on ? " pg-dim" : "";
      const label = h("button", { type: "button", class: "pg-label" + dim, title: `${sec.name} · УДК ${sec.udc}`,
        onclick: () => toggleSection(sec.id) }, h("span", { class: "udc", text: sec.udc }), h("span", { text: sec.name }));
      const wrap = h("div", { style: "display:contents", class: on ? "pg-row-on" : "" }, label);
      kids.push(wrap);
      row.forEach((v, i) => {
        kids.push(h("div", { class: `pg-cell lv${level(v)}${dim}`, tabindex: 0, role: "button",
          "data-sec": sec.id, "data-col": i, "data-v": v,
          "aria-label": `${sec.name}, ${fmtDay.format(days[i])}: ${nPosts(v)}`,
          style: `--d:${anim ? (i * 30 + r * 12) : 0}ms` }));
      });
      kids.push(h("div", { class: "pg-total" + dim, text: row.reduce((a, b) => a + b, 0) }));
    });
    kids.push(h("div"));
    days.forEach((d, i) => kids.push(h("div", { class: "pg-days" + (i === 13 ? " today" : ""),
      text: i === 13 ? "сег." : (i % 2 === 1 ? d.getDate() : "") })));
    kids.push(h("div"));
    el.replaceChildren(...kids);
    el._days = days;
    const sc = el.parentElement;
    if (S.firstRender && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;   // на телефоне сразу видны свежие дни
  }
  const inSections2 = (secId) => !S.sections.size || S.sections.has(secId);

  function wirePulse() {
    const el = $("pulse"), tip = $("tooltip");
    const show = (target) => {
      const cell = target.closest(".pg-cell, .pg-bar");
      if (!cell) { tip.hidden = true; return; }
      const col = Number(cell.dataset.col);
      const day = el._days[col];
      tip.replaceChildren();
      if (cell.classList.contains("pg-bar")) {
        const v = Number(cell.dataset.total);
        tip.append(h("strong", { text: v.toLocaleString("ru-RU") }), `${plural(v, ["пост", "поста", "постов"])} · ${fmtShort.format(day)}, ${fmtWd.format(day)}`);
      } else {
        const v = Number(cell.dataset.v);
        tip.append(h("strong", { text: v.toLocaleString("ru-RU") }), `${S.secById.get(cell.dataset.sec).name} · ${fmtShort.format(day)}`);
      }
      tip.hidden = false;
      const fig = el.closest(".pulse").getBoundingClientRect();
      const r = cell.getBoundingClientRect();
      const left = Math.min(Math.max(r.left - fig.left + r.width / 2, 70), fig.width - 70);
      tip.style.left = left + "px";
      tip.style.top = (r.top - fig.top) + "px";
    };
    el.addEventListener("pointerover", (e) => show(e.target));
    el.addEventListener("focusin", (e) => show(e.target));
    el.addEventListener("pointerleave", () => { tip.hidden = true; });
    el.addEventListener("focusout", () => { tip.hidden = true; });
    el.addEventListener("click", (e) => {
      const cell = e.target.closest(".pg-cell");
      if (cell) toggleSection(cell.dataset.sec);
    });
    el.addEventListener("keydown", (e) => {
      const cell = e.target.closest(".pg-cell");
      if (cell && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleSection(cell.dataset.sec); }
    });
  }

  function toggleSection(id) {
    S.sections.has(id) ? S.sections.delete(id) : S.sections.add(id);
    S.shown = PAGE; save(); transition(render);
  }

  // ---------- рейка разделов ----------
  function renderDrawers() {
    const base = baseFilter();
    const since = sinceMs();
    const counts = new Map();
    const refsMode = S.tab === "refs", srcMode = S.tab === "sources";
    if (refsMode || srcMode) {
      for (const s of S.sources) {
        if (refsMode && s.status !== "reference") continue;
        const sec = S.secOfSrc.get(s.id);
        counts.set(sec, (counts.get(sec) || 0) + 1);
      }
    } else {
      for (const p of S.posts) {
        if (new Date(p.d) < since || !base(p)) continue;
        const sec = S.secOfSrc.get(p.s);
        counts.set(sec, (counts.get(sec) || 0) + 1);
      }
    }
    $("drawer-list").replaceChildren(...S.meta.sections.map((sec) => {
      const on = S.sections.has(sec.id);
      const n = counts.get(sec.id) || 0;
      const input = h("input", { type: "checkbox", id: "sec-" + sec.id, checked: on });
      input.addEventListener("change", () => toggleSection(sec.id));
      return h("label", { class: "drawer" + (on ? " on" : "") + (n ? "" : " empty"), for: "sec-" + sec.id, title: `УДК ${sec.udc}` },
        input, h("span", { class: "udc", text: sec.udc }), h("span", { class: "name", text: sec.name }), h("span", { class: "count", text: n }));
    }));
    $("sections-all").hidden = !S.sections.size;
  }

  function renderSeg(id, options, value, onPick) {
    $(id).replaceChildren(...options.map(([v, label]) => h("button", {
      type: "button", role: "radio", "aria-checked": String(v === value),
      onclick: () => { onPick(v); S.shown = PAGE; save(); transition(render); },
    }, label)));
  }

  // ---------- лента ----------
  function renderFeed() {
    const base = baseFilter();
    const since = sinceMs();
    const list = S.posts.filter((p) => new Date(p.d) >= since && base(p) && inSections(p.s));
    const secNames = S.meta.sections.filter((s) => S.sections.has(s.id)).map((s) => s.name);
    $("selection").replaceChildren(h("b", { text: nPosts(list.length) }),
      secNames.length ? ` · ${secNames.join(", ")}` : " · все разделы",
      S.muted.size ? ` · скрыто источников: ${S.muted.size}` : "");

    const feed = $("feed");
    if (!list.length) {
      const never = !S.meta.last_run;
      feed.replaceChildren(h("div", { class: "empty-state" },
        h("strong", { text: never ? "Постов пока нет" : "Ничего не нашлось" }),
        never ? "Сборщик ещё не запускался. Откройте вкладку Actions в репозитории и запустите «Сбор постов»."
          : "За выбранный период в этих разделах ничего не вышло. Расширьте период, добавьте разделы или очистите фильтр."));
      $("more").hidden = true;
      return;
    }
    const shown = list.slice(0, S.shown);
    const groups = new Map();
    for (const p of shown) {
      const k = dayKey(new Date(p.d));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const dayCounts = new Map();
    for (const p of list) { const k = dayKey(new Date(p.d)); dayCounts.set(k, (dayCounts.get(k) || 0) + 1); }
    const todayK = dayKey(S.now), yestK = dayKey(new Date(S.now - DAY));
    const prev = S.prevVisit ? new Date(S.prevVisit) : null;
    let n = 0;
    feed.replaceChildren(...[...groups.entries()].map(([k, items]) => {
      const d = new Date(items[0].d);
      const label = k === todayK ? "Сегодня" : k === yestK ? "Вчера" : fmtDay.format(d);
      return h("section", { class: "day" },
        h("header", { class: "day-head" }, h("h2", { text: label }), h("span", { text: nPosts(dayCounts.get(k)) })),
        items.map((p) => entry(p, prev, S.firstRender && n++ < 14 ? n * 45 : null)));
    }));
    $("more").hidden = list.length <= S.shown;
    $("more").textContent = `Показать ещё (${list.length - S.shown})`;
  }

  function entry(p, prev, delay) {
    const src = S.srcById.get(p.s);
    const sec = S.secById.get(S.secOfSrc.get(p.s));
    const d = new Date(p.d);
    const isNew = prev && d > prev;
    const time = p.k
      ? h("span", { class: "approx", title: "У источника нет даты публикации: показано время, когда сборщик нашёл пост" }, "≈" + fmtTime.format(d))
      : h("time", { datetime: p.d }, fmtTime.format(d));
    const cls = "entry" + (isNew ? " is-new" : "") + (delay !== null && !reduceMotion ? " enter" : "");
    return h("article", { class: cls, style: delay !== null ? `--d:${delay}ms` : null },
      favicon(src),
      h("div", { class: "entry-meta" },
        h("span", { class: "udc", title: sec ? `${sec.name} · УДК ${sec.udc}` : "", text: sec ? sec.udc : "" }),
        h("span", { class: "src", title: src.about || "", text: src.name }),
        time, h("span", { text: (src.lang || "").toUpperCase() }),
        isNew ? h("span", { class: "new", text: "новое" }) : null),
      h("h3", {}, h("a", { href: p.u, target: "_blank", rel: "noopener", text: p.t })),
      p.m ? h("p", { text: p.m }) : null);
  }

  // ---------- справочники ----------
  function renderRefs() {
    const refs = S.sources.filter((s) => s.status === "reference");
    $("refs-count").textContent = refs.length;
    const groups = S.meta.sections.filter((sec) => inSections2(sec.id))
      .map((sec) => ({ sec, items: refs.filter((s) => S.secOfSrc.get(s.id) === sec.id) }))
      .filter((g) => g.items.length);
    let n = 0;
    $("refs-list").replaceChildren(...(groups.length ? groups.map(({ sec, items }) => h("section", { class: "group" },
      h("h2", { class: "group-head" }, h("span", { class: "udc", text: sec.udc }), sec.name,
        h("small", { text: `${items.length} ${plural(items.length, ["справочник", "справочника", "справочников"])}` })),
      h("div", { class: "ref-grid" }, items.map((s) => h("a", { class: "ref", href: s.url, target: "_blank", rel: "noopener",
        style: `--d:${reduceMotion ? 0 : Math.min(n++, 12) * 40}ms` },
        h("div", { class: "ref-top" }, favicon(s), h("span", { class: "ref-name", text: s.name })),
        h("p", { class: "ref-about", text: s.about || "" }),
        h("div", { class: "ref-foot" }, h("span", { text: `${s.host} · ${(s.lang || "").toUpperCase()}` }), h("span", { class: "go", text: "→" }))))))) :
      [h("div", { class: "empty-state" }, h("strong", { text: "В выбранных разделах справочников нет" }), "Снимите выбор разделов, чтобы увидеть все.")]));
  }

  // ---------- все источники ----------
  function renderSources() {
    const qs = S.sq.toLowerCase().split(/\s+/).filter(Boolean);
    const visibleSecs = S.meta.sections.filter((s) => inSections2(s.id));
    const pool = S.sources.filter((s) => visibleSecs.some((v) => v.id === S.secOfSrc.get(s.id)) &&
      (!qs.length || qs.every((w) => (s.name + " " + (s.about || "") + " " + s.host).toLowerCase().includes(w))));
    const counts = {};
    for (const s of pool) counts[s.status] = (counts[s.status] || 0) + 1;
    const chip = (key, label, n) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(S.statusFilter === key),
      onclick: () => { S.statusFilter = S.statusFilter === key ? null : key; transition(renderSources); },
    }, key ? h("span", { class: "sdot " + key }) : null, label, h("b", { text: n }));
    $("status-bar").replaceChildren(chip(null, "Все", pool.length),
      ...STATUS_ORDER.filter((k) => counts[k]).map((k) => chip(k, STATUS[k], counts[k])));

    const now = S.now;
    $("sources-list").replaceChildren(...visibleSecs.map((sec) => {
      const rows = pool.filter((s) => S.secOfSrc.get(s.id) === sec.id && (!S.statusFilter || s.status === S.statusFilter));
      if (!rows.length) return null;
      return h("section", { class: "group" },
        h("h2", { class: "group-head" }, h("span", { class: "udc", text: sec.udc }), sec.name, h("small", { text: rows.length })),
        h("div", { class: "src-list" }, rows.map((s) => {
          const muted = S.muted.has(s.id);
          const isRef = s.status === "reference";
          let method = METHOD[s.method?.split("+")[0]] || s.method || "—";
          if (s.method && s.method.includes("+telegram")) method += " + Telegram";
          const box = h("input", { type: "checkbox", id: "mute-" + s.id, checked: !muted });
          box.addEventListener("change", () => { box.checked ? S.muted.delete(s.id) : S.muted.add(s.id); save(); render(); });
          return h("div", { class: "src-row" + (muted ? " is-muted" : "") },
            favicon(s),
            h("div", { class: "src-main" },
              h("a", { class: "src-name", href: s.url, target: "_blank", rel: "noopener", text: s.name }),
              s.about ? h("p", { class: "src-about", text: s.about }) : null,
              h("div", { class: "src-facts" },
                h("span", { class: "status" }, h("span", { class: "sdot " + s.status }), STATUS[s.status] || s.status),
                isRef ? null : h("span", { text: method }),
                isRef ? null : h("span", { text: `последний пост: ${relative(s.last_post, now)}` }),
                isRef ? null : h("span", { text: `в архиве: ${s.total.toLocaleString("ru-RU")}` }),
                s.message && !["ok", "reference"].includes(s.status) ? h("span", { class: "src-msg", text: s.message }) : null)),
            h("div", { class: "src-side" }, isRef ? null :
              h("label", { class: "mute", for: "mute-" + s.id }, box, muted ? "скрыт" : "в ленте")));
        })));
    }));
    const bad = S.sources.filter((s) => s.status === "error").length;
    $("err-badge").hidden = !bad;
    $("err-badge").textContent = bad;
  }

  // ---------- случайная находка ----------
  function luckyPool(kind) {
    if (kind === "ref") return S.sources.filter((s) => s.status === "reference" && inSections(s.id));
    const base = baseFilter({ useText: false });
    let pool = S.posts.filter((p) => base(p) && inSections(p.s) && S.now - new Date(p.d) <= 14 * DAY);
    if (!pool.length) pool = S.posts.filter((p) => base(p));
    return pool;
  }
  function luckyCard(item, kind) {
    const card = $("lucky-card");
    if (kind === "ref") {
      const sec = S.secById.get(S.secOfSrc.get(item.id));
      card.replaceChildren(h("div", { class: "meta", text: `${sec.udc} · ${sec.name} · справочник` }),
        h("h3", { text: item.name }), h("p", { text: item.about || "" }));
      $("lucky-open").href = item.url;
    } else {
      const src = S.srcById.get(item.s);
      const sec = S.secById.get(S.secOfSrc.get(item.s));
      card.replaceChildren(h("div", { class: "meta", text: `${sec.udc} · ${src.name} · ${relative(item.d, S.now)}` }),
        h("h3", { text: item.t }), item.m ? h("p", { text: item.m }) : null);
      $("lucky-open").href = item.u;
    }
  }
  let luckyKind = "post", spinTimer = null;
  function spin() {
    const pool = luckyPool(luckyKind);
    const card = $("lucky-card");
    if (!pool.length) { card.replaceChildren(h("h3", { text: "Пока не из чего выбирать" })); return; }
    const pick = () => pool[Math.floor(Math.random() * pool.length)];
    clearTimeout(spinTimer);
    card.classList.remove("landed");
    if (reduceMotion) { luckyCard(pick(), luckyKind); return; }
    card.classList.add("spinning");
    let delay = 40, steps = 0;
    const tick = () => {
      luckyCard(pick(), luckyKind);
      steps++;
      delay *= 1.18;
      if (steps < 14) spinTimer = setTimeout(tick, delay);
      else { card.classList.remove("spinning"); card.classList.add("landed"); luckyCard(pick(), luckyKind); }
    };
    tick();
  }
  function openLucky(kind) {
    luckyKind = kind;
    $("lucky-title").textContent = kind === "ref" ? "Случайный справочник" : "Случайная находка";
    const dlg = $("lucky");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    spin();
  }

  // ---------- вкладки ----------
  function moveInk() {
    const btn = document.querySelector(`.tabs [data-tab="${S.tab}"]`);
    const ink = $("tab-ink");
    if (!btn) return;
    ink.style.setProperty("--x", btn.offsetLeft + "px");
    ink.style.setProperty("--w", btn.offsetWidth + "px");
  }
  function setTab(tab) {
    S.tab = tab;
    for (const b of document.querySelectorAll(".tabs [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    $("tab-feed").hidden = tab !== "feed";
    $("tab-refs").hidden = tab !== "refs";
    $("tab-sources").hidden = tab !== "sources";
    moveInk();
  }

  function render() {
    S.now = new Date();
    renderHeader();
    renderSummary();
    renderDrawers();
    renderSeg("period", PERIODS, S.period, (v) => { S.period = v; });
    renderSeg("lang", LANGS, S.lang, (v) => { S.lang = v; });
    renderFeed();
    renderRefs();
    renderSources();
    setTab(S.tab);
    S.firstRender = false;
  }

  async function load() {
    const get = (n) => fetch(`data/${n}.json`, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${n}.json: HTTP ${r.status}`);
      return r.json();
    });
    const [meta, sources, postsData] = await Promise.all([get("meta"), get("sources"), get("posts")]);
    S.meta = meta; S.sources = sources; S.posts = postsData;
    const secByName = new Map(meta.sections.map((s) => [s.name, s]));
    for (const s of meta.sections) S.secById.set(s.id, s);
    for (const s of sources) {
      if (s.status === "robots") s.status = "blocked";
      S.srcById.set(s.id, s);
      S.secOfSrc.set(s.id, secByName.get(s.section)?.id);
    }
    const known = new Set(meta.sections.map((s) => s.id));
    S.sections = new Set([...S.sections].filter((id) => known.has(id)));
  }

  function wire() {
    for (const b of document.querySelectorAll(".tabs [role=tab]")) {
      b.addEventListener("click", () => { transition(() => { setTab(b.dataset.tab); renderDrawers(); }); save(); });
    }
    $("theme-btn").addEventListener("click", () => {
      S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length];
      applyTheme(); save();
    });
    $("sections-all").addEventListener("click", () => { S.sections.clear(); S.shown = PAGE; save(); transition(render); });
    let t1, t2;
    $("q").addEventListener("input", (e) => {
      clearTimeout(t1);
      t1 = setTimeout(() => { S.q = e.target.value.trim(); S.shown = PAGE; renderFeed(); renderDrawers(); }, 150);
    });
    $("sq").addEventListener("input", (e) => {
      clearTimeout(t2);
      t2 = setTimeout(() => { S.sq = e.target.value.trim(); renderSources(); }, 150);
    });
    $("more").addEventListener("click", () => { S.shown += PAGE; renderFeed(); });
    $("lucky-btn").addEventListener("click", () => openLucky("post"));
    $("lucky-ref-btn").addEventListener("click", () => openLucky("ref"));
    $("lucky-again").addEventListener("click", spin);
    $("lucky").addEventListener("click", (e) => { if (e.target === $("lucky")) $("lucky").close(); });
    window.addEventListener("resize", moveInk);
    window.addEventListener("hashchange", () => { readHash(); render(); });
    wirePulse();
    setInterval(renderNextRun, 30e3);
    setInterval(() => { S.now = new Date(); renderHeader(); }, 5 * 60e3);
  }

  applyTheme();
  readHash();
  wire();
  load().then(() => { render(); renderTicker(); if (document.fonts) document.fonts.ready.then(moveInk); })
    .catch((err) => {
      $("updated").textContent = "не удалось загрузить данные";
      $("feed").replaceChildren(h("div", { class: "empty-state" }, h("strong", { text: "Данные не загрузились" }),
        `Проверьте, что сайт собран командой python -m dashboard. Ошибка: ${err.message}`));
    });
})();
