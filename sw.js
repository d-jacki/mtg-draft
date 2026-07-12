const CACHE_NAME = 'mtg-draft-v14';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './fonts/plus-jakarta-sans.woff2',
  './fonts/fraunces.woff2'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function fetchAndCache(request) {
  return fetch(request).then(response => {
    // Le risposte no-cors (font Google) sono "opaque": ok=false ma vanno cachate comunque
    if (response.ok || response.type === 'opaque') {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
    }
    return response;
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Font Google: cache-first (immutabili, evita dipendenza dalla rete a ogni avvio)
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetchAndCache(e.request))
    );
    return;
  }

  // Altre richieste cross-origin: lasciale al browser
  if (url.origin !== self.location.origin) return;

  // Shell same-origin: stale-while-revalidate; fallback a index.html solo per navigazioni
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetchAndCache(e.request).catch(() => null);
      return cached || network.then(r => {
        if (r) return r;
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
