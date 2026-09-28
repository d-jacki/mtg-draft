// Test del sync Supabase contro un finto server PostgREST in memoria
// (filtri eq/gt, ordinamento, limit, e la funzione league_push con PIN e last-write-wins).
import { app, S, sandbox, check, section } from './harness.mjs';

section('Sync');

const LEAGUE = '11111111-2222-3333-4444-555555555555';
const server = { rows: new Map(), pin: '1234', calls: [] };
sandbox.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  server.calls.push({ path: u.pathname, method: opts.method || 'GET', headers: opts.headers });
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (u.pathname === '/rest/v1/league_docs') {
    const league = u.searchParams.get('league_id').replace('eq.', '');
    const since = Number(u.searchParams.get('updated_at').replace('gt.', ''));
    const limit = Number(u.searchParams.get('limit'));
    const rows = [...server.rows.values()].filter(r => r.league_id === league && r.updated_at > since)
      .sort((a, b) => a.updated_at - b.updated_at).slice(0, limit);
    return reply(200, rows.map(r => ({ id: r.id, kind: r.kind, data: r.data, updated_at: r.updated_at })));
  }
  if (u.pathname === '/rest/v1/rpc/league_push') {
    const { p_league, p_pin, p_docs } = JSON.parse(opts.body);
    if (p_pin !== server.pin) return reply(400, { message: 'PIN non valido', code: '28P01' });
    let n = 0;
    for (const d of p_docs) {
      const cur = server.rows.get(d.id);
      if (!cur || cur.updated_at < d.updated_at) { server.rows.set(d.id, { league_id: p_league, ...d }); n++; }
    }
    return reply(200, n);
  }
  return reply(404, { message: 'not found' });
};
function resetAll() {
  S.L.players = {}; S.L.tournaments = {}; S.L.dirty = []; app.saveLeague(true);
  server.rows.clear(); server.calls = [];
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
  S.syncCfg.lastPull = 0; // riscarica tutto, compreso il documento remoto più vecchio
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
