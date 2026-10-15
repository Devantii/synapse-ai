// Synapse service worker: makes the app installable, opens offline with the last-loaded app shell,
// and shows end-of-session notifications. It never caches API responses or anything personal.
const CACHE = 'synapse-shell-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first, so updates show up immediately; the cached copy is only an offline fallback.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/vendor/')) return;
  const isPage = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (isPage || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isPage ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(isPage ? '/' : e.request).then((r) => r || Response.error()))
  );
});

// Clicking a notification brings the Synapse tab (or app window) to the front.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => new URL(c.url).origin === location.origin);
      return existing ? existing.focus() : self.clients.openWindow('/#/today');
    })
  );
});
