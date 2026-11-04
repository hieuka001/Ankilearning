/* AnkiLearning service worker — app-shell cache for offline use.
 * Bump CACHE_VERSION whenever this file (or the caching strategy) changes.
 * Only same-origin GET requests are handled; Firestore / Google API traffic
 * is never intercepted or cached.
 */
const CACHE_VERSION = 'ankilearning-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch cross-origin traffic (Firestore, Google APIs, CDNs, ...).
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to the cached app shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches
            .open(STATIC_CACHE)
            .then((cache) => cache.put('/index.html', copy))
            .catch(() => undefined);
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(STATIC_CACHE);
          return (await cache.match('/index.html')) || Response.error();
        }),
    );
    return;
  }

  // Static assets (hashed JS/CSS, fonts, images, audio): cache-first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches
            .open(STATIC_CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      });
    }),
  );
});
