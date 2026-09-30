const CACHE_NAME = 'mtg-draft-v23';
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
  './js/admin.js',
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

// saved: scrittura in cache, da tenere viva con waitUntil (la copia va fatta subito, prima che la pagina legga il body)
function fetchAndCache(request) {
  return fetch(request).then(response => {
    let saved = Promise.resolve();
    if (response.ok) {
      const clone = response.clone();
      saved = caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
    }
    return { response, saved };
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Tutto è self-hosted (font inclusi): le richieste cross-origin vanno lasciate al browser
  if (url.origin !== self.location.origin) return;

  // Shell same-origin: stale-while-revalidate; fallback a index.html solo per navigazioni.
  // Senza waitUntil il browser può fermare il service worker appena servita la copia in cache, prima che quella
  // nuova sia salvata: l'aggiornamento andrebbe perso.
  const network = fetchAndCache(e.request).catch(() => null);
  e.waitUntil(network.then(n => n && n.saved).catch(() => {}));
  e.respondWith(
    caches.match(e.request).then(cached => cached || network.then(n => {
      if (n) return n.response;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }))
  );
});
