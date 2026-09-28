const CACHE_NAME = 'mtg-draft-v17';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/config.js',
  './js/tournament.js',
  './js/league.js',
  './js/sync.js',
  './js/league-ui.js',
  './js/live.js',
  './js/main.js',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './fonts/plus-jakarta-sans.woff2',
  './fonts/fraunces.woff2'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' salta la cache HTTP (GitHub Pages: max-age 10 min), altrimenti la nuova versione
      // del service worker potrebbe mettere in cache un index.html vecchio
      .then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
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
    if (response.ok) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
    }
    return response;
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Tutto è self-hosted (font inclusi): le richieste cross-origin vanno lasciate al browser
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
