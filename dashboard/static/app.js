"use strict";
(() => {
  const PAGE = 120;
  const DAY = 86400000;
  const PERIODS = [["1", "24 ч"], ["3", "3 дня"], ["7", "7 дней"], ["30", "30 дней"]];
  const LANGS = [["all", "Все языки"], ["ru", "Рус"], ["en", "Англ"]];
  const METHOD = {
    rss: "RSS", sitemap: "карта сайта", page: "страница сайта", auto: "ищет способ",
    reference: "—", pending: "—",
  };
  const STATUS = {
    ok: "Работает", stale: "Давно без постов", error: "Ошибка",
    robots: "Закрыт robots.txt", pending: "Ещё не проверялся", reference: "Справочник",
  };
  const STATUS_ORDER = ["ok", "stale", "error", "robots", "pending", "reference"];

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
  const posts = (n) => `${n.toLocaleString("ru-RU")} ${plural(n, ["пост", "поста", "постов"])}`;

  const fmtTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long" });
  const fmtShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  const fmtShortYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  const dayKey = (d) => d.toLocaleDateString("sv-SE");
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  function relative(iso, now) {
    if (!iso) return "—";
    const d = new Date(iso), diff = now - d;
    if (diff < 60e3) return "только что";
    if (diff < 3600e3) { const m = Math.round(diff / 60e3); return `${m} мин назад`; }
    if (diff < DAY) { const hh = Math.round(diff / 3600e3); return `${hh} ч назад`; }
    if (diff < 30 * DAY) { const dd = Math.round(diff / DAY); return `${dd} ${plural(dd, ["день", "дня", "дней"])} назад`; }
    return (d.getFullYear() === now.getFullYear() ? fmtShort : fmtShortYear).format(d);
  }

  // ---------- состояние ----------
  const S = {
    meta: null, sources: [], posts: [], srcById: new Map(), secById: new Map(), secOfSrc: new Map(),
    sections: new Set(store.get("sections", [])),
    period: store.get("period", "7"),
    lang: store.get("lang", "all"),
    muted: new Set(store.get("muted", [])),
    tab: store.get("tab", "feed"),
    statusFilter: null,
    q: "",
    shown: PAGE,
    prevVisit: store.get("lastVisit", null),
    now: new Date(),
  };
  store.set("lastVisit", new Date().toISOString());

  function readHash() {
    const m = location.hash.match(/^#s=([\w,-]*)$/);
    if (m) S.sections = new Set(m[1].split(",").filter(Boolean));
  }
  function save() {
    store.set("sections", [...S.sections]);
    store.set("period", S.period);
    store.set("lang", S.lang);
    store.set("muted", [...S.muted]);
    store.set("tab", S.tab);
    const hash = S.sections.size ? "#s=" + [...S.sections].join(",") : "";
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

  // ---------- фильтры ----------
  const words = () => S.q.toLowerCase().split(/\s+/).filter(Boolean);
  function baseFilter() {
    const ws = words();
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
  const inSections = (p) => !S.sections.size || S.sections.has(S.secOfSrc.get(p.s));
  const sinceMs = () => S.now - Number(S.period) * DAY;

  // ---------- шапка и сводка ----------
  function renderHeader() {
    const m = S.meta;
    const total = S.sources.length;
    $("eyebrow").textContent = `Каталог · ${total} ${plural(total, ["источник", "источника", "источников"])} · ${m.sections.length} разделов`;
    const up = $("updated");
    up.replaceChildren();
    if (m.last_run) {
      const d = new Date(m.last_run);
      const late = S.now - d > 3 * 3600e3;
      up.append(`Сбор: ${fmtShort.format(d)}, ${fmtTime.format(d)} · ${relative(m.last_run, S.now)}`);
      if (late) up.append(h("span", { class: "late", text: " · сборщик давно не запускался" }));
    } else {
      up.textContent = "Сборщик ещё не запускался";
    }
  }

  function renderSummary(base) {
    const scoped = S.posts.filter((p) => base(p) && inSections(p));
    const day = scoped.filter((p) => S.now - new Date(p.d) <= DAY).length;
    const week = scoped.filter((p) => S.now - new Date(p.d) <= 7 * DAY).length;
    $("hero-value").textContent = day.toLocaleString("ru-RU");
    $("hero-label").textContent = `${plural(day, ["новый пост", "новых поста", "новых постов"])} за сутки`;
    $("stat-week").textContent = week.toLocaleString("ru-RU");
    const live = S.sources.filter((s) => s.status !== "reference" && (!S.sections.size || S.sections.has(S.secOfSrc.get(s.id))));
    const ok = live.filter((s) => s.status === "ok" || s.status === "stale").length;
    $("stat-sources").textContent = `${ok} из ${live.length}`;
    $("chart-sub").textContent = S.sections.size
      ? "последние 14 дней, выбранные разделы" : "последние 14 дней, все разделы";
    renderChart(scoped);
  }

  // ---------- график: посты по дням ----------
  let chartData = [];
  function renderChart(scoped) {
    const today = startOfDay(S.now);
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(today.getTime() - i * DAY));
    const counts = new Map(days.map((d) => [dayKey(d), 0]));
    for (const p of scoped) {
      const k = dayKey(new Date(p.d));
      if (counts.has(k)) counts.set(k, counts.get(k) + 1);
    }
    chartData = days.map((d) => ({ d, v: counts.get(dayKey(d)) }));
    drawChart();
  }

  function niceStep(max) {
    const raw = max / 3;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return Math.max(1, m * pow);
    return 10 * pow;
  }

  function drawChart() {
    const box = $("chart");
    const W = Math.max(box.clientWidth, 260), H = box.clientHeight || 150;
    const M = { l: 30, r: 6, t: 18, b: 22 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const max = Math.max(1, ...chartData.map((x) => x.v));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = (v) => M.t + ih - (v / top) * ih;
    const band = iw / chartData.length;
    const bw = Math.min(24, band * 0.62);
    const NS = "http://www.w3.org/2000/svg";
    const s = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Посты по дням за 14 дней" });

    for (let v = 0; v <= top; v += step) {
      svg.append(s("line", { class: v === 0 ? "baseline" : "grid", x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }));
      const t = s("text", { class: "tick", x: M.l - 6, y: y(v) + 3.5, "text-anchor": "end" });
      t.textContent = v >= 1000 ? (v / 1000) + "K" : v;
      svg.append(t);
    }
    const maxIdx = chartData.reduce((bi, x, i, a) => (x.v > a[bi].v ? i : bi), 0);
    const showEvery = band < 26 ? 2 : 1;
    chartData.forEach((x, i) => {
      const cx = M.l + band * i + band / 2;
      const bx = cx - bw / 2;
      const isToday = i === chartData.length - 1;
      const hit = s("rect", { class: "hit", x: M.l + band * i, y: M.t, width: band, height: ih, tabindex: 0,
        "aria-label": `${fmtDay.format(x.d)}: ${posts(x.v)}` });
      const show = () => showTip(cx, x.v ? y(x.v) : y(0), x);
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", hideTip);
      hit.addEventListener("blur", hideTip);
      svg.append(hit);
      if (x.v > 0) {
        const top_ = y(x.v), base = y(0), r = Math.min(4, (base - top_) / 2, bw / 2);
        const d = `M${bx},${base} L${bx},${top_ + r} Q${bx},${top_} ${bx + r},${top_} L${bx + bw - r},${top_} Q${bx + bw},${top_} ${bx + bw},${top_ + r} L${bx + bw},${base} Z`;
        svg.append(s("path", { class: "bar" + (isToday ? " today" : ""), d }));
      } else {
        svg.append(s("path", { class: "bar", d: "" }));
      }
      if ((i === maxIdx && x.v > 0) || (isToday && x.v > 0)) {
        const t = s("text", { class: "val", x: cx, y: y(x.v) - 5, "text-anchor": "middle" });
        t.textContent = x.v;
        svg.append(t);
      }
      if (isToday || (chartData.length - 1 - i) % showEvery === 0) {
        const t = s("text", { class: "tick", x: cx, y: H - 6, "text-anchor": "middle" });
        t.textContent = isToday ? "сег." : x.d.getDate();
        svg.append(t);
      }
    });
    box.replaceChildren(svg);
  }

  function showTip(cx, top, x) {
    const tip = $("tooltip");
    const box = $("chart");
    tip.replaceChildren(h("strong", { text: x.v.toLocaleString("ru-RU") }),
      `${plural(x.v, ["пост", "поста", "постов"])} · ${fmtShort.format(x.d)}`);
    tip.hidden = false;
    const fig = box.parentElement.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const scale = b.width / Math.max(box.clientWidth, 260);
    const left = Math.min(Math.max(b.left - fig.left + cx * scale, 60), fig.width - 60);
    tip.style.left = left + "px";
    tip.style.top = (b.top - fig.top + top * scale) + "px";
  }
  function hideTip() { $("tooltip").hidden = true; }

  // ---------- рейка разделов ----------
  function renderDrawers(base) {
    const since = sinceMs();
    const counts = new Map();
    for (const p of S.posts) {
      if (new Date(p.d) < since || !base(p)) continue;
      const sec = S.secOfSrc.get(p.s);
      counts.set(sec, (counts.get(sec) || 0) + 1);
    }
    const list = $("drawer-list");
    list.replaceChildren(...S.meta.sections.map((sec) => {
      const on = S.sections.has(sec.id);
      const n = counts.get(sec.id) || 0;
      const input = h("input", { type: "checkbox", id: "sec-" + sec.id, checked: on });
      input.addEventListener("change", () => {
        input.checked ? S.sections.add(sec.id) : S.sections.delete(sec.id);
        S.shown = PAGE; save(); render();
      });
      return h("label", { class: "drawer" + (on ? " on" : "") + (n ? "" : " empty"), for: "sec-" + sec.id,
        title: `УДК ${sec.udc}` },
        input,
        h("span", { class: "udc", text: sec.udc }),
        h("span", { class: "name", text: sec.name }),
        h("span", { class: "count", text: n }));
    }));
    $("sections-all").hidden = !S.sections.size;
  }

  // ---------- сегментные переключатели ----------
  function renderSeg(id, options, value, onPick) {
    const el = $(id);
    el.replaceChildren(...options.map(([v, label]) => h("button", {
      type: "button", role: "radio", "aria-checked": String(v === value),
      onclick: () => { onPick(v); S.shown = PAGE; save(); render(); },
    }, label)));
  }

  // ---------- лента ----------
  function renderFeed(base) {
    const since = sinceMs();
    const list = S.posts.filter((p) => new Date(p.d) >= since && base(p) && inSections(p));
    const sel = $("selection");
    const secNames = S.meta.sections.filter((s) => S.sections.has(s.id)).map((s) => s.name);
    sel.replaceChildren(
      h("b", { text: posts(list.length) }),
      secNames.length ? ` · ${secNames.join(", ")}` : " · все разделы",
      S.muted.size ? ` · скрыто источников: ${S.muted.size}` : "");

    const feed = $("feed");
    if (!list.length) {
      const never = !S.meta.last_run;
      feed.replaceChildren(h("div", { class: "empty-state" },
        h("strong", { text: never ? "Постов пока нет" : "Ничего не нашлось" }),
        never
          ? "Сборщик ещё не запускался. Откройте вкладку Actions в репозитории и запустите «Сбор постов» вручную."
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

    feed.replaceChildren(...[...groups.entries()].map(([k, items]) => {
      const d = new Date(items[0].d);
      const label = k === todayK ? "Сегодня" : k === yestK ? "Вчера" : fmtDay.format(d);
      return h("section", { class: "day" },
        h("header", { class: "day-head" },
          h("h2", { text: label }),
          h("span", { text: posts(dayCounts.get(k)) })),
        items.map((p) => entry(p, prev)));
    }));
    $("more").hidden = list.length <= S.shown;
    $("more").textContent = `Показать ещё (${list.length - S.shown})`;
  }

  function entry(p, prev) {
    const src = S.srcById.get(p.s);
    const sec = S.secById.get(S.secOfSrc.get(p.s));
    const d = new Date(p.d);
    const isNew = prev && d > prev;
    const time = p.k
      ? h("span", { class: "approx", title: "У источника нет даты публикации: показано время, когда сборщик нашёл пост" }, "≈" + fmtTime.format(d))
      : h("time", { datetime: p.d }, fmtTime.format(d));
    return h("article", { class: "entry" + (isNew ? " is-new" : "") },
      h("div", { class: "entry-meta" },
        h("span", { class: "udc", title: sec ? sec.name : "", text: sec ? sec.udc : "" }),
        h("span", { class: "src", text: src.name }),
        time,
        h("span", { text: (src.lang || "").toUpperCase() }),
        isNew ? h("span", { class: "new", text: "новое" }) : null),
      h("h3", {}, h("a", { href: p.u, target: "_blank", rel: "noopener", text: p.t })),
      p.m ? h("p", { text: p.m }) : null);
  }

  // ---------- источники ----------
  function renderSources() {
    const visibleSecs = S.meta.sections.filter((s) => !S.sections.size || S.sections.has(s.id));
    const pool = S.sources.filter((s) => visibleSecs.some((v) => v.id === S.secOfSrc.get(s.id)));
    const counts = {};
    for (const s of pool) counts[s.status] = (counts[s.status] || 0) + 1;

    const bar = $("status-bar");
    const chip = (key, label, n) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(S.statusFilter === key),
      onclick: () => { S.statusFilter = S.statusFilter === key ? null : key; renderSources(); },
    }, key ? h("span", { class: "sdot " + key }) : null, label, h("b", { text: n }));
    bar.replaceChildren(chip(null, "Все", pool.length),
      ...STATUS_ORDER.filter((k) => counts[k]).map((k) => chip(k, STATUS[k], counts[k])));

    const now = S.now;
    $("sources-list").replaceChildren(...visibleSecs.map((sec) => {
      const rows = pool.filter((s) => S.secOfSrc.get(s.id) === sec.id && (!S.statusFilter || s.status === S.statusFilter));
      if (!rows.length) return null;
      return h("section", { class: "src-section" },
        h("h2", {}, h("span", { class: "udc", text: sec.udc }), sec.name),
        h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {},
            h("th", { text: "Источник" }), h("th", { text: "Способ" }), h("th", { text: "Последний пост" }),
            h("th", { text: "Постов", style: "text-align:right" }), h("th", { text: "Статус" }), h("th", { text: "В ленте" }))),
          h("tbody", {}, rows.map((s) => {
            const muted = S.muted.has(s.id);
            const box = h("input", { type: "checkbox", id: "mute-" + s.id, checked: !muted,
              disabled: s.status === "reference" });
            box.addEventListener("change", () => {
              box.checked ? S.muted.delete(s.id) : S.muted.add(s.id);
              save(); render();
            });
            let method = METHOD[s.method?.split("+")[0]] || s.method || "—";
            if (s.method && s.method.includes("+telegram")) method += " + Telegram";
            return h("tr", { class: muted ? "is-muted" : "" },
              h("td", {}, h("a", { class: "name", href: s.url, target: "_blank", rel: "noopener", text: s.name })),
              h("td", {}, h("span", { class: "method", text: method })),
              h("td", { class: "when", text: s.status === "reference" ? "—" : relative(s.last_post, now) }),
              h("td", { class: "num", text: s.status === "reference" ? "—" : s.total.toLocaleString("ru-RU") }),
              h("td", {},
                h("span", { class: "status" }, h("span", { class: "sdot " + s.status }), STATUS[s.status] || s.status),
                s.message && s.status !== "ok" ? h("span", { class: "status-msg", text: s.message }) : null),
              h("td", {}, s.status === "reference" ? "—" :
                h("label", { class: "mute", for: "mute-" + s.id }, box, muted ? "скрыт" : "показан")));
          })))));
    }));
    const bad = S.sources.filter((s) => s.status === "error" || s.status === "robots").length;
    $("err-badge").hidden = !bad;
    $("err-badge").textContent = bad;
  }

  // ---------- вкладки и общий рендер ----------
  function setTab(tab) {
    S.tab = tab;
    for (const b of document.querySelectorAll(".tabs [role=tab]")) {
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    }
    $("tab-feed").hidden = tab !== "feed";
    $("tab-sources").hidden = tab !== "sources";
  }

  function render() {
    S.now = new Date();
    const base = baseFilter();
    renderHeader();
    renderSummary(base);
    renderDrawers(base);
    renderSeg("period", PERIODS, S.period, (v) => { S.period = v; });
    renderSeg("lang", LANGS, S.lang, (v) => { S.lang = v; });
    renderFeed(base);
    renderSources();
    setTab(S.tab);
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
      S.srcById.set(s.id, s);
      S.secOfSrc.set(s.id, secByName.get(s.section)?.id);
    }
    const known = new Set(meta.sections.map((s) => s.id));
    S.sections = new Set([...S.sections].filter((id) => known.has(id)));
  }

  function wire() {
    for (const b of document.querySelectorAll(".tabs [role=tab]")) {
      b.addEventListener("click", () => { setTab(b.dataset.tab); save(); });
    }
    $("sections-all").addEventListener("click", () => { S.sections.clear(); S.shown = PAGE; save(); render(); });
    let t;
    $("q").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => { S.q = e.target.value.trim(); S.shown = PAGE; render(); }, 150);
    });
    $("more").addEventListener("click", () => { S.shown += PAGE; renderFeed(baseFilter()); });
    if ("ResizeObserver" in window) new ResizeObserver(() => chartData.length && drawChart()).observe($("chart"));
    window.addEventListener("hashchange", () => { readHash(); render(); });
    setInterval(() => render(), 5 * 60e3);   // пересчитать «N мин назад»
  }

  readHash();
  wire();
  load().then(render).catch((err) => {
    $("updated").textContent = "Не удалось загрузить данные";
    $("feed").replaceChildren(h("div", { class: "empty-state" },
      h("strong", { text: "Данные не загрузились" }),
      `Проверьте, что сайт собран командой python -m dashboard. Ошибка: ${err.message}`));
  });
})();
