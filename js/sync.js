// Sincronizzazione della lega con Supabase (facoltativa). Local-first: l'app funziona sempre offline,
// il sync scarica i documenti cambiati e carica quelli modificati qui (last-write-wins su updatedAt).
// Nessuna libreria: REST di PostgREST via fetch. Lettura libera con la chiave pubblica; la scrittura passa
// dalla funzione league_push che verifica il PIN della lega (vedi supabase/schema.sql).

const SYNC_KEY = 'mtg-sync';
const SYNC_PAGE = 500;
let syncCfg = null;
const syncState = { running: false, error: null, lastSync: 0 };
let _syncTimer = null;

function loadSyncCfg() { try { syncCfg = JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch (e) { syncCfg = null; } }
function saveSyncCfg() { if (syncCfg) localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg)); else localStorage.removeItem(SYNC_KEY); }
function syncConfigured() { return !!(syncCfg && syncCfg.url && syncCfg.key && syncCfg.league); }
function syncCanWrite() { return syncConfigured() && !!syncCfg.pin; }

function configureSync({ url, key, league, pin, name }) {
  const prev = syncCfg || {};
  const sameLeague = prev.url === url && prev.league === league;
  syncCfg = { url: String(url).trim().replace(/\/+$/, ''), key: String(key).trim(), league: String(league).trim(), pin: pin ? String(pin) : '', name: name || prev.name || '', lastPull: sameLeague ? prev.lastPull || 0 : 0 };
  // Collegandosi a una lega nuova tutto l'archivio locale va caricato
  if (!sameLeague) L.dirty = leagueDocs().map(d => d.data.id);
  saveSyncCfg(); saveLeague(true);
}
function disconnectSync() { syncCfg = null; saveSyncCfg(); syncState.error = null; }

function sbHeaders() {
  const h = { apikey: syncCfg.key, 'Content-Type': 'application/json' };
  // Le chiavi legacy "anon" sono JWT e vanno anche in Authorization; le nuove sb_publishable_ no
  if (syncCfg.key.startsWith('eyJ')) h.Authorization = `Bearer ${syncCfg.key}`;
  return h;
}
async function sbError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.message || j.error || msg; } catch (e) {}
  if (/PIN/i.test(msg)) return new Error('PIN non valido');
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
async function syncPush() {
  if (!syncCanWrite() || !L.dirty.length) return 0;
  const ids = L.dirty.slice();
  const docs = leagueDocs(ids).map(d => ({ id: d.data.id, kind: d.kind, data: d.data, updated_at: d.data.updatedAt }));
  const res = await fetch(`${syncCfg.url}/rest/v1/rpc/league_push`, {
    method: 'POST', headers: sbHeaders(),
    body: JSON.stringify({ p_league: syncCfg.league, p_pin: syncCfg.pin, p_docs: docs }),
  });
  if (!res.ok) throw await sbError(res);
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
