// Test del sync Supabase contro un finto server PostgREST in memoria
// (tests/mock-supabase.mjs: stesso contratto di supabase/schema.sql).
import { app, S, sandbox, check, section } from './harness.mjs';
import { LEAGUE, server, resetServer } from './mock-supabase.mjs';

section('Sync');

function resetAll() {
  S.L.players = {}; S.L.tournaments = {}; S.L.dirty = []; app.saveLeague(true);
  resetServer();
  app.disconnectSync();
}
const connect = pin => app.configureSync({ url: 'https://demo.supabase.co/', key: 'sb_publishable_abc', league: LEAGUE, pin, name: 'Giovedì' });

// ── 1. Primo collegamento: tutto l'archivio locale viene caricato ──
{
  resetAll();
  app.createPlayer('Anna'); app.createPlayer('Bruno'); app.saveLeague(true);
  connect('1234');
  const ok = await app.syncNow(false);
  check('sync: primo collegamento carica tutto l\'archivio', ok && server.rows.size === 2 && S.L.dirty.length === 0);
  const h = server.calls[0].headers;
  check('sync: chiave publishable solo in apikey (niente Bearer)', h.apikey === 'sb_publishable_abc' && !h.Authorization);
}

// ── 2. Modifica arrivata da un altro telefono ──
{
  const anna = app.findPlayerByName('Anna');
  const remote = { ...anna, name: 'Anna Bianchi', updatedAt: anna.updatedAt + 1000 };
  server.rows.set(anna.id, { league_id: LEAGUE, id: anna.id, kind: 'player', data: remote, updated_at: remote.updatedAt });
  await app.syncNow(false);
  check('sync: modifica remota scaricata', S.L.players[anna.id].name === 'Anna Bianchi');
  check('sync: ciò che arriva dal server non torna in coda', S.L.dirty.length === 0);
}

// ── 3. Modifica locale più recente di quella sul server: vince la locale ──
{
  const bruno = app.findPlayerByName('Bruno');
  app.updatePlayer(bruno.id, { emoji: '🐉' });
  const stale = { ...S.L.players[bruno.id], emoji: '🦉', updatedAt: S.L.players[bruno.id].updatedAt - 5 };
  server.rows.set(bruno.id, { league_id: LEAGUE, id: bruno.id, kind: 'player', data: stale, updated_at: stale.updatedAt + 0 });
  await app.syncNow(false);
  check('sync: LWW, la modifica locale più recente resta e viene caricata',
    S.L.players[bruno.id].emoji === '🐉' && server.rows.get(bruno.id).data.emoji === '🐉');
}

// ── 4. PIN sbagliato: errore chiaro, modifiche restano in coda ──
{
  connect('0000');
  app.createPlayer('Carla'); app.saveLeague(true);
  const ok = await app.syncNow(false);
  check('sync: PIN errato → errore esplicito', ok === false && S.syncState.error === 'PIN non valido');
  check('sync: con PIN errato le modifiche restano in coda', S.L.dirty.length > 0);
}

// ── 5. Sola lettura: scarica ma non prova a scrivere ──
{
  connect('');
  server.calls = [];
  await app.syncNow(false);
  check('sync: senza PIN nessuna chiamata di scrittura', server.calls.every(c => c.path !== '/rest/v1/rpc/league_push') && server.calls.length > 0);
}

// ── 6. Paginazione: più di 500 documenti ──
{
  resetAll();
  for (let i = 0; i < 1203; i++) server.rows.set(`p_bulk${i}`, { league_id: LEAGUE, id: `p_bulk${i}`, kind: 'player', data: { id: `p_bulk${i}`, name: `G${i}`, updatedAt: 1000 + i }, updated_at: 1000 + i });
  connect('');
  await app.syncNow(false);
  check('sync: scarica tutte le pagine', Object.keys(S.L.players).length === 1203);
}

// ── 7. Link invito: configura un altro telefono in sola lettura ──
{
  resetAll();
  connect('1234');
  const link = app.syncInviteLink();
  check('invito: il PIN non finisce nel link', !link.includes('1234') && link.includes('#join='));
  app.disconnectSync();
  sandbox.location.hash = link.slice(link.indexOf('#'));
  const ok = app.applyInviteHash();
  check('invito: link applicato, collegato in sola lettura', ok && app.syncConfigured() && !app.syncCanWrite() && S.syncCfg.name === 'Giovedì');
  sandbox.location.hash = '';
  app.disconnectSync();
}

const invite = (u, l = LEAGUE, n = 'Lega') => { sandbox.location.hash = '#join=' + app.b64urlEncode(JSON.stringify({ u, k: 'sb_publishable_abc', l, n })); };
const modalTitle = () => sandbox.document.getElementById('modalTitle');

// ── 8. Link invito con l'id della lega (pubblico) ma un altro server: il PIN non ci deve arrivare ──
{
  resetAll();
  app.createPlayer('Anna'); app.saveLeague(true);
  connect('1234');
  invite('https://evil.example.com');
  modalTitle().textContent = '';
  const ok = app.applyInviteHash();
  check('invito: altro server → chiede conferma invece di collegarsi', ok === false && modalTitle().textContent === 'Cambiare lega?' && S.syncCfg.url === 'https://demo.supabase.co' && S.syncCfg.pin === '1234');
  const seen = [], orig = sandbox.fetch;
  sandbox.fetch = (url, o) => { seen.push({ host: new URL(url).host, pin: o && o.body ? JSON.parse(o.body).p_pin : undefined }); return orig(url, o); };
  sandbox.document.getElementById('modalConfirm').onclick();
  await new Promise(r => setTimeout(r, 30));
  sandbox.fetch = orig;
  check('invito: confermato, collegato in sola lettura senza il PIN', S.syncCfg.url === 'https://evil.example.com' && !app.syncCanWrite());
  check('invito: il PIN non viene mai mandato all\'altro server', seen.length > 0 && seen.every(c => c.pin == null || c.host !== 'evil.example.com'), JSON.stringify(seen));
  app.stopLive(); sandbox.location.hash = '';
}

// ── 9. Link invito della stessa lega: il PIN resta ──
{
  resetAll();
  connect('1234');
  invite('https://demo.supabase.co/', LEAGUE, 'Giovedì sera');
  const ok = app.applyInviteHash();
  check('invito: stessa lega e stesso server → PIN conservato', ok && app.syncCanWrite() && S.syncCfg.name === 'Giovedì sera');
  invite('javascript:alert(1)');
  check('invito: URL non https scartato', app.applyInviteHash() === false && S.syncCfg.url === 'https://demo.supabase.co');
  sandbox.location.hash = '';
}

// ── 10. Modifica caricata in ritardo (offline o orologio indietro): arriva lo stesso ──
{
  resetAll();
  connect('');
  const now = Date.now();
  server.rows.set('p_nuovo', { league_id: LEAGUE, id: 'p_nuovo', kind: 'player', data: { id: 'p_nuovo', name: 'Nuovo', updatedAt: now }, updated_at: now });
  await app.syncNow(false);
  const late = now - 30 * 60e3;
  server.rows.set('p_tardi', { league_id: LEAGUE, id: 'p_tardi', kind: 'player', data: { id: 'p_tardi', name: 'Tardi', updatedAt: late }, updated_at: late });
  await app.syncNow(false);
  check('sync: documento più vecchio caricato dopo → scaricato comunque', !!S.L.players['p_tardi']);
  check('sync: si riparte dal seq del server', S.syncCfg.lastSeq === server.seq && server.calls.some(c => c.path.endsWith('league_docs')));
}

// ── 11. Schema vecchio senza seq: si ripiega su updated_at ──
{
  resetAll();
  server.noSeq = true;
  server.rows.set('p_vecchio', { league_id: LEAGUE, id: 'p_vecchio', kind: 'player', data: { id: 'p_vecchio', name: 'Vecchio', updatedAt: 5000 }, updated_at: 5000 });
  connect('');
  const ok = await app.syncNow(false);
  check('sync: schema vecchio → scarica con updated_at', ok && !!S.L.players['p_vecchio'] && S.syncCfg.lastPull === 5000, S.syncState.error);
  server.noSeq = false;
  app.disconnectSync();
}
