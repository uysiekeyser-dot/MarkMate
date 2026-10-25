/* Service worker: lets the Mark Calculator be installed as an app and open without internet.
 *
 * - The site's own files (page, script, style, icons): the newest version from the internet first,
 *   so updates uploaded to GitHub show up straight away; the saved copy when offline.
 * - The PDF and Word readers, and the fonts from other sites: the saved copy first
 *   (those files never change).
 * - Everything else (e.g. the Gemini AI reader) is left alone and always needs internet.
 *
 * Change CACHE when the list below changes, so old copies are cleared out.
 */
const CACHE = "mark-calculator-v5";

const SITE_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

const READER_FILES = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
  "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@400;600&display=swap",
];

// Other sites whose files never change: the readers and the fonts
const SAVED_FIRST_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SITE_FILES);
    // The readers are loaded by <script> tags from another site, so they're saved as "opaque" copies
    await Promise.allSettled(READER_FILES.map(async url => {
      const res = await fetch(url, { mode: "no-cors" });
      await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(newestFirst(req));
  else if (SAVED_FIRST_HOSTS.includes(url.hostname)) event.respondWith(savedFirst(req));
});

async function newestFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Offline: the saved copy (ignoring "?v=" numbers), or the app page itself
    return (await cache.match(req)) ||
      (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === "navigate" ? await cache.match("index.html") : Response.error());
  }
}

async function savedFirst(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req, { ignoreSearch: true });
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
