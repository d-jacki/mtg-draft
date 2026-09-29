// Test del service worker: sw.js caricato in una sandbox con finti fetch e Cache Storage.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { check, section } from './harness.mjs';

section('Service worker');

const code = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const listeners = {}, stored = new Map();
let network = null;
const cache = { put: async (req, res) => { await new Promise(r => setTimeout(r, 20)); stored.set(req.url, res); }, addAll: async () => {} };
const sw = {
  self: { addEventListener: (t, fn) => { listeners[t] = fn; }, location: { origin: 'https://app.example' }, skipWaiting() {}, clients: { claim() {} } },
  caches: { open: async () => cache, match: async req => stored.get(typeof req === 'string' ? req : req.url), keys: async () => [], delete: async () => true },
  fetch: async () => network(),
  URL, Promise, setTimeout,
  Response: { error: () => ({ error: true }) },
  Request: class { constructor(url) { this.url = url; } },
};
sw.self.caches = sw.caches;
vm.createContext(sw);
vm.runInContext(code, sw);

function fire(url, mode = 'no-cors') {
  const e = { request: { method: 'GET', url, mode }, waits: [], response: null, waitUntil(p) { this.waits.push(p); }, respondWith(p) { this.response = p; } };
  listeners.fetch(e);
  return e;
}
const res = body => ({ ok: true, body, clone() { return res(body); } });

// Copia in cache: la pagina riceve subito la vecchia, la nuova viene salvata anche se la pagina ha già finito
{
  stored.set('https://app.example/js/main.js', res('vecchio'));
  network = async () => res('nuovo');
  const e = fire('https://app.example/js/main.js');
  const served = await e.response;
  check('sw: stale-while-revalidate serve la copia in cache', served.body === 'vecchio');
  check('sw: l\'aggiornamento della cache è tenuto vivo con waitUntil', e.waits.length === 1);
  await Promise.all(e.waits);
  check('sw: finito waitUntil la copia nuova è salvata', stored.get('https://app.example/js/main.js').body === 'nuovo');
}
// Offline: navigazione senza copia → index.html; cross-origin non toccato
{
  stored.set('./index.html', res('shell'));
  network = async () => { throw new Error('offline'); };
  const e = fire('https://app.example/lega', 'navigate');
  check('sw: offline, navigazione servita da index.html', (await e.response).body === 'shell');
  await Promise.all(e.waits);
  const x = fire('https://ovsq.supabase.co/rest/v1/league_docs');
  check('sw: richieste cross-origin lasciate al browser', x.response === null && x.waits.length === 0);
}
