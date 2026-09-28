// Torneo live. Chi gestisce il torneo (telefono con il PIN) pubblica lo stato su Supabase a ogni modifica;
// gli altri telefoni della lega lo seguono in diretta: Realtime di Supabase (WebSocket, protocollo Phoenix)
// con lettura di riserva ogni 20 s se la connessione in tempo reale non c'è. Un solo torneo live per lega:
// l'ultima pubblicazione vince. Il torneo resta local-first: se la rete manca si ripubblica al ritorno.

const DEVICE_KEY = 'mtg-device', ME_KEY = 'mtg-me', LIVE_TOPIC = 'realtime:mtg-live';
const live = {
  data: null, updatedAt: 0, error: null, pubError: null, lastPublish: 0,
  pubTimer: null, pubRunning: false, pubPending: false,
  socket: null, joined: false, ref: 0, hb: null, retry: 0, poll: null, tick: null, started: false,
};

function deviceId() {
  let d = null;
  try { d = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!d) { d = uid('d'); try { localStorage.setItem(DEVICE_KEY, d); } catch (e) {} }
  return d;
}

// ── Pubblicazione (telefono che gestisce il torneo) ──
function livePublishEnabled() { return syncCanWrite() && syncCfg.live !== false; }
function setLivePublish(on) {
  if (!syncCfg) return;
  syncCfg.live = !!on; saveSyncCfg();
  if (on) livePublishSoon(); else if (T.started) livePublishNow(true);
  renderSyncBox();
}
function liveSnapshot() {
  return {
    device: deviceId(), publishedAt: Date.now(),
    started: T.started, ended: T.ended, mode: T.mode, set: T.set || '',
    totalRounds: T.totalRounds, currentRound: T.currentRound,
    players: T.players.map(p => ({ id: p.id, name: p.name, leagueId: p.leagueId || null, dropped: !!p.dropped })),
    rounds: T.rounds.map(r => ({ pairings: r.pairings.map(m => ({ p1: m.p1, p2: m.p2, p1wins: m.p1wins, p2wins: m.p2wins, draws: m.draws || 0, bye: !!m.bye, rest: !!m.rest, forfeit: !!m.forfeit })) })),
    timer: { total: TM.total, running: TM.running, seconds: TM.seconds, startedAt: TM.running ? TM.startedAt : null },
  };
}
// Chiamata da save(): più salvataggi ravvicinati = una sola pubblicazione
function livePublishSoon() {
  if (!livePublishEnabled() || !T.started) return;
  clearTimeout(live.pubTimer);
  live.pubTimer = setTimeout(() => livePublishNow(false), 800);
}
async function livePublishNow(clear, keepalive) {
  if (!syncCanWrite() || (!clear && (!T.started || syncCfg.live === false))) return false;
  if (live.pubRunning && !clear) { live.pubPending = true; return false; }
  live.pubRunning = true;
  try {
    await sbRpc('league_live_push', { p_league: syncCfg.league, p_pin: syncCfg.pin, p_data: clear ? null : liveSnapshot(), p_updated_at: Date.now() }, keepalive);
    live.pubError = null; live.lastPublish = Date.now();
    return true;
  } catch (e) {
    live.pubError = e.message || 'Errore di rete';
    return false;
  } finally {
    live.pubRunning = false;
    if (live.pubPending) { live.pubPending = false; livePublishSoon(); }
    if (typeof renderLiveBadge === 'function') renderLiveBadge();
  }
}
// "Nuovo torneo" sul telefono che pubblicava: toglie il torneo dal live (keepalive: la pagina si ricarica subito)
function liveClearOnReset() { if (T.started && livePublishEnabled()) livePublishNow(true, true); }
function liveBadgeHtml() {
  if (!livePublishEnabled() || !T.started || T.ended) return '';
  const err = live.pubError;
  return `<span class="mode-badge live${err ? ' err' : ''}" id="liveBadge" title="${err ? esc('Live non aggiornato: ' + err) : 'Gli altri telefoni della lega seguono il torneo in diretta'}">● LIVE</span>`;
}
function renderLiveBadge() { const b = document.getElementById('liveBadge'); if (b && b.outerHTML !== undefined) b.outerHTML = liveBadgeHtml() || '<span id="liveBadge"></span>'; }

// ── Lettura (telefoni che seguono) ──
function liveApply(data, updatedAt) {
  if (updatedAt != null) { if (Number(updatedAt) < live.updatedAt) return; live.updatedAt = Number(updatedAt); }
  live.data = data || null;
  renderLiveUI();
}
async function liveFetch() {
  if (!syncConfigured()) return;
  try {
    const res = await fetch(`${syncCfg.url}/rest/v1/league_live?select=data,updated_at&league_id=eq.${encodeURIComponent(syncCfg.league)}`, { headers: sbHeaders() });
    if (!res.ok) throw await sbError(res);
    const rows = await res.json();
    if (rows.length) liveApply(rows[0].data, rows[0].updated_at); else liveApply(null, null);
    live.error = null;
  } catch (e) {
    live.error = /league_live/.test(e.message || '') ? 'Rilancia supabase/schema.sql per attivare il live' : (e.message || 'Errore di rete');
  }
}
function liveVisible() {
  const d = live.data;
  if (!d || !d.started || d.device === deviceId()) return false;
  const age = Date.now() - (d.publishedAt || 0);
  return d.ended ? age < 6 * 3600e3 : age < 24 * 3600e3;
}

// ── Realtime (Phoenix su WebSocket, senza librerie) ──
function wsSend(ws, topic, event, payload) {
  const msg = { topic, event, payload, ref: String(++live.ref) };
  if (topic !== 'phoenix') msg.join_ref = '1';
  ws.send(JSON.stringify(msg));
}
function liveOnMessage(msg) {
  if (!msg || msg.topic !== LIVE_TOPIC) return;
  if (msg.event === 'phx_reply' && msg.ref === '1') {
    live.joined = msg.payload && msg.payload.status === 'ok';
    if (live.joined) { live.retry = 0; liveFetch(); }
  } else if (msg.event === 'system' && msg.payload && msg.payload.status === 'error') {
    live.joined = false;
  } else if (msg.event === 'postgres_changes') {
    const d = msg.payload && msg.payload.data;
    if (!d) return;
    if (d.type === 'DELETE') liveApply(null, null);
    else if (d.record) liveApply(d.record.data, d.record.updated_at);
  }
}
function liveConnect() {
  if (!syncConfigured() || typeof WebSocket === 'undefined' || live.socket) return;
  if (document.visibilityState === 'hidden') return;
  let ws;
  try { ws = new WebSocket(`${syncCfg.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(syncCfg.key)}&vsn=1.0.0`); } catch (e) { return; }
  live.socket = ws; live.joined = false; live.ref = 0;
  ws.onopen = () => {
    const payload = { config: { broadcast: { ack: false, self: false }, presence: { key: '' }, private: false,
      postgres_changes: [{ event: '*', schema: 'public', table: 'league_live', filter: `league_id=eq.${syncCfg.league}` }] } };
    if (syncCfg.key.startsWith('eyJ')) payload.access_token = syncCfg.key;
    wsSend(ws, LIVE_TOPIC, 'phx_join', payload);
    clearInterval(live.hb);
    live.hb = setInterval(() => { try { wsSend(ws, 'phoenix', 'heartbeat', {}); } catch (e) {} }, 25000);
  };
  ws.onmessage = e => { try { liveOnMessage(JSON.parse(e.data)); } catch (err) {} };
  ws.onclose = () => {
    clearInterval(live.hb); live.socket = null; live.joined = false;
    if (live.started && syncConfigured() && document.visibilityState !== 'hidden') setTimeout(liveConnect, Math.min(30000, 2000 * 2 ** live.retry++));
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function liveDisconnect() { const ws = live.socket; live.socket = null; live.joined = false; clearInterval(live.hb); if (ws) try { ws.close(); } catch (e) {} }

function startLive() {
  if (!syncConfigured()) return;
  live.started = true;
  liveFetch(); liveConnect();
  if (!live.poll) live.poll = setInterval(() => { if (!live.joined && document.visibilityState !== 'hidden') liveFetch(); }, 20000);
  if (!live.tick) live.tick = setInterval(() => { const el = document.getElementById('liveTimer'); if (el && live.data) el.textContent = liveTimerText(live.data); }, 1000);
}
function stopLive() {
  live.started = false; liveDisconnect();
  clearInterval(live.poll); clearInterval(live.tick); live.poll = live.tick = null;
  live.data = null; live.updatedAt = 0; renderLiveUI();
}
document.addEventListener('visibilitychange', () => {
  if (!live.started) return;
  if (document.visibilityState === 'hidden') liveDisconnect();
  else { liveFetch(); liveConnect(); }
});

// ── Vista "Segui live" ──
// I calcoli del torneo lavorano sull'oggetto globale T: per la classifica live lo si scambia temporaneamente
function withLiveTournament(d, fn) {
  const keys = ['players', 'rounds', 'mode', 'totalRounds', 'currentRound', 'started', 'ended'], saved = {};
  keys.forEach(k => { saved[k] = T[k]; });
  try {
    Object.assign(T, { players: d.players, rounds: d.rounds, mode: d.mode, totalRounds: d.totalRounds, currentRound: d.currentRound, started: true, ended: !!d.ended });
    return fn();
  } finally { Object.assign(T, saved); }
}
function liveTimerText(d) {
  const t = d.timer;
  if (!t || d.mode === 'roundrobin' || d.ended) return '';
  const secs = t.running && t.startedAt ? Math.floor((Date.now() - t.startedAt) / 1000) : t.seconds || 0;
  const rem = t.total - secs, m = Math.floor(Math.abs(rem) / 60), s = Math.abs(rem) % 60;
  return `${rem < 0 ? '+' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${t.running ? '' : ' ⏸'}`;
}
function liveMe() { try { return localStorage.getItem(ME_KEY) || ''; } catch (e) { return ''; } }
function setLiveMe(name) { try { localStorage.setItem(ME_KEY, name); } catch (e) {} renderLiveUI(); }

function liveBannerHtml() {
  if (!liveVisible()) return '';
  const d = live.data;
  return `<button class="live-banner" onclick="openLive()"><span class="live-dot" aria-hidden="true"></span><span class="live-banner-text"><b>${d.ended ? 'Torneo appena concluso' : 'Torneo in corso'}</b> · ${d.ended ? 'classifica finale' : `Round ${d.currentRound}/${d.totalRounds}`}${d.set ? ' · ' + esc(d.set) : ''}</span><span class="live-go">Segui →</span></button>`;
}
function renderLiveView() {
  const d = live.data;
  if (!d) return `<button class="btn btn-secondary btn-sm mb" onclick="closeLive()">← Lega</button><div class="card text-center text-dim">Nessun torneo in corso.</div>`;
  return withLiveTournament(d, () => {
    const isRR = d.mode === 'roundrobin', round = d.rounds[d.currentRound - 1];
    const me = liveMe().toLowerCase(), meP = d.players.find(p => p.name.toLowerCase() === me);
    const name = id => { const p = P(id); return p ? esc(p.name) : '?'; };
    const updated = new Date(d.publishedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let h = `<button class="btn btn-secondary btn-sm mb" onclick="closeLive()">← Lega</button>
      <div class="card live-head"><div class="live-head-row"><span class="live-dot" aria-hidden="true"></span><span class="live-kicker">${d.ended ? 'Concluso' : 'In diretta'}</span><span class="text-xs text-dim" style="margin-left:auto;">agg. ${updated}</span></div>
      <div class="live-title">${d.ended ? 'Classifica finale' : `Round ${d.currentRound} <span>/ ${d.totalRounds}</span>`}</div>
      <div class="text-xs text-dim">${isRR ? 'Round robin BO1' : 'Swiss'}${d.set ? ' · ' + esc(d.set) : ''} · ${d.players.length} giocatori</div>
      ${!d.ended && !isRR ? `<div class="live-timer" id="liveTimer" aria-label="Tempo del round">${liveTimerText(d)}</div>` : ''}</div>`;
    // "Io sono…": evidenzia il proprio tavolo
    h += `<div class="card"><label class="field-label" for="liveMeSel">Io sono</label><select id="liveMeSel" onchange="setLiveMe(this.value)"><option value="">Scegli il tuo nome…</option>${d.players.map(p => `<option value="${esc(p.name)}"${p.name.toLowerCase() === me ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
    if (meP && round && !d.ended) {
      const i = round.pairings.findIndex(m => m.p1 === meP.id || m.p2 === meP.id), m = round.pairings[i];
      let mine = 'Non sei in questo round';
      if (m && m.rest) mine = '💤 Riposi questo round';
      else if (m && m.bye) mine = '🎁 Hai il bye (vittoria 2–0)';
      else if (m) { const opp = m.p1 === meP.id ? m.p2 : m.p1; mine = `<span class="live-mine-table">Tavolo ${i + 1}</span> contro <b>${name(opp)}</b>${m.p1wins != null ? ` · ${fmtRes(m)}` : ''}`; }
      h += `<div class="live-mine">${mine}</div>`;
    }
    h += `</div>`;
    if (round && !d.ended) {
      h += `<div class="card"><div class="card-title">Round ${d.currentRound}</div>${round.pairings.map((m, i) => {
        const hl = meP && (m.p1 === meP.id || m.p2 === meP.id) ? ' me' : '';
        if (m.rest) return `<div class="live-match${hl}"><span class="live-table">—</span><span class="live-names">${name(m.p1)} riposa</span></div>`;
        if (m.bye) return `<div class="live-match${hl}"><span class="live-table">Bye</span><span class="live-names">${name(m.p1)}</span><span class="live-res">2–0</span></div>`;
        return `<div class="live-match${hl}"><span class="live-table">T${i + 1}</span><span class="live-names">${name(m.p1)} <span class="text-dim">vs</span> ${name(m.p2)}</span><span class="live-res${m.p1wins == null ? ' pending' : ''}">${m.p1wins == null ? 'in corso' : fmtRes(m)}</span></div>`;
      }).join('')}</div>`;
    }
    const st = getSwissStandings(), medals = d.ended ? new Map(st.filter(p => !p.dropped).slice(0, 3).map((p, i) => [p.id, ['🥇', '🥈', '🥉'][i]])) : new Map();
    h += `<div class="card"><div class="card-title">Classifica</div><table class="standings-table"><thead><tr><th scope="col">#</th><th scope="col">Giocatore</th><th scope="col">${isRR ? 'W-L' : 'W-L-D'}</th><th scope="col">Pts</th></tr></thead><tbody>
      ${st.map((p, i) => `<tr class="${p.dropped ? 'dropped' : ''}${meP && p.id === meP.id ? ' me' : ''}"><td class="standings-rank">${medals.get(p.id) || i + 1}</td><td class="standings-name">${esc(p.name)}${p.dropped ? ' ✗' : ''}</td><td class="standings-record">${isRR ? `${p.record.wins}-${p.record.losses}` : `${p.record.wins}-${p.record.losses}-${p.record.draws}`}</td><td>${p.mp}</td></tr>`).join('')}
      </tbody></table></div>`;
    return h;
  });
}
function openLive() { LUI.live = true; LUI.profile = null; if (!$id('screen-league').classList.contains('active')) switchTab('league'); else renderLeague(); window.scrollTo(0, 0); }
function closeLive() { LUI.live = false; renderLeague(); window.scrollTo(0, 0); }
// Aggiorna solo le parti live (banner e vista), senza ridisegnare form aperti nel resto della Lega
function renderLiveUI() {
  const b = document.getElementById('liveBanner');
  if (b && b.classList) b.innerHTML = T.started ? '' : liveBannerHtml();
  const lb = document.getElementById('leagueLiveBanner');
  if (lb && lb.classList) lb.innerHTML = liveBannerHtml();
  const v = document.getElementById('liveView');
  if (v && v.classList && LUI.live) v.innerHTML = renderLiveView();
}
