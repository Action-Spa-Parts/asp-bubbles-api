// Minimal service worker — required for PWA install. Caches the app shell so
// the app opens instantly and survives a flaky connection. API data is always
// fetched live (never cached).

const CACHE = "action-spa-warehouse-v115";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./logo.svg",
  "./bubbles-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./res-picking.png",
  "./jsbarcode.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ----- Push notifications -----
// A push from the server pops a system notification on the device, even when the
// app is closed. Payload is JSON: { title, body, tag, url, requireInteraction }.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Action Spa Warehouse";
  const opts = {
    body: data.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Tapping a notification focuses an open app window (or opens one).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) { try { w.navigate(url); } catch (_) {} return w.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  // Only cache GET requests for the static shell. POST API calls (same origin
  // now that the PWA is served from the Railway backend) skip the cache.
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
