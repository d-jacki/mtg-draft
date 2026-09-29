// Torneo live condiviso. Il torneo sta su Supabase (league_live) e tutti i telefoni con il PIN possono gestirlo
// insieme; gli altri lo seguono in diretta. Aggiornamenti con Realtime di Supabase (WebSocket, protocollo
// Phoenix), con lettura di riserva ogni 20 s se la connessione in tempo reale non c'è.
//
// Scrittura a revisioni (compare-and-swap): ogni modifica locale è un'operazione (doOp in tournament.js) che
// resta in coda finché il server non la conferma. Il telefono manda lo stato con la revisione da cui è partito;
// se nel frattempo un altro telefono ha scritto, il server rifiuta e restituisce lo stato attuale: si riparte da
// quello, si riapplicano le operazioni in coda (quelle non più valide si scartano con un avviso) e si riprova.
// Lo stato porta acks = {telefono: ultima operazione inclusa}, così nessuna operazione viene applicata due volte.
// Il torneo resta local-first: senza rete si continua e la coda parte al ritorno.

const DEVICE_KEY = 'mtg-device', ME_KEY = 'mtg-me', SH_KEY = 'mtg-live-sh', LIVE_TOPIC = 'realtime:mtg-live';
const live = {
  data: null, rev: 0, updatedAt: 0, error: null, pubError: null, lastPublish: 0,
  pubTimer: null, pubRunning: false, pubPending: false,
  socket: null, joined: false, ref: 0, hb: null, retry: 0, poll: null, tick: null, started: false,
};
// Condivisione del torneo locale: revisione del server su cui si basa (null = mai pubblicato), operazioni non
// ancora confermate, detached = il torneo continua solo su questo telefono
let SH = null;

function deviceId() {
  let d = null;
  try { d = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!d) { d = uid('d'); try { localStorage.setItem(DEVICE_KEY, d); } catch (e) {} }
  return d;
}
function liveSh() {
  const tid = T.id || null;
  if (SH && SH.tid === tid) return SH;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SH_KEY)); } catch (e) {}
  SH = tid && s && s.tid === tid ? s : { tid, rev: null, seq: 0, pending: [], detached: false };
  return SH;
}
function saveSh() { try { localStorage.setItem(SH_KEY, JSON.stringify(SH)); } catch (e) {} }

// ── Pubblicazione e gestione condivisa (telefoni con il PIN) ──
function livePublishEnabled() { return syncCanWrite() && syncCfg.live !== false; }
function sharingOn() { return livePublishEnabled() && T.started && !!T.id && !liveSh().detached; }
// Altri telefoni hanno fatto operazioni su questo torneo (o ci si sono uniti)
function liveOthersManaging() { const me = deviceId(); return sharingOn() && Object.keys(T.acks || {}).some(k => k !== me); }
// Chiamata da doOp dopo aver applicato un'operazione in locale
function liveRecordOp(op) {
  if (!sharingOn()) return;
  const sh = liveSh();
  op.seq = ++sh.seq;
  sh.pending.push(op);
  T.acks = T.acks || {}; T.acks[deviceId()] = op.seq;
  saveSh();
}
function setLivePublish(on) {
  if (!syncCfg) return;
  if (!on) liveStop();
  syncCfg.live = !!on; saveSyncCfg();
  if (on) liveResume();
  renderSyncBox();
}
// Smette di trasmettere da qui: il torneo live si chiude solo se non lo gestisce anche qualcun altro
function liveStop() {
  // Già staccato: il torneo in diretta (se c'è ancora) è degli altri telefoni, non va chiuso
  if (!T.started || !T.id || liveSh().detached) return;
  if (!liveOthersManaging()) liveClear(false);
  const sh = liveSh(); sh.detached = true; sh.pending = []; saveSh();
}
// Riprende a trasmettere (live riattivato, PIN inserito)
function liveResume() {
  if (!T.started || !T.id) return;
  const sh = liveSh(), d = live.data;
  if (sh.detached) {
    // Se il torneo è ancora in diretta sugli altri telefoni ci si riunisce dal banner, invece di sovrascriverlo
    if (d && d.id === T.id && !d.ended) return;
    Object.assign(sh, { detached: false, rev: null, pending: [] }); saveSh();
  }
  livePublishSoon();
}
function liveSnapshot() {
  return {
    id: T.id, acks: { ...(T.acks || {}) }, device: deviceId(), publishedAt: Date.now(),
    started: T.started, ended: T.ended, mode: T.mode, set: T.set || '',
    totalRounds: T.totalRounds, currentRound: T.currentRound, draftOrder: (T.draftOrder || []).slice(),
    players: T.players.map(p => ({ id: p.id, name: p.name, leagueId: p.leagueId || null, dropped: !!p.dropped, droppedAtRound: p.droppedAtRound || null })),
    rounds: T.rounds.map(r => ({ locked: !!r.locked, pairings: r.pairings.map(m => ({ p1: m.p1, p2: m.p2, p1wins: m.p1wins, p2wins: m.p2wins, draws: m.draws || 0, bye: !!m.bye, rest: !!m.rest, forfeit: !!m.forfeit })) })),
    decks: { ...(T.decks || {}) }, archivedId: T.archivedId || null,
    timer: { total: TM.total, running: TM.running, seconds: TM.seconds, startedAt: TM.running ? TM.startedAt : null },
  };
}
// Chiamata da save(): più salvataggi ravvicinati = una sola pubblicazione
function livePublishSoon(delay) {
  if (!livePublishEnabled() || !T.started) return;
  clearTimeout(live.pubTimer);
  live.pubTimer = setTimeout(() => livePublishNow(false), delay == null ? 800 : delay);
}
function livePubErrorText(e) {
  const msg = (e && e.message) || 'Errore di rete';
  return /league_live_sync|function/i.test(msg) ? 'Rilancia supabase/schema.sql per il torneo condiviso' : msg;
}
async function livePublishNow(clear, keepalive) {
  if (!syncCanWrite()) return false;
  if (clear) return liveClear(keepalive);
  if (!sharingOn()) return false;
  const sh = liveSh();
  // Mai pubblicato: si crea (un torneo già concluso non si ripubblica); altrimenti solo se c'è qualcosa in coda
  if (sh.rev == null ? T.ended : !sh.pending.length) return false;
  if (live.pubRunning) { live.pubPending = true; return false; }
  live.pubRunning = true;
  const sentRev = sh.rev;
  let retry = false;
  try {
    const snap = liveSnapshot();
    snap.note = liveNote(sh); snap.by = liveMe() || null; // per la cronologia
    const out = await sbRpc('league_live_sync', { p_league: syncCfg.league, p_pin: syncCfg.pin, p_id: T.id, p_data: snap, p_rev: sh.rev, p_updated_at: Date.now() }, keepalive) || {};
    live.pubError = null;
    if (out.conflict) {
      // Un altro telefono ha scritto prima: si riparte dal suo stato e si riprova con le operazioni rimaste
      liveApply(out.data, out.updated_at, out.rev);
      if (SH === sh && !sh.detached && (!out.data || out.data.id !== T.id)) liveDetach(out.data);
      retry = SH === sh && !sh.detached && sh.pending.length > 0 && sh.rev !== sentRev;
      return false;
    }
    live.lastPublish = Date.now();
    if (SH !== sh) return true; // nel frattempo è cambiato torneo
    if (sh.rev == null || out.rev > sh.rev) sh.rev = out.rev;
    const acked = snap.acks[deviceId()] || 0;
    sh.pending = sh.pending.filter(op => op.seq > acked);
    saveSh();
    return true;
  } catch (e) {
    live.pubError = livePubErrorText(e);
    return false;
  } finally {
    live.pubRunning = false;
    if (live.pubPending || retry) { live.pubPending = false; livePublishSoon(retry ? 50 : 800); }
    if (typeof renderLiveBadge === 'function') renderLiveBadge();
  }
}
// Cosa contiene questa pubblicazione, per la cronologia
function liveNote(sh) {
  const notes = sh.pending.map(opNote).filter(Boolean);
  if (!notes.length) return sh.rev == null ? 'Torneo in diretta' : '';
  return notes.slice(0, 3).join(' · ') + (notes.length > 3 ? ` · +${notes.length - 3}` : '');
}
// Toglie il torneo dal live, solo se quello in diretta è ancora questo (non chiude il torneo di un altro)
async function liveClear(keepalive) {
  if (!syncCanWrite() || !T.id) return false;
  try {
    const out = await sbRpc('league_live_sync', { p_league: syncCfg.league, p_pin: syncCfg.pin, p_id: T.id, p_data: null, p_rev: null, p_updated_at: Date.now() }, keepalive) || {};
    // Chiuso davvero: se si riprende a trasmettere si ricrea da capo
    if (out.cleared) { const sh = liveSh(); sh.rev = null; saveSh(); }
    live.pubError = null;
    return true;
  } catch (e) {
    live.pubError = livePubErrorText(e);
    return false;
  }
}
// "Nuovo torneo" sul telefono che pubblicava: toglie il torneo dal live (keepalive: la pagina si ricarica subito)
function liveClearOnReset() { if (T.started && livePublishEnabled() && !liveSh().detached) liveClear(true); }

// Il torneo in diretta è stato chiuso o sostituito da un altro telefono: questo continua da solo
function liveDetach(d) {
  const sh = liveSh();
  sh.detached = true; sh.pending = []; saveSh();
  if (!T.ended) toast(d ? 'Un altro telefono ha avviato un nuovo torneo live: questo continua solo qui' : 'Il torneo live è stato chiuso da un altro telefono: questo continua solo qui');
  renderLiveBadge();
}
// Stato arrivato dal server (Realtime, lettura o conflitto): se è il torneo che si gestisce qui, ci si allinea
function liveReconcile(d, rev) {
  if (!sharingOn()) return;
  const sh = liveSh();
  if (sh.rev == null || rev <= sh.rev) return;
  if (!d || d.id !== T.id) { liveDetach(d); return; }
  const me = deviceId(), acked = (d.acks || {})[me] || 0;
  // Il proprio stato che torna indietro (eco Realtime o conferma persa): coincide già con quello locale
  if (d.device === me) {
    sh.rev = rev; sh.pending = sh.pending.filter(op => op.seq > acked); saveSh();
    return;
  }
  const prevRound = T.currentRound, wasEnded = T.ended, rejected = [];
  liveLoadState(d);
  sh.rev = rev;
  sh.pending = sh.pending.filter(op => {
    if (op.seq <= acked) return false;
    if (applyOp(op)) { T.acks[me] = op.seq; return true; }
    rejected.push(op); return false;
  });
  saveSh(); save();
  liveRefreshTournament(prevRound, wasEnded);
  if (rejected.length) toast(opRejectedMsg(rejected[rejected.length - 1]));
  else if (sh.pending.some(op => op.regen)) toast('Un risultato è cambiato su un altro telefono: pairing del round ricalcolati');
}
// Sostituisce il torneo locale con lo stato condiviso
function liveLoadState(d) {
  const copy = x => JSON.parse(JSON.stringify(x));
  Object.assign(T, {
    id: d.id, started: true, ended: !!d.ended, mode: d.mode, set: d.set || '',
    totalRounds: d.totalRounds, currentRound: d.currentRound,
    players: copy(d.players).map(p => ({ leagueId: null, droppedAtRound: null, ...p })),
    draftOrder: d.draftOrder ? d.draftOrder.slice() : d.players.map(p => p.id),
    rounds: copy(d.rounds).map(r => ({ locked: false, ...r })),
    decks: { ...(d.decks || {}) }, archivedId: d.archivedId || null, acks: { ...(d.acks || {}) },
  });
  playerIdCounter = Math.max(playerIdCounter, ...T.players.map(p => p.id));
  const t = d.timer || {};
  TM.total = t.total || TM.total;
  TM.running = !!t.running && !!t.startedAt && !d.ended;
  TM.startedAt = TM.running ? t.startedAt : null;
  TM.seconds = TM.running ? Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000)) : (t.seconds || 0);
  // Le soglie già passate non suonano di nuovo
  const rem = TM.total - TM.seconds;
  TM.firedWarning = rem <= 300; TM.firedExpired = rem <= 0; TM.firedOvertime = rem <= -300;
  timerEnsure();
}
function liveRefreshTournament(prevRound, wasEnded) {
  if (T.mode !== 'roundrobin' && viewingRound === prevRound) viewingRound = T.currentRound;
  viewingRound = Math.max(1, Math.min(viewingRound, T.mode === 'roundrobin' ? T.totalRounds : T.currentRound));
  renderRound(true); renderStandings(); updateStatus();
  if (!wasEnded && T.ended) { switchTab('standings'); toast('🏆 Torneo concluso'); }
}
// Il torneo d diventa quello gestito da qui (unirsi al live, ripristino dalla cronologia). Se è quello in diretta
// si scrive sopra la sua revisione, altrimenti alla prima pubblicazione sostituisce il torneo live.
function liveAdopt(d) {
  const me = deviceId(), cur = live.data && live.data.id === d.id ? live.data : null;
  liveLoadState(d);
  if (cur) for (const [k, v] of Object.entries(cur.acks || {})) T.acks[k] = Math.max(T.acks[k] || 0, v);
  SH = { tid: d.id, rev: cur ? live.rev : null, seq: T.acks[me] || 0, pending: [], detached: false }; saveSh();
  if (syncCfg.live === false) { syncCfg.live = true; saveSyncCfg(); }
}
// Unirsi al torneo in diretta di un altro telefono e gestirlo insieme
function liveJoin() {
  const d = live.data;
  if (!d || !d.id || d.ended || !syncCanWrite()) return;
  const go = () => {
    liveAdopt(d);
    doOp({ t: 'join' }); // così gli altri sanno che anche questo telefono gestisce il torneo
    viewingRound = T.currentRound || 1;
    save(); LUI.live = false;
    showStartedTournament(); switchTab('round');
    toast('Ora gestisci il torneo anche da questo telefono');
  };
  const replaces = T.started ? !T.ended && T.id !== d.id : T.players.length > 0;
  if (replaces) showModal('Unirti al torneo?', T.started ? 'Il torneo in corso su questo telefono verrà sostituito.' : 'I giocatori inseriti su questo telefono verranno sostituiti.', go);
  else go();
}
// Un altro telefono ha un torneo in corso in diretta (avviso prima di avviarne uno nuovo)
function liveOtherActive() { return livePublishEnabled() && liveVisible() && !live.data.ended; }
function liveBadgeHtml() {
  if (!sharingOn() || T.ended) return '';
  const err = live.pubError, others = liveOthersManaging();
  const title = err ? 'Live non aggiornato: ' + err : others ? 'Gestito insieme ad altri telefoni; gli altri lo seguono in diretta' : 'Gli altri telefoni della lega seguono il torneo in diretta';
  return `<span class="mode-badge live${err ? ' err' : ''}" id="liveBadge" title="${esc(title)}">● LIVE${others ? ' ⇄' : ''}</span>`;
}
function renderLiveBadge() { const b = document.getElementById('liveBadge'); if (b && b.outerHTML !== undefined) b.outerHTML = liveBadgeHtml() || '<span id="liveBadge"></span>'; }

// ── Lettura (tutti i telefoni della lega) ──
// Stato live arrivato dal server: numeri e id finiscono nell'HTML della vista "Segui" e negli onclick (vedi league.js)
function validLiveState(d) {
  if (d == null) return true;
  const pid = n => Number.isInteger(n) && n > 0, num = n => n == null || Number.isFinite(n);
  const round = n => Number.isInteger(n) && n >= 0 && n <= 99;
  return typeof d === 'object' && (d.id == null || safeId(d.id)) && round(d.currentRound) && round(d.totalRounds)
    && Array.isArray(d.players) && d.players.every(p => p && pid(p.id) && isStr(p.name) && (p.leagueId == null || safeId(p.leagueId)))
    && Array.isArray(d.rounds) && d.rounds.every(r => r && Array.isArray(r.pairings) && r.pairings.every(m => validMatch(m, pid)))
    && (d.draftOrder == null || (Array.isArray(d.draftOrder) && d.draftOrder.every(pid)))
    && (d.decks == null || (typeof d.decks === 'object' && Object.values(d.decks).every(isStr)))
    && (d.set == null || isStr(d.set)) && num(d.publishedAt)
    && (d.timer == null || (typeof d.timer === 'object' && num(d.timer.total) && num(d.timer.seconds) && num(d.timer.startedAt)));
}
// Ordine degli aggiornamenti: revisione del server (updated_at per gli stati senza revisione)
function liveApply(data, updatedAt, rev) {
  if (!validLiveState(data)) return;
  if (rev != null) { if (Number(rev) < live.rev) return; live.rev = Number(rev); }
  else if (updatedAt != null && Number(updatedAt) < live.updatedAt) return;
  if (updatedAt != null) live.updatedAt = Math.max(live.updatedAt, Number(updatedAt));
  live.data = data || null;
  if (rev != null) liveReconcile(live.data, Number(rev));
  renderLiveUI();
}
async function liveFetch() {
  if (!syncConfigured()) return;
  try {
    const res = await fetch(`${syncCfg.url}/rest/v1/league_live?select=data,updated_at,rev&league_id=eq.${encodeURIComponent(syncCfg.league)}`, { headers: sbHeaders() });
    if (!res.ok) throw await sbError(res);
    const rows = await res.json();
    if (rows.length) liveApply(rows[0].data, rows[0].updated_at, rows[0].rev); else liveApply(null, null);
    live.error = null;
  } catch (e) {
    live.error = /league_live|rev/.test(e.message || '') ? 'Rilancia supabase/schema.sql per attivare il live' : (e.message || 'Errore di rete');
  }
}
function liveVisible() {
  const d = live.data;
  if (!d || !d.started) return false;
  // Il torneo che si gestisce da qui non ha bisogno del banner (stati vecchi senza id: si guarda il telefono)
  if (d.id ? T.started && d.id === T.id && !liveSh().detached : d.device === deviceId()) return false;
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
    else if (d.record) liveApply(d.record.data, d.record.updated_at, d.record.rev);
  }
}
function liveConnect() {
  if (!syncConfigured() || typeof WebSocket === 'undefined' || live.socket) return;
  if (document.visibilityState === 'hidden') return;
  let ws;
  try { ws = new WebSocket(`${syncCfg.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(syncCfg.key)}&vsn=1.0.0`); } catch (e) { return; }
  live.socket = ws; live.joined = false; live.ref = 0;
  // Gli eventi di un socket già sostituito (chiuso andando in background e riaperto subito) non devono toccare
  // quello nuovo: azzererebbero live.socket e il suo heartbeat e aprirebbero un terzo socket
  const stale = () => live.socket !== ws;
  ws.onopen = () => {
    if (stale()) return;
    const payload = { config: { broadcast: { ack: false, self: false }, presence: { key: '' }, private: false,
      postgres_changes: [{ event: '*', schema: 'public', table: 'league_live', filter: `league_id=eq.${syncCfg.league}` }] } };
    if (syncCfg.key.startsWith('eyJ')) payload.access_token = syncCfg.key;
    wsSend(ws, LIVE_TOPIC, 'phx_join', payload);
    clearInterval(live.hb);
    live.hb = setInterval(() => { try { wsSend(ws, 'phoenix', 'heartbeat', {}); } catch (e) {} }, 25000);
  };
  ws.onmessage = e => { if (stale()) return; try { liveOnMessage(JSON.parse(e.data)); } catch (err) {} };
  ws.onclose = () => {
    if (stale()) return;
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
  // Lettura di riserva senza Realtime; una coda di operazioni rimasta indietro (rete assente) riparte da sola
  if (!live.poll) live.poll = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (!live.joined) liveFetch();
    if (sharingOn() && liveSh().pending.length) livePublishSoon(0);
  }, 20000);
  if (!live.tick) live.tick = setInterval(() => { const el = document.getElementById('liveTimer'); if (el && live.data) el.textContent = liveTimerText(live.data); }, 1000);
}
function stopLive() {
  live.started = false; liveDisconnect();
  clearInterval(live.poll); clearInterval(live.tick); live.poll = live.tick = null;
  live.data = null; live.rev = 0; live.updatedAt = 0; renderLiveUI();
}
document.addEventListener('visibilitychange', () => {
  if (!live.started) return;
  if (document.visibilityState === 'hidden') liveDisconnect();
  else { liveFetch(); liveConnect(); livePublishSoon(); }
});
window.addEventListener('online', () => livePublishSoon(0));

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
      ${!d.ended && !isRR ? `<div class="live-timer" id="liveTimer" aria-label="Tempo del round">${liveTimerText(d)}</div>` : ''}
      ${syncCanWrite() && d.id && !d.ended ? `<button class="btn btn-primary btn-sm mt" onclick="liveJoin()">✏️ Gestisci anche tu</button><div class="text-xs text-dim mt">Inserisci risultati, round e timer da questo telefono insieme agli altri.</div>` : ''}</div>`;
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
