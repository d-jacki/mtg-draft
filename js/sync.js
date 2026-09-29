// Sincronizzazione della lega con Supabase (facoltativa). Local-first: l'app funziona sempre offline,
// il sync scarica i documenti cambiati e carica quelli modificati qui (last-write-wins su updatedAt).
// Nessuna libreria: REST di PostgREST via fetch. Lettura libera con la chiave pubblica; la scrittura passa
// dalla funzione league_push che verifica il PIN della lega (vedi supabase/schema.sql).

const SYNC_KEY = 'mtg-sync';
const SYNC_PAGE = 500;
let syncCfg = null;
const syncState = { running: false, error: null, lastSync: 0 };
let _syncTimer = null;

// Senza configurazione salvata si usa la lega predefinita di js/config.js (sola lettura finché non si mette il PIN).
// {off: true} = l'utente ha scollegato il sync: la lega predefinita non viene riapplicata.
function defaultLeague() { return typeof DEFAULT_LEAGUE !== 'undefined' && DEFAULT_LEAGUE && DEFAULT_LEAGUE.url ? DEFAULT_LEAGUE : null; }
function loadSyncCfg() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) {}
  if (stored && stored.off) { syncCfg = null; return; }
  if (stored && stored.url) { syncCfg = stored; return; }
  syncCfg = null;
  const d = defaultLeague();
  if (d) configureSync({ url: d.url, key: d.key, league: d.league, pin: '', name: d.name });
}
function saveSyncCfg() { localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg || { off: true })); }
function syncConfigured() { return !!(syncCfg && syncCfg.url && syncCfg.key && syncCfg.league); }
function isDefaultLeague() { const d = defaultLeague(); return !!(d && syncCfg && syncCfg.url === d.url.replace(/\/+$/, '') && syncCfg.league === d.league); }
function syncCanWrite() { return syncConfigured() && !!syncCfg.pin; }

function configureSync({ url, key, league, pin, name }) {
  const prev = syncCfg || {};
  const sameLeague = prev.url === url && prev.league === league;
  syncCfg = { url: String(url).trim().replace(/\/+$/, ''), key: String(key).trim(), league: String(league).trim(), pin: pin ? String(pin) : '', name: name || prev.name || '', lastPull: sameLeague ? prev.lastPull || 0 : 0 };
  // Collegandosi a una lega nuova tutto l'archivio locale va caricato
  if (!sameLeague) L.dirty = leagueDocs().map(d => d.data.id);
  saveSyncCfg(); saveLeague(true);
}
function disconnectSync() { syncCfg = null; saveSyncCfg(); syncState.error = null; if (typeof stopLive === 'function') stopLive(); }
function reconnectDefault() { const d = defaultLeague(); if (!d) return; configureSync({ url: d.url, key: d.key, league: d.league, pin: '', name: d.name }); }

function sbHeaders() {
  const h = { apikey: syncCfg.key, 'Content-Type': 'application/json' };
  // Le chiavi legacy "anon" sono JWT e vanno anche in Authorization; le nuove sb_publishable_ no
  if (syncCfg.key.startsWith('eyJ')) h.Authorization = `Bearer ${syncCfg.key}`;
  return h;
}
async function sbError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.message || j.error || msg; } catch (e) {}
  if (/PIN non valido/i.test(msg)) return new Error('PIN non valido');
  return new Error(msg);
}

async function syncPull() {
  let since = syncCfg.lastPull || 0, pulled = 0;
  for (;;) {
    const q = `select=id,kind,data,updated_at&league_id=eq.${encodeURIComponent(syncCfg.league)}&updated_at=gt.${since}&order=updated_at.asc&limit=${SYNC_PAGE}`;
    const res = await fetch(`${syncCfg.url}/rest/v1/league_docs?${q}`, { headers: sbHeaders() });
    if (!res.ok) throw await sbError(res);
    const rows = await res.json();
    pulled += mergeLeagueDocs(rows.map(r => ({ kind: r.kind, data: r.data })), false);
    if (rows.length) since = Math.max(since, ...rows.map(r => Number(r.updated_at)));
    if (rows.length < SYNC_PAGE) break;
  }
  syncCfg.lastPull = since; saveSyncCfg();
  return pulled;
}
// Chiama una RPC di scrittura: gli errori di PIN arrivano come {error: '...'} con HTTP 200
async function sbRpc(name, body, keepalive) {
  const res = await fetch(`${syncCfg.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify(body), keepalive: !!keepalive });
  if (!res.ok) throw await sbError(res);
  let out = null; try { out = await res.json(); } catch (e) {}
  if (out && typeof out === 'object' && out.error) throw new Error(out.error);
  return out;
}
// Verifica il PIN senza scrivere niente (lista documenti vuota)
async function verifyPin(pin) {
  await sbRpc('league_push', { p_league: syncCfg.league, p_pin: pin, p_docs: [] });
  return true;
}
async function syncPush() {
  if (!syncCanWrite() || !L.dirty.length) return 0;
  const ids = L.dirty.slice();
  const docs = leagueDocs(ids).map(d => ({ id: d.data.id, kind: d.kind, data: d.data, updated_at: d.data.updatedAt }));
  await sbRpc('league_push', { p_league: syncCfg.league, p_pin: syncCfg.pin, p_docs: docs });
  // Tolgo dalla coda solo quello che ho mandato (se nel frattempo è cambiato altro resta in coda)
  L.dirty = L.dirty.filter(id => !ids.includes(id)); saveLeague(true);
  return docs.length;
}
async function syncNow(manual) {
  if (!syncConfigured() || syncState.running) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { syncState.error = 'Offline'; if (manual) toast('Sei offline'); return false; }
  syncState.running = true; syncState.error = null; renderSyncStatus();
  try {
    const pulled = await syncPull();
    const pushed = await syncPush();
    await syncLeagueInfo();
    syncState.lastSync = Date.now();
    if (pulled && typeof onLeagueSynced === 'function') onLeagueSynced();
    if (manual) toast(pulled || pushed ? `Sincronizzato (↓${pulled} ↑${pushed})` : 'Già tutto aggiornato');
    return true;
  } catch (e) {
    syncState.error = e.message || 'Errore di rete';
    if (manual) toast(`Sync: ${syncState.error}`);
    return false;
  } finally { syncState.running = false; renderSyncStatus(); }
}
// La lega ha un PIN master? (pubblico: dice solo se esiste). Facoltativo: con uno schema vecchio si ignora
async function syncLeagueInfo() {
  try { const out = await sbRpc('league_info', { p_league: syncCfg.league }); syncCfg.hasMaster = !!(out && out.master); saveSyncCfg(); } catch (e) {}
}
// Sync ritardato dopo una modifica locale (più salvataggi ravvicinati = una sola chiamata)
function syncSoon() { if (!syncConfigured()) return; clearTimeout(_syncTimer); _syncTimer = setTimeout(() => syncNow(false), 1500); }
function renderSyncStatus() { if (typeof renderSyncBox === 'function') renderSyncBox(); }

// Link di invito: configura il sync in sola lettura su un altro telefono (il PIN non viaggia nel link)
function b64urlEncode(s) { return btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); }
function syncInviteLink() {
  if (!syncConfigured()) return '';
  const payload = b64urlEncode(JSON.stringify({ u: syncCfg.url, k: syncCfg.key, l: syncCfg.league, n: syncCfg.name || '' }));
  return `${location.origin}${location.pathname}#join=${payload}`;
}
function applyInviteHash() {
  const m = /^#join=([A-Za-z0-9_-]+)$/.exec(location.hash || '');
  if (!m) return false;
  try {
    const d = JSON.parse(b64urlDecode(m[1]));
    if (!d.u || !d.k || !d.l) throw new Error('invalid');
    configureSync({ url: d.u, key: d.k, league: d.l, pin: syncCfg && syncCfg.league === d.l ? syncCfg.pin : '', name: d.n });
    history.replaceState(history.state, '', location.pathname);
    return true;
  } catch (e) { return false; }
}
