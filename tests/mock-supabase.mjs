// Finto Supabase in memoria per i test: PostgREST (league_docs, league_live con filtri eq/gt, order, limit)
// e le RPC league_push / league_live_push con lo stesso contratto di supabase/schema.sql:
// PIN sbagliato → HTTP 200 {error}, blocco dopo 10 errori, last-write-wins su updated_at.
import { sandbox } from './harness.mjs';

export const LEAGUE = '11111111-2222-3333-4444-555555555555';
export const server = { rows: new Map(), live: null, pin: '1234', calls: [], failures: 0, legacy: false };

export function resetServer() { server.rows.clear(); server.live = null; server.calls = []; server.failures = 0; server.legacy = false; }

sandbox.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push({ path: u.pathname, method: opts.method || 'GET', headers: opts.headers, body, keepalive: opts.keepalive });
  const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
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
    return reply(200, server.live ? [{ data: server.live.data, updated_at: server.live.updated_at }] : []);
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
    if (!server.live || server.live.updated_at < body.p_updated_at) server.live = { data: body.p_data, updated_at: body.p_updated_at };
    return reply(200, { ok: true });
  }
  return reply(404, { message: 'not found' });
};
