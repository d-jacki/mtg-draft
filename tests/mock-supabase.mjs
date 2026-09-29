// Finto Supabase in memoria per i test: PostgREST (league_docs, league_live con filtri eq/gt, order, limit)
// e le RPC league_push / league_live_push / league_live_sync con lo stesso contratto di supabase/schema.sql:
// PIN sbagliato → HTTP 200 {error}, blocco dopo 10 errori, last-write-wins su updated_at per i documenti,
// revisioni (compare-and-swap) per il torneo live, cronologia (league_live_history, come il trigger) e PIN master.
import { sandbox } from './harness.mjs';

export const LEAGUE = '11111111-2222-3333-4444-555555555555';
export const server = { rows: new Map(), live: null, history: [], pin: '1234', master: null, calls: [], failures: 0, legacy: false };

export function resetServer() { server.rows.clear(); server.live = null; server.history = []; server.master = null; server.calls = []; server.failures = 0; server.legacy = false; }
// Scrittura sul torneo live + copia in cronologia (in Postgres lo fa il trigger league_live_log)
export function setLive(live) {
  server.live = live;
  if (live && live.data) server.history = server.history.filter(h => h.rev !== live.rev).concat({ league_id: LEAGUE, rev: live.rev, data: JSON.parse(JSON.stringify(live.data)), updated_at: live.updated_at });
}
// select PostgREST: "col", "alias:data->>campo" (testo), "alias:data->campo" (json)
function pick(row, select) {
  const out = {};
  for (const item of select.split(',')) {
    const [alias, expr] = item.includes(':') ? item.split(':') : [item, item];
    const m = /^(\w+)(->>|->)(\w+)$/.exec(expr);
    if (!m) { out[alias] = row[expr]; continue; }
    const v = row[m[1]] ? row[m[1]][m[3]] : undefined;
    out[alias] = v === undefined || v === null ? null : m[2] === '->>' ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : v;
  }
  return out;
}

sandbox.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push({ path: u.pathname, method: opts.method || 'GET', headers: opts.headers, body, keepalive: opts.keepalive });
  // Copia: il client non deve condividere oggetti con il server finto
  const reply = (status, json) => ({ ok: status < 300, status, json: async () => (json === undefined ? json : JSON.parse(JSON.stringify(json))) });
  const checkPin = pin => {
    if (server.failures >= 10) return 'Troppi PIN sbagliati: riprova tra 15 minuti';
    if (pin === server.pin) return null;
    server.failures++; return 'PIN non valido';
  };
  if (u.pathname === '/rest/v1/league_docs') {
    const league = u.searchParams.get('league_id').replace('eq.', '');
    const since = Number(u.searchParams.get('updated_at').replace('gt.', ''));
    const limit = Number(u.searchParams.get('limit'));
    const rows = [...server.rows.values()].filter(r => r.league_id === league && r.updated_at > since)
      .sort((a, b) => a.updated_at - b.updated_at).slice(0, limit);
    return reply(200, rows.map(r => ({ id: r.id, kind: r.kind, data: r.data, updated_at: r.updated_at })));
  }
  if (u.pathname === '/rest/v1/league_live') {
    return reply(200, server.live ? [{ data: server.live.data, updated_at: server.live.updated_at, rev: server.live.rev || 0 }] : []);
  }
  if (u.pathname === '/rest/v1/league_live_history') {
    const q = u.searchParams, rev = q.get('rev'), tid = q.get('data->>id');
    let rows = server.history.filter(h => h.league_id === q.get('league_id').replace('eq.', ''));
    if (rev) rows = rows.filter(h => h.rev === Number(rev.replace('eq.', '')));
    if (tid) rows = rows.filter(h => h.data.id === tid.replace('eq.', ''));
    rows = rows.sort((a, b) => b.rev - a.rev).slice(0, Number(q.get('limit') || 1000));
    return reply(200, rows.map(h => pick(h, q.get('select'))));
  }
  if (u.pathname === '/rest/v1/rpc/league_info') return reply(200, { master: !!server.master });
  if (u.pathname === '/rest/v1/rpc/league_verify_master') {
    if (server.failures >= 10) return reply(200, { error: 'Troppi PIN sbagliati: riprova tra 15 minuti' });
    if (!server.master) return reply(200, { error: 'Questa lega non ha un PIN master (vedi supabase/schema.sql)' });
    if (body.p_pin === server.master) return reply(200, { ok: true });
    server.failures++; return reply(200, { error: 'PIN master errato' });
  }
  if (u.pathname === '/rest/v1/rpc/league_push') {
    const err = checkPin(body.p_pin);
    // Schema vecchio: PIN sbagliato come eccezione (HTTP 403)
    if (err && server.legacy) return reply(403, { message: err, code: '28P01' });
    if (err) return reply(200, { error: err });
    let n = 0;
    for (const d of body.p_docs) {
      const cur = server.rows.get(d.id);
      if (!cur || cur.updated_at < d.updated_at) { server.rows.set(d.id, { league_id: body.p_league, ...d }); n++; }
    }
    return reply(200, server.legacy ? n : { ok: true, written: n });
  }
  if (u.pathname === '/rest/v1/rpc/league_live_push') {
    const err = checkPin(body.p_pin);
    if (err) return reply(200, { error: err });
    if (!server.live || server.live.updated_at < body.p_updated_at) setLive({ data: body.p_data, updated_at: body.p_updated_at, rev: ((server.live && server.live.rev) || 0) + 1 });
    return reply(200, { ok: true });
  }
  if (u.pathname === '/rest/v1/rpc/league_live_sync') {
    const err = checkPin(body.p_pin);
    if (err) return reply(200, { error: err });
    const cur = server.live || { data: null, updated_at: 0, rev: 0 };
    if (body.p_data === null) {
      if (!cur.data || cur.data.id !== body.p_id) return reply(200, { ok: true, cleared: false, rev: cur.rev });
    } else if (body.p_rev !== null && cur.rev !== body.p_rev) {
      return reply(200, { conflict: true, rev: cur.rev, data: cur.data, updated_at: cur.updated_at });
    }
    setLive({ data: body.p_data, rev: cur.rev + 1, updated_at: Math.max(body.p_updated_at, cur.updated_at + 1) });
    return reply(200, { ok: true, cleared: body.p_data === null, rev: server.live.rev });
  }
  return reply(404, { message: 'not found' });
};
