"use strict";
(() => {
  const PAGE = 100;
  const DAY = 86400000;
  const SESSION_GAP = 30 * 60e3;        // перерыв дольше получаса — новый визит (для метки «новое»)
  const SERIES_MIN = 4, SERIES_SHOW = 2; // от 4 постов одного сайта за день: показываем 2, остальное свёрнуто
  const LATE_HOURS = 8;               // сбор раз в 3 часа + запас на задержки GitHub
  const PERIODS = [["1", "24 ч"], ["3", "3 дня"], ["7", "7 дней"], ["30", "30 дней"]];
  const LANGS = [["all", "Все языки"], ["ru", "Рус"], ["en", "Англ"]];
  const METHOD = { rss: "RSS-лента", sitemap: "карта сайта", page: "страница сайта", auto: "ищет способ", reference: "справочник", pending: "—" };
  const STATUS = {
    ok: "Работает", stale: "Давно без постов", blocked: "Не пускает сборщик", limited: "Временно ограничил доступ",
    error: "Не работает", pending: "Ещё не проверялся", reference: "Справочник",
  };
  const PROBLEM = ["error", "blocked", "limited", "pending"];
  const THEMES = ["auto", "light", "dark"];
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" class="fill"/></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  };
  const THEME_LABEL = { auto: "Тема: как в системе", light: "Тема: светлая", dark: "Тема: тёмная" };
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

  // значок сайта: свой файл из fav/, иначе — первая буква названия
  function favicon(src, cls = "fav") {
    const letter = h("span", { class: "fav-letter", "aria-hidden": "true", text: (src.name.replace(/^[«"]/, "")[0] || "?").toUpperCase() });
    if (!src.icon) return letter;
    const img = h("img", { class: cls, alt: "", loading: "lazy", width: 22, height: 22, src: src.icon });
    img.addEventListener("error", () => img.replaceWith(letter), { once: true });
    return img;
  }

  // ---------- состояние ----------
  const S = {
    meta: null, sources: [], posts: [], srcById: new Map(), secById: new Map(), secOfSrc: new Map(), secIdx: new Map(),
    olderLoaded: false, olderLoading: false,
    sections: new Set(store.get("sections", [])),
    period: store.get("period", "7"),
    lang: store.get("lang", "all"),
    muted: new Set(store.get("muted", [])),
    tab: store.get("tab", "feed"),
    theme: store.get("theme", "auto"),
    dense: store.get("dense", false),
    hideRead: store.get("hideRead", false),
    q: "", sq: "", shown: PAGE, expanded: new Set(),
    prevVisit: null, now: Date.now(),
  };
  if (!["feed", "saved", "refs", "sources", "archive"].includes(S.tab)) S.tab = "feed";

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
    store.set("dense", S.dense); store.set("hideRead", S.hideRead);
    const hash = S.sections.size ? "#s=" + [...S.sections].join(",") : "";
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

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
  const inSections = (srcId) => !S.sections.size || S.sections.has(S.secOfSrc.get(srcId));
  const secOn = (secId) => !S.sections.size || S.sections.has(secId);
  const sinceMs = () => S.now - Number(S.period) * DAY;
  const secColor = (secId) => `--c: var(--s${(S.secIdx.get(secId) ?? 8) % 9})`;

  // ---------- строка состояния ----------
  function renderStatus() {
    const base = baseFilter({ useText: false });
    const scoped = S.posts.filter((p) => !p.k && base(p) && inSections(p.s));
    const day = scoped.filter((p) => S.now - p.ts <= DAY).length;
    const sinceVisit = S.prevVisit ? scoped.filter((p) => p.ts > S.prevVisit).length : 0;
    const kids = [h("b", { text: fmtN(day) }), ` ${plural(day, ["новый пост", "новых поста", "новых постов"])} за сутки`];
    if (S.sections.size) kids.push(" в выбранных разделах");
    if (sinceVisit && S.prevVisit && S.now - S.prevVisit > DAY / 24) kids.push(` · с прошлого визита ${fmtN(sinceVisit)}`);
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

  // ---------- пульс: разделы × 14 дней (свёрнут, считается только когда открыт) ----------
  function renderPulse() {
    if ($("pulse").hidden) return;
    const base = baseFilter({ useText: false });
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
    el.classList.toggle("has-sel", S.sections.size > 0);
    const kids = [h("div")];
    totals.forEach((v, i) => kids.push(h("div", { class: "pg-bar" + (i === 13 ? " today" : ""), "data-col": i, "data-total": v },
      v && (v === maxTotal || i === 13) ? h("em", { text: v }) : null, h("i", { style: `--h:${Math.round((v / maxTotal) * 34)}px` }))));
    kids.push(h("div"));
    for (const sec of S.meta.sections) {
      const row = grid.get(sec.id);
      const dim = S.sections.size && !S.sections.has(sec.id) ? " pg-dim" : "";
      kids.push(h("div", { class: "pg-label" + dim, title: `${sec.name} · УДК ${sec.udc}` },
        h("i", { class: "dot", style: secColor(sec.id) }), h("span", { text: sec.name })));
      row.forEach((v, i) => kids.push(h("div", { class: `pg-cell lv${level(v)}${dim}`, "data-sec": sec.id, "data-col": i, "data-v": v })));
      kids.push(h("div", { class: "pg-total" + dim, text: row.reduce((a, b) => a + b, 0) }));
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

  // ---------- разделы: одна строка «таблеток» для ленты, справочников и источников ----------
  function renderChips() {
    const feedMode = S.tab === "feed";
    let counts = null;
    if (feedMode) {
      counts = new Map();
      const base = baseFilter(), since = sinceMs();
      for (const p of S.posts) {
        if (p.k || p.ts < since || !base(p)) continue;
        const sec = S.secOfSrc.get(p.s);
        counts.set(sec, (counts.get(sec) || 0) + 1);
      }
    }
    const all = h("button", { type: "button", class: "chip", "aria-pressed": String(!S.sections.size),
      onclick: () => { S.sections.clear(); changed(); } }, "Все разделы");
    $("chips").replaceChildren(all, ...S.meta.sections.map((sec) => {
      const n = counts ? counts.get(sec.id) || 0 : null;
      return h("button", { type: "button", class: "chip" + (n === 0 ? " empty" : ""), "aria-pressed": String(S.sections.has(sec.id)),
        title: `УДК ${sec.udc}`, onclick: () => toggleSection(sec.id) },
      h("i", { class: "dot", style: secColor(sec.id) }), sec.name, n !== null ? h("b", { text: n }) : null);
    }));
  }
  function toggleSection(id) {
    S.sections.has(id) ? S.sections.delete(id) : S.sections.add(id);
    changed();
  }
  function changed() { S.shown = PAGE; S.expanded.clear(); save(); render(); }

  function renderSeg(id, options, value, onPick) {
    $(id).replaceChildren(...options.map(([v, label]) => h("button", {
      type: "button", role: "radio", "aria-checked": String(v === value),
      onclick: () => { onPick(v); changed(); },
    }, label)));
  }

  // ---------- лента ----------
  function renderFeed() {
    const base = baseFilter();
    const since = sinceMs();
    const list = S.posts.filter((p) => p.ts >= since && base(p) && inSections(p.s));
    const dated = list.filter((p) => !p.k);
    const undated = list.filter((p) => p.k);
    const feed = $("feed");
    feed.classList.toggle("dense", S.dense);

    if (S.period === "30" && !S.olderLoaded) {
      loadOlder();
      if (S.olderLoading) feed.replaceChildren(h("p", { class: "note", text: "Загружаю посты за месяц…" }));
    }
    if (!list.length) {
      if (S.period === "30" && S.olderLoading) return;
      const never = !S.meta.last_run;
      feed.replaceChildren(h("div", { class: "empty-state" },
        h("strong", { text: never ? "Постов пока нет" : "Ничего не нашлось" }),
        never ? "Сборщик ещё не запускался. Откройте вкладку Actions в репозитории и запустите «Сбор постов»."
          : "За выбранный период в этих разделах ничего не вышло. Расширьте период, выберите другие разделы или очистите поиск."));
      $("more").hidden = true;
      return;
    }

    const shown = dated.slice(0, S.shown);
    const allShown = shown.length === dated.length;
    const lastShownDay = shown.length ? shown[shown.length - 1].day : null;
    const groups = new Map();
    const group = (k) => { if (!groups.has(k)) groups.set(k, { dated: [], undated: [] }); return groups.get(k); };
    for (const p of shown) group(p.day).dated.push(p);
    for (const p of undated) if (allShown || (lastShownDay && p.day >= lastShownDay)) group(p.day).undated.push(p);
    const dayCounts = new Map();
    for (const p of dated) dayCounts.set(p.day, (dayCounts.get(p.day) || 0) + 1);

    const todayK = dayKey(S.now), yestK = dayKey(S.now - DAY);
    const days = [...groups.keys()].sort().reverse();
    feed.replaceChildren(...days.map((k) => {
      const g = groups.get(k);
      const label = k === todayK ? "Сегодня" : k === yestK ? "Вчера" : fmtDay.format(new Date(k + "T12:00"));
      const n = dayCounts.get(k) || 0;
      return h("section", { class: "day" },
        h("header", { class: "day-head" }, h("h2", { text: label }), n ? h("span", { text: nPosts(n) }) : null),
        dayEntries(k, g.dated),
        g.undated.length ? undatedBlock(k, g.undated) : null);
    }));
    $("more").hidden = allShown;
    $("more").textContent = `Показать ещё (${fmtN(dated.length - shown.length)})`;
  }

  // серии: если один сайт выпустил за день много постов, показываем пару, остальное — по кнопке
  function dayEntries(k, items) {
    const per = new Map();
    for (const p of items) per.set(p.s, (per.get(p.s) || 0) + 1);
    const seen = new Map(), out = [];
    for (const p of items) {
      const total = per.get(p.s);
      const key = k + "|" + p.s;
      const i = (seen.get(p.s) || 0) + 1;
      seen.set(p.s, i);
      if (total < SERIES_MIN || S.expanded.has(key) || i <= SERIES_SHOW) {
        out.push(entry(p));
        if (total >= SERIES_MIN && !S.expanded.has(key) && i === SERIES_SHOW) {
          const rest = total - SERIES_SHOW;
          out.push(h("button", { type: "button", class: "series",
            onclick: () => { S.expanded.add(key); renderFeed(); } },
          `${S.srcById.get(p.s).name} — ещё ${nPosts(rest)}`));
        }
      }
    }
    return out;
  }

  function undatedBlock(k, items) {
    const key = "undated|" + k;
    const open = S.expanded.has(key);
    const btn = h("button", { type: "button", class: "undated-btn", "aria-expanded": String(open),
      onclick: () => { open ? S.expanded.delete(key) : S.expanded.add(key); renderFeed(); } },
    open ? "Скрыть материалы без даты"
      : `Ещё ${fmtN(items.length)} ${plural(items.length, ["материал", "материала", "материалов"])} без точной даты — показать`);
    return h("div", { class: "undated" }, btn, open ? items.map((p) => entry(p)) : null);
  }

  function entry(p) {
    const src = S.srcById.get(p.s);
    const secId = S.secOfSrc.get(p.s);
    const sec = S.secById.get(secId);
    const isNew = !p.k && S.prevVisit && p.ts > S.prevVisit;
    const time = p.k
      ? h("span", { title: "У источника нет даты публикации: это время, когда сборщик нашёл материал" }, "найдено " + fmtTime.format(p.ts))
      : h("time", { datetime: p.d }, fmtTime.format(p.ts));
    return h("article", { class: "entry" + (isNew ? " is-new" : "") },
      favicon(src),
      h("div", { class: "entry-body" },
        h("div", { class: "entry-meta" },
          h("i", { class: "dot", style: secColor(secId), title: sec ? sec.name : "" }),
          h("span", { class: "src", title: src.about || "", text: src.name }),
          h("span", { class: "sep", "aria-hidden": "true" }), time,
          src.lang ? h("span", { class: "sep", "aria-hidden": "true" }) : null,
          src.lang ? h("span", { class: "lang", text: src.lang.toUpperCase() }) : null,
          isNew ? h("span", { class: "new", text: "новое" }) : null),
        h("h3", {}, extLink(p.u, { text: p.t })),
        p.m ? h("p", { text: p.m }) : null),
      saveButton(p));
  }

  function saveButton(p) {
    const on = Saved.has(p.i);
    return h("button", { type: "button", class: "save", "data-id": p.i, "aria-pressed": String(on), html: SAVE_ICON,
      "aria-label": on ? "Убрать из отложенного" : "Отложить на потом", title: on ? "Убрать из отложенного" : "Отложить на потом",
      onclick: () => { Saved.toggle(p); refreshSaveButtons(); renderSaved(); } });
  }
  function refreshSaveButtons() {
    for (const b of document.querySelectorAll(".save[data-id]")) {
      const on = Saved.has(b.dataset.id);
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", on ? "Убрать из отложенного" : "Отложить на потом");
      b.title = b.getAttribute("aria-label");
    }
    const n = Saved.list().filter((x) => !x.read).length;
    $("saved-count").hidden = !n;
    $("saved-count").textContent = n;
  }

  // ---------- отложенное: хранится в браузере, по желанию синхронизируется через GitHub Gist ----------
  const SYNC_FILE = "poznanie-saved.json";
  const TOMBSTONE_DAYS = 90;
  function normItem(x) {
    return { id: x.id, u: x.u, t: x.t, s: x.s || "", sn: x.sn || "", d: x.d || "", at: x.at || "",
      read: !!x.read, del: !!x.del, upd: Number(x.upd) || 0 };
  }
  function normData(data) {
    const items = {};
    for (const [id, x] of Object.entries((data && data.items) || {})) if (x && x.u) items[id] = normItem({ ...x, id });
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
    },
    setRead(id, read) { this.put({ ...this.data.items[id], read }); },
    remove(id) { this.put({ ...this.data.items[id], del: true }); },
    replace(data) { this.data = data; store.set("saved", data); },
  };

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
        description: "Сайты для познания — отложенное (синхронизация между устройствами)", public: false,
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
      renderSync(); this.run();
    },
    disconnect() {
      this.token = ""; this.gist = ""; this.state = ""; this.last = null;
      store.del("ghToken"); store.del("gistId"); store.del("syncAt"); renderSync();
    },
  };

  function renderSaved() {
    const all = Saved.list();
    const items = S.hideRead ? all.filter((x) => !x.read) : all;
    $("hide-read").checked = S.hideRead;
    if (!items.length) {
      $("saved-list").replaceChildren(h("div", { class: "empty-state" },
        h("strong", { text: all.length ? "Всё прочитано" : "Пока ничего не отложено" }),
        all.length ? "Снимите галочку «Скрыть прочитанное», чтобы увидеть всё." : "Нажмите на закладку справа от статьи в ленте — она появится здесь и не пропадёт через месяц."));
      return;
    }
    $("saved-list").replaceChildren(h("div", { class: "list" }, items.map((x) => {
      const src = S.srcById.get(x.s) || { name: x.sn || "", icon: null };
      return h("div", { class: "row" + (x.read ? " is-read" : "") },
        favicon(src),
        h("div", { class: "row-main" },
          extLink(x.u, { class: "row-name", text: x.t,
            onclick: () => { if (!x.read) { Saved.setRead(x.id, true); setTimeout(() => { renderSaved(); refreshSaveButtons(); }, 300); } } }),
          h("div", { class: "row-facts" },
            h("span", { text: src.name }),
            x.d ? h("span", { text: `вышло ${relative(x.d)}` }) : null,
            h("span", { text: `отложено ${relative(x.at)}` }))),
        h("div", { class: "row-actions" },
          h("button", { type: "button", class: "mini-btn", onclick: () => { Saved.setRead(x.id, !x.read); renderSaved(); refreshSaveButtons(); } },
            x.read ? "Не прочитано" : "Прочитано"),
          h("button", { type: "button", class: "mini-btn", "aria-label": "Удалить из отложенного", title: "Удалить",
            onclick: () => { Saved.remove(x.id); renderSaved(); refreshSaveButtons(); } }, "×")));
    })));
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
        h("p", { text: "Список хранится в этом браузере и копируется в ваш секретный gist на GitHub. На другом устройстве вставьте тот же ключ — списки объединятся." }),
        h("div", { class: "sync-form" },
          h("button", { type: "button", class: "btn", onclick: () => Sync.run() }, "Синхронизировать сейчас"),
          h("button", { type: "button", class: "btn", onclick: () => Sync.disconnect() }, "Отключить на этом устройстве")));
      return;
    }
    const input = h("input", { type: "password", placeholder: "ghp_…", autocomplete: "off", "aria-label": "Ключ GitHub" });
    body.replaceChildren(
      h("p", { text: "Без синхронизации список живёт только в этом браузере. Чтобы он был одинаковым на телефоне и компьютере, его можно хранить в секретном gist (заметке) на вашем GitHub." }),
      h("ol", {},
        h("li", {}, "Откройте ", extLink("https://github.com/settings/tokens/new?scopes=gist&description=%D0%A1%D0%B0%D0%B9%D1%82%D1%8B%20%D0%B4%D0%BB%D1%8F%20%D0%BF%D0%BE%D0%B7%D0%BD%D0%B0%D0%BD%D0%B8%D1%8F", { text: "создание ключа на GitHub" }),
          " — галочка уже стоит только на ", h("code", { text: "gist" }), ". Срок действия выберите сами."),
        h("li", {}, "Нажмите «Generate token» и скопируйте ключ (начинается с ", h("code", { text: "ghp_" }), ")."),
        h("li", {}, "Вставьте его сюда — на каждом своём устройстве по одному разу.")),
      h("p", { text: "Ключ хранится только в этом браузере и даёт доступ лишь к вашим gist, не к коду." }),
      h("form", { class: "sync-form", onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) Sync.connect(input.value); } },
        input, h("button", { type: "submit", class: "btn primary" }, "Подключить")));
  }

  // ---------- справочники ----------
  function renderRefs() {
    const refs = S.sources.filter((s) => s.status === "reference");
    const groups = S.meta.sections.filter((sec) => secOn(sec.id))
      .map((sec) => ({ sec, items: refs.filter((s) => S.secOfSrc.get(s.id) === sec.id) }))
      .filter((g) => g.items.length);
    $("refs-list").replaceChildren(...(groups.length ? groups.map(({ sec, items }) => h("section", { class: "group" },
      h("h2", { class: "group-head", title: `УДК ${sec.udc}` }, h("i", { class: "dot", style: secColor(sec.id) }), sec.name,
        h("small", { text: `${items.length} ${plural(items.length, ["справочник", "справочника", "справочников"])}` })),
      h("div", { class: "ref-grid" }, items.map((s) => extLink(s.url, { class: "ref" },
        h("div", { class: "ref-top" }, favicon(s), h("span", { class: "ref-name", text: s.name })),
        h("p", { class: "ref-about", text: s.about || "" }),
        h("div", { class: "ref-foot", text: `${s.host} · ${(s.lang || "").toUpperCase()}` })))))) :
      [h("div", { class: "empty-state" }, h("strong", { text: "В выбранных разделах справочников нет" }), "Выберите «Все разделы», чтобы увидеть все.")]));
  }

  // ---------- источники: простой список + свёрнутое «Состояние сборщика» ----------
  function renderSources() {
    const qs = S.sq.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = S.sources.filter((s) => secOn(S.secOfSrc.get(s.id)) &&
      (!qs.length || qs.every((w) => (s.name + " " + (s.about || "") + " " + s.host).toLowerCase().includes(w))));
    const groups = S.meta.sections.filter((sec) => secOn(sec.id))
      .map((sec) => ({ sec, rows: pool.filter((s) => S.secOfSrc.get(s.id) === sec.id) })).filter((g) => g.rows.length);
    $("sources-list").replaceChildren(...(groups.length ? groups.map(({ sec, rows }) => h("section", { class: "group" },
      h("h2", { class: "group-head", title: `УДК ${sec.udc}` }, h("i", { class: "dot", style: secColor(sec.id) }), sec.name, h("small", { text: rows.length })),
      h("div", { class: "list" }, rows.map((s) => {
        const muted = S.muted.has(s.id);
        const side = s.status === "reference" ? h("span", { class: "tag", text: "справочник" }) : (() => {
          const box = h("input", { type: "checkbox", checked: !muted, "aria-label": `Показывать ${s.name} в ленте` });
          box.addEventListener("change", () => { box.checked ? S.muted.delete(s.id) : S.muted.add(s.id); save(); render(); });
          return h("label", { class: "switch", title: muted ? "Скрыт из ленты" : "Показывается в ленте" }, box, "в ленте");
        })();
        return h("div", { class: "row" + (muted ? " is-muted" : "") },
          favicon(s),
          h("div", { class: "row-main" }, extLink(s.url, { class: "row-name", text: s.name }),
            s.about ? h("p", { class: "row-about", text: s.about }) : null),
          side);
      })))) : [h("div", { class: "empty-state" }, h("strong", { text: "Ничего не нашлось" }), "Измените запрос или выберите другие разделы.")]));
    renderDiag();
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
          h("td", { text: r.new }), h("td", { text: r.errors }), h("td", { text: `${Math.round(r.seconds)} с` })))))
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
      h("p", { class: "note", text: "Разовый сбой сайта не считается проблемой: «Не работает» появляется, только если сайт не ответил три запуска подряд." }));
  }

  // ---------- архив: поиск Pagefind по всем собранным статьям ----------
  const Archive = { pf: null, results: [], shown: 0, token: 0 };
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
  function setupArchive() {
    const sel = $("a-section");
    if (!sel.options.length) {
      sel.append(h("option", { value: "" }, "Все разделы"), ...S.meta.sections.map((s) => h("option", { value: s.name }, s.name)));
    }
    if (!S.meta.archive) {
      $("archive-list").replaceChildren(h("p", { class: "note", text: "Поиск по архиву появится после следующей сборки сайта." }));
      return false;
    }
    return true;
  }
  async function runArchive() {
    if (!setupArchive()) return;
    const q = $("aq").value.trim();
    const section = $("a-section").value;
    const sort = $("a-sort").value;
    const my = ++Archive.token;
    if (!q && !section) {
      Archive.results = [];
      $("a-more").hidden = true;
      $("archive-list").replaceChildren(h("p", { class: "note",
        text: `В архиве ${fmtN(S.meta.archive)} ${plural(S.meta.archive, ["статья", "статьи", "статей"])} — всё, что сборщик нашёл с первого дня. Введите слово или выберите раздел.` }));
      return;
    }
    $("archive-list").replaceChildren(h("p", { class: "note", text: "Ищу…" }));
    try {
      const pf = await pagefind();
      const opts = { filters: section ? { section } : {} };
      if (sort === "new" || !q) opts.sort = { date: "desc" };
      const res = await pf.search(q || null, opts);
      if (my !== Archive.token) return;
      Archive.results = res.results; Archive.shown = 0;
      $("archive-list").replaceChildren(h("p", { class: "note", text: res.results.length
        ? `Нашлось: ${fmtN(res.results.length)}` : "Ничего не нашлось. Попробуйте другое слово." }));
      await moreArchive(my);
    } catch (e) {
      $("archive-list").replaceChildren(h("p", { class: "note", text: `Поиск не загрузился: ${e.message}` }));
    }
  }
  async function moreArchive(my = Archive.token) {
    const chunk = Archive.results.slice(Archive.shown, Archive.shown + 20);
    const datas = await Promise.all(chunk.map((r) => r.data()));
    if (my !== Archive.token) return;
    Archive.shown += chunk.length;
    $("archive-list").append(...datas.map((d) => h("div", { class: "hit" },
      h("div", { class: "hit-meta" }, h("span", { text: d.meta.source }), h("span", { text: d.meta.date ? fmtShortYear.format(new Date(d.meta.date)) : "" })),
      h("h3", {}, extLink(d.meta.url, { text: d.meta.title })),
      d.excerpt ? h("p", {}, excerptNodes(d.excerpt)) : null)));
    $("a-more").hidden = Archive.shown >= Archive.results.length;
  }

  // ---------- случайная находка ----------
  function luckyPick() {
    const base = baseFilter({ useText: false });
    let pool = S.posts.filter((p) => !p.k && base(p) && inSections(p.s) && S.now - p.ts <= 14 * DAY);
    if (!pool.length) pool = S.posts.filter((p) => base(p));
    const card = $("lucky-card");
    if (!pool.length) { card.replaceChildren(h("h3", { text: "Пока не из чего выбирать" })); return; }
    const p = pool[Math.floor(Math.random() * pool.length)];
    const src = S.srcById.get(p.s);
    card.replaceChildren(h("div", { class: "meta", text: `${src.name} · ${relative(p.d, S.now)}` }),
      h("h3", { text: p.t }), p.m ? h("p", { text: p.m }) : null);
    $("lucky-open").setAttribute("href", safeUrl(p.u));
  }
  function openLucky() {
    const dlg = $("lucky");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    luckyPick();
  }

  // ---------- вкладки ----------
  function setTab(tab) {
    S.tab = tab;
    for (const b of document.querySelectorAll(".tabs [role=tab]")) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const t of ["feed", "saved", "refs", "sources", "archive"]) $("tab-" + t).hidden = tab !== t;
    $("feed-top").hidden = tab !== "feed";
    $("chips").hidden = !["feed", "refs", "sources"].includes(tab);
    if (tab === "archive") setupArchive() && runArchive();
  }

  function render() {
    S.now = Date.now();
    renderStatus();
    renderPulse();
    renderChips();
    renderSeg("period", PERIODS, S.period, (v) => { S.period = v; });
    renderSeg("lang", LANGS, S.lang, (v) => { S.lang = v; });
    $("density-btn").setAttribute("aria-pressed", String(S.dense));
    renderFeed();
    renderSaved();
    renderRefs();
    renderSources();
    refreshSaveButtons();
    setTab(S.tab);
  }

  const getJSON = (n) => fetch(`data/${n}.json`, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`${n}.json: HTTP ${r.status}`);
    return r.json();
  });
  const prep = (p) => { p.ts = Date.parse(p.d); p.day = dayKey(p.ts); return p; };   // даты разбираем один раз

  async function loadOlder() {
    if (S.olderLoaded || S.olderLoading || !S.meta.has_older) { S.olderLoaded ||= !S.meta.has_older; return; }
    S.olderLoading = true;
    try {
      const older = (await getJSON("posts-older")).map(prep);
      S.posts = S.posts.concat(older).sort((a, b) => b.ts - a.ts);
      S.olderLoaded = true;
    } catch { /* без старых постов лента всё равно работает */ S.olderLoaded = true; }
    S.olderLoading = false;
    renderChips(); renderFeed();
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
  }

  function wire() {
    const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
    tabs.forEach((b, i) => {
      b.addEventListener("click", () => { setTab(b.dataset.tab); renderChips(); save(); window.scrollTo({ top: 0 }); });
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); next.click();
      });
    });
    $("theme-btn").addEventListener("click", () => { S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]; applyTheme(); save(); });
    $("density-btn").addEventListener("click", () => { S.dense = !S.dense; save(); $("density-btn").setAttribute("aria-pressed", String(S.dense)); renderFeed(); });
    $("pulse-btn").addEventListener("click", () => {
      const open = $("pulse").hidden;
      $("pulse").hidden = !open;
      $("pulse-btn").setAttribute("aria-expanded", String(open));
      store.set("pulseOpen", open);
      renderPulse();
    });
    let t1, t2, t3;
    $("q").addEventListener("input", (e) => {
      clearTimeout(t1);
      t1 = setTimeout(() => { S.q = e.target.value.trim(); S.shown = PAGE; renderFeed(); renderChips(); }, 150);
    });
    $("sq").addEventListener("input", (e) => {
      clearTimeout(t2);
      t2 = setTimeout(() => { S.sq = e.target.value.trim(); renderSources(); }, 150);
    });
    $("aq").addEventListener("input", () => { clearTimeout(t3); t3 = setTimeout(runArchive, 250); });
    $("a-section").addEventListener("change", runArchive);
    $("a-sort").addEventListener("change", runArchive);
    $("a-more").addEventListener("click", () => moreArchive());
    $("more").addEventListener("click", () => { S.shown += PAGE; renderFeed(); });
    $("hide-read").addEventListener("change", (e) => { S.hideRead = e.target.checked; save(); renderSaved(); });
    $("diag").addEventListener("toggle", renderDiag);
    $("lucky-btn").addEventListener("click", openLucky);
    $("lucky-again").addEventListener("click", luckyPick);
    $("lucky").addEventListener("click", (e) => { if (e.target === $("lucky")) $("lucky").close(); });
    window.addEventListener("hashchange", () => { readHash(); render(); });
    wirePulse();
    // визит продолжается, пока страница открыта; вернулись после долгого перерыва — новый визит
    setInterval(() => { if (!document.hidden) touchVisit(); }, 60e3);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { touchVisit(); return; }
      const last = Date.parse(store.get("lastActive", "")) || 0;
      if (Date.now() - last > SESSION_GAP) { startVisit(); render(); }
      Sync.schedule(300);
    });
    setInterval(() => { if (!document.hidden) renderStatus(); }, 5 * 60e3);
    setInterval(() => { if (!document.hidden) Sync.schedule(0); }, 5 * 60e3);
  }

  applyTheme();
  readHash();
  startVisit();
  if (store.get("pulseOpen", false)) { $("pulse").hidden = false; $("pulse-btn").setAttribute("aria-expanded", "true"); }
  wire();
  renderSync();
  load().then(() => { render(); Sync.schedule(0); })
    .catch((err) => {
      $("status").textContent = "Не удалось загрузить данные";
      $("feed").replaceChildren(h("div", { class: "empty-state" }, h("strong", { text: "Данные не загрузились" }),
        `Проверьте связь или соберите сайт командой python -m dashboard. Ошибка: ${err.message}`));
    });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* без офлайн-режима сайт тоже работает */ });
  }
})();
