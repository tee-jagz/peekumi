/* Cache only public application assets. Repository data, credentials and API responses never enter Cache Storage. */
const CACHE = "peekumi-shell-__PEEKUMI_BUILD__";
const SHELL = [
  "/",
  "/app.js",
  "/icons.js",
  "/model.js",
  "/ask.js",
  "/workflow.js",
  "/canvas.js",
  "/select.js",
  "/text.js",
  "/peek.js",
  "/agents.js",
  "/style.css",
  "/pwa.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        // Caches from before the rename are cleared too.
        if (/^(peekumi|strata)-shell-/.test(name) && name !== CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data === "activate-update") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !SHELL.includes(url.pathname)
  )
    return;
  // Navigations may carry repository/ref IDs; only the generic shell is stored and returned offline.
  if (url.search && event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const response = await caches.match(url.pathname, { cacheName: CACHE });
      return response || Response.error();
    }),
  );
});
