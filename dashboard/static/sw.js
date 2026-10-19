"use strict";
// Работа без сети. Страница и данные: сначала сеть (новая версия видна сразу), без сети — последняя копия.
// Шрифты и значки сайтов меняются редко: их берём из памяти телефона, не сверяясь с сервером при каждом открытии.
const VERSION = "__VERSION__";
const CACHE = "poznanie-" + VERSION;
const FONTS = "poznanie-fonts-v2";
const ICONS = "poznanie-icons-" + VERSION.slice(0, 7);   // значки перепроверяются раз в месяц
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icon-192.png",
  "apple-touch-icon.png", "data/meta.json", "data/sources.json", "data/posts.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  const keep = [CACHE, FONTS, ICONS];
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
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

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes("/pagefind/")) return;
  if (url.pathname.includes("/fonts/")) e.respondWith(cacheFirst(FONTS, req));
  else if (url.pathname.includes("/fav/")) e.respondWith(cacheFirst(ICONS, req));
  else e.respondWith(networkFirst(req));
});
