"use strict";
// Работа без сети: каждый ответ сайта кладём в кэш; если сети нет — отдаём последнюю копию.
// Сначала всегда пробуем сеть, поэтому новый дизайн и свежие данные появляются сразу.
const VERSION = "__VERSION__";
const CACHE = "poznanie-" + VERSION;
const FONTS = "poznanie-fonts";
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icon-192.png",
  "apple-touch-icon.png", "data/meta.json", "data/sources.json", "data/posts.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // no-cache: сверяемся с сервером (короткий ответ 304, если файл не менялся), чтобы новая версия была видна сразу
    const res = await (req.mode === "navigate"
      ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      : fetch(req, { cache: "no-cache" }));
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") return (await cache.match("index.html")) || Response.error();
    throw err;
  }
}

async function fontsCache(req) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(fontsCache(req));
  } else if (url.origin === location.origin && !url.pathname.includes("/pagefind/")) {
    e.respondWith(networkFirst(req));
  }
});
