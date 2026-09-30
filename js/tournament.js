// Torneo: stato, setup, tavolo, pairing, punteggi, timer, round, classifica, navigazione.

// id: identifica il torneo tra i telefoni (live condiviso e archivio); acks: ultima operazione di ogni telefono inclusa nello stato
const T = { id: null, players: [], draftOrder: [], rounds: [], started: false, ended: false, totalRounds: 0, currentRound: 0, mode: 'swiss', set: '', decks: {}, archivedId: null, acks: {} };
let viewingRound = 1, playerIdCounter = 0, lastScoredMatch = -1, expandedPlayer = null;
const TM = { running: false, seconds: 0, total: 50 * 60, interval: null, startedAt: null, firedWarning: false, firedExpired: false, firedOvertime: false };

const $id = id => document.getElementById(id);
const $qsa = (sel, el) => (el || document).querySelectorAll(sel);
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function toast(m) { const t = $id('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }
function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }
// Movimento ridotto nelle impostazioni del telefono: niente coriandoli né scorrimento animato
function reducedMotion() { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }

// Wake lock: schermo acceso finché il timer corre
let _wakeLock = null;
async function acquireWakeLock() { try { if ('wakeLock' in navigator && !_wakeLock) { _wakeLock = await navigator.wakeLock.request('screen'); _wakeLock.addEventListener('release', () => { _wakeLock = null; }); } } catch (e) {} }
function releaseWakeLock() { if (_wakeLock) { _wakeLock.release().catch(() => {}); _wakeLock = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && TM.running) acquireWakeLock(); });

// Beep WebAudio (niente asset, funziona offline); il contesto va creato su gesto utente
let _audioCtx = null;
function ensureAudio() { try { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; _audioCtx = _audioCtx || new AC(); if (_audioCtx.state === 'suspended') _audioCtx.resume(); } catch (e) {} }
// Dopo un reload a timer attivo (o al ritorno in primo piano su iOS) il contesto resta sospeso finché l'utente non tocca lo schermo
document.addEventListener('pointerdown', () => { if (TM.running) ensureAudio(); }, { passive: true });
function beep(times) {
  try {
    if (!_audioCtx) return;
    let t = _audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g); g.connect(_audioCtx.destination);
      o.start(t); o.stop(t + 0.3); t += 0.42;
    }
  } catch (e) {}
}

function setHeaderH() { const el = document.querySelector('.header'); if (el && el.offsetHeight) document.documentElement.style.setProperty('--header-h', el.offsetHeight + 'px'); }
window.addEventListener('resize', setHeaderH);
setHeaderH();
const P = id => T.players.find(p => p.id === id);
// Nome breve per pulsanti e risultati: il primo nome, oppure il nome intero se un altro giocatore ha lo stesso primo nome
function shortName(pid) {
  const p = P(pid); if (!p) return '?';
  const first = n => n.split(' ')[0].toLowerCase(), f = first(p.name);
  return T.players.some(o => o.id !== pid && first(o.name) === f) ? p.name : p.name.split(' ')[0];
}
function save() {
  localStorage.setItem('mtg-t', JSON.stringify({
    T, viewingRound, playerIdCounter,
    tm: { seconds: TM.running && TM.startedAt ? Math.floor((clockNow() - TM.startedAt) / 1000) : TM.seconds, running: TM.running, total: TM.total, firedWarning: TM.firedWarning, firedExpired: TM.firedExpired, firedOvertime: TM.firedOvertime },
    savedAt: Date.now()
  }));
  if (typeof livePublishSoon === 'function') livePublishSoon();
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem('mtg-t'));
    if (!d) return false;
    Object.assign(T, d.T);
    viewingRound = d.viewingRound || 1;
    playerIdCounter = d.playerIdCounter || 0;
    TM.total = d.tm?.total || 50 * 60;
    TM.seconds = d.tm?.seconds || 0;
    TM.firedWarning = d.tm?.firedWarning || false;
    TM.firedExpired = d.tm?.firedExpired || false;
    TM.firedOvertime = d.tm?.firedOvertime || false;
    if (d.tm?.running && d.savedAt) TM.seconds += Math.floor((Date.now() - d.savedAt) / 1000);
    // Tornei avviati prima degli id condivisi
    if (T.started && !T.id) T.id = uid('t');
    return d.tm?.running || false;
  } catch { return false; }
}
window.addEventListener('beforeunload', e => { if (T.started && !T.ended) { e.preventDefault(); e.returnValue = ''; } });
let _modalReturnFocus = null;
function _focusableInModal(){return [...$id('modal').querySelectorAll('button,select,input,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter(el=>!el.disabled&&el.offsetParent!==null);}
function _openModal(){_modalReturnFocus=document.activeElement;$id('modal').classList.add('active');setTimeout(()=>{const f=_focusableInModal();if(f.length)f[0].focus();},50);}
function showModal(t, txt, fn) { $id('modalTitle').textContent = t; $id('modalText').textContent = txt; $id('modalBody').innerHTML = ''; $id('modalButtons').classList.remove('hidden'); $id('modalConfirm').onclick = () => { closeModal(); fn(); }; _openModal(); }
function showModalCustom(t, txt, h) { $id('modalTitle').textContent = t; $id('modalText').textContent = txt; $id('modalBody').innerHTML = h; $id('modalButtons').classList.add('hidden'); _openModal(); }
function closeModal() { $id('modal').classList.remove('active'); if(_modalReturnFocus&&typeof _modalReturnFocus.focus==='function'){try{_modalReturnFocus.focus();}catch(e){}} _modalReturnFocus=null; }
$id('modal').addEventListener('click', e => { if (e.target === $id('modal')) closeModal(); });
document.addEventListener('keydown', e => {
  // Elementi con role="button" che non sono <button> (righe classifica, risultato da modificare)
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"]:not(button)')) { e.preventDefault(); e.target.click(); return; }
  if (e.key === 'Escape' && $id('announceOverlay').classList.contains('active')) { e.preventDefault(); closeAnnounce(); return; }
  if (!$id('modal').classList.contains('active')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
  if (e.key !== 'Tab') return;
  const f = _focusableInModal();
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── SETUP ──
$id('playerInput').addEventListener('keydown', e => { if (e.key === 'Enter') addPlayer(); });
function addPlayer() {
  const inp = $id('playerInput'), raw = inp.value.trim();
  if (!raw) return;
  const name = raw.toLowerCase()==='ferro'?'Ferro il Ludopatico':raw;
  if (T.players.length >= 16) return toast('Massimo 16 giocatori');
  if (T.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('Nome già presente');
  const known = findPlayerByName(name);
  T.players.push({ id: ++playerIdCounter, name: known ? known.name : name, leagueId: known ? known.id : null, dropped: false, droppedAtRound: null });
  syncDraftOrder();
  inp.value = ''; inp.focus(); renderPlayerList(); save();
}
function removePlayer(id) { T.players = T.players.filter(p => p.id !== id); syncDraftOrder(); renderPlayerList(); save(); }
function renderPlayerList() {
  $id('playerList').innerHTML = T.players.map((p, i) => `<div class="player-item"><span class="player-num">${i + 1}</span><span class="player-name">${esc(p.name)}</span><button class="player-remove" onclick="removePlayer(${p.id})" aria-label="Rimuovi ${esc(p.name)}">✕</button></div>`).join('');
  const n = T.players.length; $id('playerCount').textContent = `${n} giocator${n === 1 ? 'e' : 'i'}`;
  $id('goToSeatingBtn').disabled = n < 4;
  renderRosterChips();
}

// ── SEATING ──
// Allinea l'ordine al tavolo ai giocatori iscritti: toglie i rimossi e accoda i nuovi, mantenendo le posizioni
// già sistemate. Se il tavolo non esiste ancora (mai aperto) lo crea mescolato.
function syncDraftOrder() {
  if (T.started) return;
  const ids = T.players.map(p => p.id);
  if (!T.draftOrder.length) { if (ids.length >= 4) T.draftOrder = shuffle(ids); return; }
  const kept = T.draftOrder.filter(id => ids.includes(id));
  T.draftOrder = kept.length ? kept.concat(shuffle(ids.filter(id => !kept.includes(id)))) : shuffle(ids);
}
function goToSeating() {
  if (T.players.length < 4) return;
  syncDraftOrder(); renderSeating(); switchTab('draft');
}
function renderSeating() { syncDraftOrder(); renderSeatList(); renderDraftVisual(); renderPairingPreview(); }
function renderSeatList() {
  const n = T.draftOrder.length, locked = T.started;
  $id('seatList').innerHTML = T.draftOrder.map((id, i) => {
    const p = T.players.find(p => p.id === id);
    return `<div class="seat-item"><div class="seat-num">${i + 1}</div><div class="seat-name">${esc(p.name)}</div>
      ${locked ? '' : `<div class="seat-arrows"><button class="seat-arrow-btn" onclick="moveSeat(${i},-1)" ${i === 0 ? 'disabled' : ''} aria-label="Sposta su">▲</button><button class="seat-arrow-btn" onclick="moveSeat(${i},1)" ${i === n - 1 ? 'disabled' : ''} aria-label="Sposta giù">▼</button></div>`}</div>`;
  }).join('');
}
function moveSeat(i, d) { const j = i + d; if (j < 0 || j >= T.draftOrder.length) return; [T.draftOrder[i], T.draftOrder[j]] = [T.draftOrder[j], T.draftOrder[i]]; renderSeating(); save(); }
function reshuffleDraft() { T.draftOrder = shuffle(T.players.map(p => p.id)); renderSeating(); save(); toast('Posizioni rimescolate'); }
function renderDraftVisual() {
  const ids = T.draftOrder, n = ids.length;
  const containerW = $id('draftVisual').clientWidth || 300;
  const seatW = 80;
  const maxRadius = Math.floor((containerW - seatW) / 2) - 4;
  const radius = Math.min(maxRadius, Math.min(120, 90 + n * 3));
  // Troppi giocatori per il cerchio (posti vicini che si sovrappongono): tavolo lungo, stesso giro in senso orario
  if (2 * radius * Math.sin(Math.PI / n) < 68) { renderLongTable(ids); return; }
  const size = (radius + seatW / 2 + 4) * 2, cx = size / 2, cy = size / 2;
  let h = `<div class="draft-table" style="width:${size}px;height:${size}px;"><div class="draft-table-center">Tavolo</div>`;
  ids.forEach((id, i) => {
    const a = (2 * Math.PI * i / n) - Math.PI / 2, p = T.players.find(p => p.id === id);
    h += `<div class="draft-seat" style="left:${cx + radius * Math.cos(a)}px;top:${cy + radius * Math.sin(a)}px;"><div class="draft-seat-num">${i + 1}</div><div class="draft-seat-name">${esc(p.name)}</div></div>`;
  });
  $id('draftVisual').innerHTML = h + '</div>';
}
// Lato destro dall'alto in basso, poi lato sinistro dal basso in alto: il posto opposto nel giro sta di fronte
function renderLongTable(ids) {
  const n = ids.length, half = Math.ceil(n / 2), rows = [];
  const seat = (i, side) => { if (i == null) return `<div class="lt-seat ${side}"></div>`; const p = P(ids[i]); return `<div class="lt-seat ${side}"><span class="draft-seat-num">${i + 1}</span><span class="lt-name">${esc(p ? p.name : '?')}</span></div>`; };
  for (let r = 0; r < half; r++) { const l = n - 1 - r; rows.push(seat(l >= half ? l : null, 'left') + seat(r, 'right')); }
  $id('draftVisual').innerHTML = `<div class="long-table" style="grid-template-rows:repeat(${half},auto);"><div class="long-table-top" style="grid-row:1/span ${half};">Tavolo</div>${rows.join('')}</div>`;
}
function renderPairingPreview() {
  const o = T.draftOrder, n = o.length, half = Math.floor(n / 2); let h = '';
  // Torneo avviato: gli accoppiamenti veri del round 1 (bye o riposo compresi), non l'anteprima
  const r1 = T.started && T.rounds[0];
  if (r1) {
    $id('previewTitle').textContent = 'Accoppiamenti Round 1';
    r1.pairings.forEach((m, i) => { const a = P(m.p1), b = m.p2 ? P(m.p2) : null; h += `<div class="vs-line"><span class="vs-label">${m.rest ? '—' : m.bye ? 'Bye' : 'T' + (i + 1)}</span><span class="vs-names">${esc(a ? a.name : '?')}${m.rest ? ' riposa' : b ? ' vs ' + esc(b.name) : ''}</span></div>`; });
  } else if (n % 2 === 0) {
    $id('previewTitle').textContent = 'Accoppiamenti Round 1';
    for (let i = 0; i < half; i++) { const p1 = T.players.find(p => p.id === o[i]), p2 = T.players.find(p => p.id === o[i + half]); h += `<div class="vs-line"><span class="vs-label">T${i + 1}</span><span class="vs-names">${esc(p1.name)} vs ${esc(p2.name)}</span></div>`; }
  } else {
    $id('previewTitle').textContent = 'Numero dispari';
    h = `<div class="text-sm text-dim" style="line-height:1.6;">Siete in <b>${n}</b> — alla partenza potrai scegliere tra Swiss con bye e tutti contro tutti BO1.</div>`;
  }
  $id('pairingPreview').innerHTML = h;
}

// ── START ──
function handleStart(force) {
  if (T.players.length < 4) return;
  // Un altro telefono ha già un torneo in diretta: meglio unirsi a quello che sostituirlo per sbaglio
  if (!force && typeof liveOtherActive === 'function' && liveOtherActive()) {
    showModalCustom('Torneo già in corso', 'Un altro telefono sta gestendo un torneo in diretta. Puoi unirti e gestirlo insieme; se avvii il tuo, in diretta si vedrà il tuo e l\'altro continuerà solo su quel telefono.',
      `<button class="btn btn-primary" onclick="closeModal();openLive()">Guardalo e unisciti</button>
      <button class="btn btn-secondary mt" onclick="closeModal();handleStart(true)">Avvia comunque il mio</button>
      <button class="btn btn-secondary btn-sm mt" onclick="closeModal()">Annulla</button>`);
    return;
  }
  const n = T.players.length;
  const defR = Math.ceil(Math.log2(n));
  const maxR = Math.min(n - 1, 8);
  const opts = Array.from({length: maxR - 1}, (_, i) => i + 2).map(r => `<option value="${r}"${r===defR?' selected':''}>${r} round</option>`).join('');
  const curMin = Math.round(TM.total / 60);
  const timerOpts = [30, 40, 50, 60].map(m => `<option value="${m}"${m===curMin?' selected':''}>${m} minuti</option>`).join('');
  const selStyle = 'class="text-sm" style="display:block;margin-bottom:6px;font-weight:600;color:var(--text-mid);"';
  const swissSelects = `<div class="mb"><label for="roundCountSel" ${selStyle}>Round (Swiss):</label><select id="roundCountSel">${opts}</select></div>
      <div class="mb"><label for="timerMinSel" ${selStyle}>Timer round:</label><select id="timerMinSel">${timerOpts}</select></div>`;
  const sets = [...new Set(sortedTournaments().map(t => t.set).filter(Boolean))].reverse();
  const setField = `<div class="mb"><label for="setNameInp" ${selStyle}>Set / cube (facoltativo):</label><input type="text" id="setNameInp" list="setNameList" maxlength="40" autocomplete="off" placeholder="es. Duskmourn" value="${esc(T.set || '')}"><datalist id="setNameList">${sets.map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>`;
  const startSwiss = `captureSetName(); closeModal(); startWithMode('swiss', parseInt($id('roundCountSel').value), parseInt($id('timerMinSel').value))`;
  if (n % 2 === 1) {
    showModalCustom('Formato torneo', `Siete in ${n} (dispari).`,
      `${setField}${swissSelects}
      <button class="mode-choice-btn" onclick="${startSwiss}"><strong>Swiss con Bye</strong><span class="desc">Cross-table R1, un bye a turno</span></button>
      <button class="mode-choice-btn" onclick="captureSetName(); closeModal(); startWithMode('roundrobin')"><strong>Tutti contro tutti BO1</strong><span class="desc">${n} round, ${n - 1} partite a testa</span></button>
      <button class="btn btn-secondary btn-sm mt" onclick="closeModal()">Annulla</button>`);
  } else {
    showModalCustom('Configurazione torneo', `${n} giocatori — formato Swiss.`,
      `${setField}${swissSelects}
      <button class="btn btn-primary" onclick="${startSwiss}">Inizia torneo</button>
      <button class="btn btn-secondary btn-sm mt" onclick="closeModal()">Annulla</button>`);
  }
}
function captureSetName() { const el = $id('setNameInp'); if (el) T.set = el.value.trim(); }
function startWithMode(mode, rounds, timerMin) {
  syncDraftOrder();
  T.id = uid('t'); T.acks = {}; T.archivedId = null;
  T.mode = mode; T.started = true; T.ended = false; T.rounds = []; T.currentRound = 0;
  if (mode === 'swiss') { T.totalRounds = rounds || Math.ceil(Math.log2(T.players.length)); TM.total = (timerMin || 50) * 60; }
  else { T.totalRounds = T.players.length; generateAllRRRounds(); }
  lockSetup(); renderSeatList(); updateStatus();
  if (mode === 'swiss') nextRound(); else { T.currentRound = 1; viewingRound = 1; renderRound(); save(); }
  switchTab('round');
}
function lockSetup() {
  $id('screen-setup').querySelectorAll('input, button').forEach(el => el.disabled = true);
  $id('startBtn').classList.add('hidden'); $id('reshuffleBtn').classList.add('hidden');
  // Torneo avviato: restano solo le liste, niente controlli disattivati che sembrano ancora toccabili
  ['addPlayerRow', 'rosterChips', 'goToSeatingBtn', 'seatHint'].forEach(id => $id(id).classList.add('hidden'));
}
// Torneo avviato caricato da fuori (ripristino all'avvio, oppure unendosi al torneo di un altro telefono)
function showStartedTournament() {
  renderPlayerList(); if (T.draftOrder.length) renderSeating();
  lockSetup(); updateStatus(); renderRound(); renderStandings();
}

// ── RR SCHEDULE ──
function generateAllRRRounds() {
  const ids = T.draftOrder.slice(), n = ids.length, N = n + 1;
  if (n % 2 === 0) throw new Error('Round robin BO1 supporta solo un numero dispari di giocatori');
  const rot = []; for (let i = 1; i < N; i++) rot.push(i);
  T.rounds = [];
  for (let r = 0; r < N - 1; r++) {
    const pairings = []; let restIdx = null;
    const o0 = rot[0];
    if (o0 === n) restIdx = 0; else pairings.push(mkM(ids[0], ids[o0]));
    const half = (rot.length - 1) / 2;
    for (let i = 1; i <= half; i++) { const a = rot[i], b = rot[rot.length - i]; if (a === n) restIdx = b; else if (b === n) restIdx = a; else pairings.push(mkM(ids[a], ids[b])); }
    if (restIdx !== null) pairings.push({ p1: ids[restIdx], p2: null, p1wins: null, p2wins: null, draws: 0, bye: false, rest: true, forfeit: false });
    T.rounds.push({ pairings, locked: false });
    rot.unshift(rot.pop());
  }
}
function mkM(a, b) { return { p1: a, p2: b, p1wins: null, p2wins: null, draws: 0, bye: false, rest: false, forfeit: false }; }

// ── SCORING ──
function getActivePlayers() { return T.players.filter(p => !p.dropped); }
function getPlayerRecord(pid) {
  let w=0,l=0,d=0,gw=0,gl=0,gd=0,opps=[],rp=0;
  for (const r of T.rounds) for (const m of r.pairings) {
    if (m.rest) continue;
    if (m.bye && m.p1===pid){w++;gw+=2;rp++;continue;}
    if (m.p1===pid||m.p2===pid){if(m.p1wins==null)continue;rp++;const is1=m.p1===pid;opps.push(is1?m.p2:m.p1);const mg=is1?m.p1wins:m.p2wins,og=is1?m.p2wins:m.p1wins;gw+=mg;gl+=og;gd+=m.draws;if(mg>og)w++;else if(mg<og)l++;else d++;}
  }
  return{wins:w,losses:l,draws:d,gameWins:gw,gameLosses:gl,gameDraws:gd,opponents:opps,roundsPlayed:rp};
}
function matchPoints(pid){const r=getPlayerRecord(pid);return r.wins*3+r.draws;}
function mwp(pid){const r=getPlayerRecord(pid);return r.roundsPlayed===0?0.33:Math.max(0.33,(r.wins*3+r.draws)/(r.roundsPlayed*3));}
function gwp(pid){const r=getPlayerRecord(pid);const t=r.gameWins+r.gameLosses+r.gameDraws;return t===0?0.33:Math.max(0.33,(r.gameWins*3+r.gameDraws)/(t*3));}
function omw(pid){const r=getPlayerRecord(pid);return r.opponents.length===0?0.33:r.opponents.reduce((a,o)=>a+mwp(o),0)/r.opponents.length;}
function ogw(pid){const r=getPlayerRecord(pid);return r.opponents.length===0?0.33:r.opponents.reduce((a,o)=>a+gwp(o),0)/r.opponents.length;}

// Punti ottenuti da pid negli scontri diretti contro i giocatori di group (mini-classifica tra pari merito)
function h2hPoints(pid,group){let pts=0;for(const r of T.rounds)for(const m of r.pairings){if(m.rest||m.bye||m.p1wins==null)continue;const is1=m.p1===pid;if(!is1&&m.p2!==pid)continue;if(!group.has(is1?m.p2:m.p1))continue;const mg=is1?m.p1wins:m.p2wins,og=is1?m.p2wins:m.p1wins;pts+=mg>og?3:mg===og?1:0;}return pts;}
// Round robin: a parità di punti decide lo scontro diretto. In un tutti-contro-tutti OMW%/GW%/OGW% sono identici
// per costruzione tra giocatori a pari punti, quindi senza H2H deciderebbe l'ordine di iscrizione. Swiss: MTR puro.
function getSwissStandings(){
  const st=T.players.map(p=>{const mp=matchPoints(p.id);return{...p,mp,h2h:0,omw:omw(p.id),gwp:gwp(p.id),ogw:ogw(p.id),record:getPlayerRecord(p.id)};});
  if(T.mode==='roundrobin'){const byMp=new Map();st.forEach(p=>{if(!byMp.has(p.mp))byMp.set(p.mp,new Set());byMp.get(p.mp).add(p.id);});st.forEach(p=>{p.h2h=h2hPoints(p.id,byMp.get(p.mp));});}
  return st.sort((a,b)=>(b.mp-a.mp)||(b.h2h-a.h2h)||(b.omw-a.omw)||(b.gwp-a.gwp)||(b.ogw-a.ogw));
}

function getPlayerMatches(pid) {
  const matches = [];
  T.rounds.forEach((r, ri) => { r.pairings.forEach(m => {
    if (m.rest) return;
    if (m.bye && m.p1 === pid) { matches.push({ round: ri+1, opp: 'BYE', result: 'W', score: '2-0' }); return; }
    if (m.p1 === pid || m.p2 === pid) {
      if (m.p1wins == null) return;
      const is1 = m.p1 === pid, opp = T.players.find(p => p.id === (is1 ? m.p2 : m.p1));
      const mg = is1 ? m.p1wins : m.p2wins, og = is1 ? m.p2wins : m.p1wins;
      const res = mg > og ? 'W' : mg < og ? 'L' : 'D';
      const score = T.mode === 'roundrobin' ? (res === 'W' ? 'Vinto' : res === 'L' ? 'Perso' : 'Pari') : `${mg}-${og}${m.draws ? '-' + m.draws : ''}`;
      matches.push({ round: ri+1, opp: opp ? opp.name : '?', result: res, score });
    }
  }); }); return matches;
}

// ── PAIRING ──
function havePlayed(a,b){for(const r of T.rounds)for(const m of r.pairings){if(m.bye||m.rest)continue;if((m.p1===a&&m.p2===b)||(m.p1===b&&m.p2===a))return true;}return false;}
function hadBye(pid){for(const r of T.rounds)for(const m of r.pairings)if(m.bye&&m.p1===pid)return true;return false;}
function generateDraftR1(){const o=T.draftOrder.filter(id=>{const p=T.players.find(p=>p.id===id);return p&&!p.dropped;});const n=o.length,half=Math.floor(n/2),pairs=[];for(let i=0;i<half;i++)pairs.push({p1:o[i],p2:o[i+half],p1wins:null,p2wins:null,draws:0,bye:false,rest:false,forfeit:false});if(n%2===1)pairs.push({p1:o[n-1],p2:null,p1wins:2,p2wins:0,draws:0,bye:true,rest:false,forfeit:false});return pairs;}
function shuffleBrackets(players){const groups=new Map();players.forEach(p=>{const mp=matchPoints(p.id);if(!groups.has(mp))groups.set(mp,[]);groups.get(mp).push(p);});const brackets=[...groups.keys()].sort((a,b)=>b-a);const result=[];for(const mp of brackets){const g=groups.get(mp);for(let i=g.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[g[i],g[j]]=[g[j],g[i]];}result.push(...g);}return result;}
function generateSwiss(){const active=getActivePlayers(),n=active.length;if(n<2)return[];const sorted=shuffleBrackets(active);let bye=null,pool=sorted.map(p=>p.id);if(n%2===1){for(let i=pool.length-1;i>=0;i--){if(!hadBye(pool[i])){bye=pool[i];pool.splice(i,1);break;}}if(!bye)bye=pool.pop();}const pairs=pairPool(pool);/* pairPool non fallisce mai con pool pari: ogni abbinamento è ammesso (i rematch sono solo penalizzati) */if(bye)pairs.push({p1:bye,p2:null,p1wins:2,p2wins:0,draws:0,bye:true,rest:false,forfeit:false});return pairs;}
// Matching a costo minimo: costo coppia = rematch×1000 + |differenza match points|.
// Il primo giocatore rimasto (ordine del pool) si abbina al candidato migliore; a parità vince l'ordine del pool,
// così la casualità di shuffleBrackets resta. Memo sul sottoinsieme rimasto (bitmask): O(2^n·n) invece della
// ricerca esaustiva O(n!!), che con 16 giocatori impiegava decine di secondi per round.
function pairPool(pool){
  const n=pool.length;if(n===0)return[];
  const mp=pool.map(id=>matchPoints(id));
  const cost=pool.map((a,i)=>pool.map((b,j)=>(havePlayed(a,b)?1000:0)+Math.abs(mp[i]-mp[j])));
  const memo=new Map();
  function solve(mask){
    if(mask===0)return{score:0};
    if(memo.has(mask))return memo.get(mask);
    let i=0;while(!(mask&(1<<i)))i++;
    const rest=mask&~(1<<i),cands=[];
    for(let j=i+1;j<n;j++)if(rest&(1<<j))cands.push(j);
    cands.sort((a,b)=>(cost[i][a]-cost[i][b])||(a-b));
    let best=null;
    for(const j of cands){const sc=cost[i][j]+solve(rest&~(1<<j)).score;if(!best||sc<best.score){best={score:sc,i,j};if(sc===0)break;}}
    memo.set(mask,best);return best;
  }
  const pairs=[];
  for(let mask=(1<<n)-1;mask;){const b=solve(mask);pairs.push({p1:pool[b.i],p2:pool[b.j],p1wins:null,p2wins:null,draws:0,bye:false,rest:false,forfeit:false});mask&=~(1<<b.i)&~(1<<b.j);}
  return pairs;
}
function generatePairings(){return T.currentRound===1?generateDraftR1():generateSwiss();}

// ── DROP ──
function dropPlayer(){const sel=$id('dropSel');if(!sel)return;const pid=parseInt(sel.value);if(!pid)return;const p=T.players.find(p=>p.id===pid);if(!p)return;const hint=T.mode==='roundrobin'?' Le partite non giocate diventeranno forfeit.':' Una partita aperta del round corrente diventerà forfeit.';showModal(`Ritirare ${p.name}?`,'I risultati precedenti restano.'+hint,()=>{if(!doOp({t:'drop',pid})){toast(`${p.name} è già ritirato`);return;}renderRound();renderStandings();save();toast(`${p.name} ritirato`);});}

// ── TIMER ──
// Il timer è condiviso: avvio, pausa e azzeramento sono operazioni; ogni telefono conta da sé partendo da startedAt,
// un istante sull'orologio del server (clockNow in sync.js), così un telefono con l'ora sbagliata non va fuori tempo
function fmtTimer(){const rem=TM.total-TM.seconds;const min=Math.floor(Math.abs(rem)/60),sec=Math.abs(rem)%60;return `${rem<0?'+':''}${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;}
function timerTick(){TM.seconds=Math.floor((clockNow()-TM.startedAt)/1000);const rem=TM.total-TM.seconds;const el=document.querySelector('.timer-display');if(el){el.textContent=fmtTimer();el.className='timer-display'+(rem<=300?' warning':'');}if(rem<=300&&rem>0&&!TM.firedWarning){TM.firedWarning=true;beep(2);vibrate([150,80,150]);toast('5 minuti al termine del round');save();}if(rem<=0&&!TM.firedExpired){TM.firedExpired=true;beep(4);vibrate([200,100,200,100,400]);toast('Tempo scaduto!');save();}if(rem<=-300&&!TM.firedOvertime){TM.firedOvertime=true;beep(4);vibrate([400,200,400]);toast('+5 minuti oltre il tempo');save();}}
// Allinea il conteggio (interval e wake lock) a TM.running, comunque sia cambiato
function timerEnsure(){if(TM.running&&TM.startedAt&&!TM.interval){acquireWakeLock();TM.interval=setInterval(timerTick,1000);}else if(!TM.running&&TM.interval){clearInterval(TM.interval);TM.interval=null;releaseWakeLock();}}
function startTimer(){if(TM.running)return;ensureAudio();doOp({t:'timer',round:T.currentRound,running:true,seconds:TM.seconds,startedAt:clockNow()-TM.seconds*1000});save();renderRound();}
function pauseTimer(){const s=TM.running&&TM.startedAt?Math.floor((clockNow()-TM.startedAt)/1000):TM.seconds;doOp({t:'timer',round:T.currentRound,running:false,seconds:s,startedAt:null});save();renderRound();}
function clearTimerState(){TM.running=false;clearInterval(TM.interval);TM.interval=null;TM.seconds=0;TM.startedAt=null;TM.firedWarning=false;TM.firedExpired=false;TM.firedOvertime=false;releaseWakeLock();}
function resetTimer(){doOp({t:'timer',round:T.currentRound,running:false,seconds:0,startedAt:null,reset:true});save();renderRound();}

// ── OPERAZIONI ──
// Ogni modifica del torneo avviato passa da doOp. applyOp la applica a T/TM e restituisce false se non è più
// valida: con il torneo condiviso (live.js) le modifiche non ancora confermate dal server vengono riapplicate
// sopra lo stato arrivato da un altro telefono, quindi ogni operazione porta con sé le sue condizioni
// (quale partita, da quale round) invece di fidarsi solo degli indici.
function doOp(op){if(!applyOp(op))return false;if(typeof liveRecordOp==='function')liveRecordOp(op);return true;}
// Firma dei risultati: se cambia, i pairing calcolati per il round successivo non valgono più
function resultsSig(){return JSON.stringify([T.rounds.map(r=>r.pairings.map(m=>[m.p1,m.p2,m.p1wins,m.p2wins,m.draws])),T.players.map(p=>!!p.dropped)]);}
function applyOp(op){
  if(op.t==='join')return true;
  // Ripristino di una versione dalla cronologia: tutto lo stato torna com'era, gli acks restano i più recenti
  if(op.t==='restore'){const acks={...(T.acks||{})};liveLoadState(op.state);for(const[k,v]of Object.entries(acks))T.acks[k]=Math.max(T.acks[k]||0,v);return true;}
  if(op.t==='deck'){T.decks=T.decks||{};T.decks[op.pid]=op.colors;return true;}
  if(op.t==='archived'){T.archivedId=op.id;T.players.forEach(p=>{if(op.lids&&op.lids[p.id])p.leagueId=op.lids[p.id];});return true;}
  if(T.ended)return false;
  switch(op.t){
    case 'res':{
      const r=T.rounds[op.r],m=r&&r.pairings[op.m];
      if(!m||m.p1!==op.p1||m.p2!==op.p2||m.bye||m.rest)return false;
      // Swiss: solo il round in corso, salvo correzione di un round chiuso in modalità master (force)
      if(T.mode!=='roundrobin'&&op.r!==T.currentRound-1&&!(op.force&&op.r<T.currentRound))return false;
      m.p1wins=op.w1;m.p2wins=op.w2;m.draws=op.d;if(op.w1==null)m.forfeit=false;return true;
    }
    case 'drop':{
      const pid=op.pid,p=P(pid);if(!p||p.dropped)return false;
      p.dropped=true;p.droppedAtRound=T.currentRound;
      if(T.mode==='roundrobin'){T.rounds.forEach(r=>r.pairings.forEach(m=>{if(m.rest||m.bye||m.p1wins!==null)return;if(m.p1===pid){m.p1wins=0;m.p2wins=1;m.draws=0;m.forfeit=true;}else if(m.p2===pid){m.p1wins=1;m.p2wins=0;m.draws=0;m.forfeit=true;}}));}
      else if(T.currentRound>0&&T.rounds[T.currentRound-1]){T.rounds[T.currentRound-1].pairings.forEach(m=>{if(m.rest||m.bye||m.p1wins!==null)return;if(m.p1===pid){m.p1wins=0;m.p2wins=2;m.draws=0;m.forfeit=true;}else if(m.p2===pid){m.p1wins=2;m.p2wins=0;m.draws=0;m.forfeit=true;}});}
      return true;
    }
    case 'next':{
      if(T.currentRound!==op.from||T.currentRound>=T.totalRounds)return false;
      const cur=T.rounds[T.currentRound-1];if(cur&&cur.pairings.some(m=>m.p1wins==null))return false;
      // I pairing viaggiano con l'operazione (sono casuali): si rigenerano solo se nel frattempo è cambiato un risultato
      const sig=resultsSig();if(op.pairings&&op.sig!==sig){op.pairings=null;op.regen=true;}op.sig=sig;
      T.currentRound++;if(!op.pairings)op.pairings=generatePairings();
      T.rounds.push({pairings:op.pairings.map(m=>({...m})),locked:false});clearTimerState();return true;
    }
    case 'undo':{
      if(T.currentRound!==op.from||T.currentRound<=1)return false;
      T.rounds.pop();T.currentRound--;clearTimerState();if(T.rounds.length)T.rounds[T.rounds.length-1].locked=false;
      T.players.forEach(p=>{if(p.droppedAtRound&&p.droppedAtRound>T.currentRound){p.dropped=false;p.droppedAtRound=null;}});return true;
    }
    case 'end':{T.ended=true;TM.running=false;TM.startedAt=null;timerEnsure();T.rounds.forEach(r=>r.locked=true);return true;}
    case 'timer':{
      if(op.round!==T.currentRound)return false;
      TM.running=op.running;TM.seconds=op.seconds;TM.startedAt=op.startedAt;
      if(op.reset){TM.firedWarning=false;TM.firedExpired=false;TM.firedOvertime=false;}
      timerEnsure();return true;
    }
  }
  return false;
}
// Descrizione breve per la cronologia delle modifiche
function opNote(op){
  const n=pid=>shortName(pid);
  switch(op.t){
    case 'res':return op.w1==null?`R${op.r+1} · ${n(op.p1)} vs ${n(op.p2)}: risultato tolto`:T.mode==='roundrobin'?`R${op.r+1} · vince ${n(op.w1>op.w2?op.p1:op.p2)} (vs ${n(op.w1>op.w2?op.p2:op.p1)})`:`R${op.r+1} · ${n(op.p1)} ${op.w1}–${op.w2}${op.d?'–'+op.d:''} ${n(op.p2)}${op.force?' (correzione)':''}`;
    case 'drop':return `${n(op.pid)} ritirato`;
    case 'next':return op.from===0?'Torneo avviato':`Round ${op.from+1} generato`;
    case 'undo':return `Round ${op.from} annullato`;
    case 'end':return 'Torneo concluso';
    case 'timer':return op.reset?'Timer azzerato':op.running?'Timer avviato':'Timer in pausa';
    case 'deck':return `Mazzo di ${n(op.pid)}`;
    case 'archived':return 'Salvato nello storico';
    case 'join':return 'Un telefono si è unito';
    case 'restore':return `Ripristinata la versione ${op.label||''}`.trim();
  }
  return '';
}
// Messaggio per un'operazione scartata perché un altro telefono è arrivato prima
function opRejectedMsg(op){return op.t==='next'?'Il round successivo l\'ha già generato un altro telefono':op.t==='res'?'Risultato non salvato: il round è cambiato su un altro telefono':op.t==='timer'?'Timer non aggiornato: il round è cambiato':'Già fatto da un altro telefono';}

// ── ROUND ──
function nextRound(){if(T.currentRound>=T.totalRounds){endTournament();return;}if(!doOp({t:'next',from:T.currentRound}))return;viewingRound=T.currentRound;renderRound();updateStatus();save();}
function viewRound(n){const max=T.mode==='roundrobin'?T.totalRounds:T.currentRound;if(n>=1&&n<=max){viewingRound=n;renderRound();}}

function renderStickyBar(done,tot,isRR){
  let inner='';
  if(!isRR&&!T.ended){
    const warn=(TM.total-TM.seconds)<=300?' warning':'';
    inner+=`<div class="timer-display${warn}" aria-label="Timer round">${fmtTimer()}</div>
      <button class="rs-btn" onclick="${TM.running?'pauseTimer()':'startTimer()'}" aria-label="${TM.running?'Metti in pausa il timer':'Avvia il timer'}">${TM.running?'⏸':'▶'}</button>
      <button class="rs-btn" onclick="resetTimer()" aria-label="Azzera il timer">↺</button>`;
  }
  inner+=`<div class="rs-progress"><span class="done">${done}</span>/${tot} completati${done<tot?`<br><span class="pending">${tot-done} rimanent${tot-done===1?'e':'i'}</span>`:' ✓'}</div>`;
  return `<div class="round-sticky">${inner}</div>`;
}
// keepScroll: aggiornamento arrivato da un altro telefono, non spostare la pagina sotto le dita
function renderRound(keepScroll){
  const C=$id('roundContent');if(!T.rounds.length){C.innerHTML='<div class="card text-center text-dim">Nessun round</div>';return;}
  const isRR=T.mode==='roundrobin',maxNav=isRR?T.totalRounds:T.currentRound;
  const round=T.rounds[viewingRound-1];
  const real=round?round.pairings.filter(m=>!m.rest&&!m.bye):[],done=real.filter(m=>m.p1wins!==null).length,tot=real.length;
  let h='';
  if(round&&!T.ended)h+=renderStickyBar(done,tot,isRR);
  h+=`<div class="card" style="padding:12px 16px;"><div class="flex-between"><button class="btn btn-secondary btn-sm" onclick="viewRound(${viewingRound-1})" ${viewingRound<=1?'disabled':''} aria-label="Round precedente">←</button><span style="font-weight:800;font-size:0.95rem;">Round ${viewingRound} <span style="font-weight:500;color:var(--text-dim);">/ ${T.totalRounds}</span> <span class="mode-badge ${isRR?'rr':'swiss'}">${isRR?'BO1':'Swiss'}</span>${liveBadgeHtml()}</span><button class="btn btn-secondary btn-sm" onclick="viewRound(${viewingRound+1})" ${viewingRound>=maxNav?'disabled':''} aria-label="Round successivo">→</button></div>${round&&!T.ended?`<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:10px;" onclick="openAnnounce()">📣 Annuncia pairing</button>`:''}</div>`;
  if(!round){C.innerHTML=h;return;}
  // Round Swiss già chiusi: modificabili solo in modalità master (correzione di un errore)
  const pastFix=!isRR&&viewingRound<T.currentRound&&typeof masterOn==='function'&&masterOn();
  const canEdit=!T.ended&&(isRR||viewingRound===T.currentRound||pastFix);
  let firstInc=null;
  for(let i=0;i<round.pairings.length;i++){
    const m=round.pairings[i],p1=T.players.find(p=>p.id===m.p1),p2=m.p2?T.players.find(p=>p.id===m.p2):null;
    if(m.rest){h+=`<div class="match-card rest"><div class="match-header"><span>Riposo</span><span>—</span></div><div class="match-players"><div class="match-player text-dim">${esc(p1.name)} riposa</div></div></div>`;continue;}
    if(m.bye){h+=`<div class="match-card bye"><div class="match-header"><span>Bye</span><span>—</span></div><div class="match-players"><div class="match-player">${esc(p1.name)}</div><div class="match-vs">bye</div><div class="match-player text-dim">2 – 0</div></div></div>`;continue;}
    const has=m.p1wins!==null;if(!has&&!firstInc)firstInc=`match-${viewingRound}-${i}`;
    const flash=(lastScoredMatch===i)?'flash-scored':'',forf=m.forfeit?'forfeit':'';
    const w1=has&&m.p1wins>m.p2wins?'winner':'',w2=has&&m.p2wins>m.p1wins?'winner':'';
    const d1=p1.dropped?'dropped':'',d2=p2&&p2.dropped?'dropped':'';
    h+=`<div class="match-card ${flash} ${forf}" id="match-${viewingRound}-${i}"><div class="match-header"><span>Tavolo ${i+1}</span>${m.forfeit?'<span class="match-status-forfeit">Forfeit</span>':has?'<span class="match-status-done">Completato</span>':'<span>In attesa</span>'}</div>
      <div class="match-players"><div class="match-player ${w1} ${d1}">${esc(p1.name)}</div><div class="match-vs">vs</div><div class="match-player ${w2} ${d2}">${p2?esc(p2.name):'?'}</div></div>`;
    if(canEdit&&!m.forfeit){if(has)h+=`<div class="match-result-display" role="button" tabindex="0" onclick="editMatch(${viewingRound-1},${i})">${fmtRes(m)}<span>Tocca per modificare</span></div>`;else h+=isRR?rrBtns(i,m):swissBtns(i,m);}
    else if(has)h+=`<div class="match-result-display" style="cursor:default;">${fmtRes(m)}</div>`;
    h+='</div>';
  }
  if(!T.ended){if(isRR)h+=renderRRActions();else if(viewingRound===T.currentRound)h+=renderSwissActions(round);}
  C.innerHTML=h;lastScoredMatch=-1;updateStatus();
  if(firstInc&&canEdit&&!keepScroll)setTimeout(()=>{const el=document.getElementById(firstInc);if(el)el.scrollIntoView({behavior:reducedMotion()?'auto':'smooth',block:'center'});},120);
}

function renderSwissActions(round){const allDone=round.pairings.every(m=>m.p1wins!==null);let h='<div class="card" style="padding:14px;">';const act=getActivePlayers();
  if(act.length>2){h+=`<div class="drop-row mb"><select id="dropSel" aria-label="Seleziona giocatore da ritirare"><option value="">Ritira giocatore...</option>${act.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button class="btn btn-danger btn-sm" onclick="dropPlayer()">Ritira</button></div>`;}
  if(allDone){h+=T.currentRound<T.totalRounds?'<button class="btn btn-primary" onclick="nextRound()">Round successivo →</button>':'<button class="btn btn-primary" onclick="confirmEnd()">Termina torneo</button>';}
  if(T.currentRound>1)h+=`<button class="btn btn-secondary mt" onclick="confirmUndo()">Annulla round</button>`;return h+historyBtn()+'</div>';}
// Cronologia delle modifiche del torneo condiviso (admin.js)
function historyBtn(){return typeof syncConfigured==='function'&&syncConfigured()&&T.id?`<button class="btn btn-secondary btn-sm mt" style="width:100%;" onclick="openHistory('${T.id}')">🕘 Cronologia modifiche</button>`:'';}
function renderRRActions(){const allDone=T.rounds.every(r=>r.pairings.filter(m=>!m.rest).every(m=>m.p1wins!==null));let h='<div class="card" style="padding:14px;">';const act=getActivePlayers();
  if(act.length>2){h+=`<div class="drop-row mb"><select id="dropSel" aria-label="Seleziona giocatore da ritirare"><option value="">Ritira giocatore...</option>${act.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button class="btn btn-danger btn-sm" onclick="dropPlayer()">Ritira</button></div>`;}
  if(allDone)h+='<button class="btn btn-primary" onclick="confirmEnd()">Termina torneo</button>';
  else{const next=T.rounds.findIndex(r=>r.pairings.some(m=>!m.rest&&m.p1wins===null));if(next>=0&&next!==viewingRound-1)h+=`<button class="btn btn-secondary" onclick="viewRound(${next+1})">Vai a Round ${next+1}</button>`;}
  return h+historyBtn()+'</div>';}

function swissBtns(idx,m){const n1=shortName(m.p1),n2=shortName(m.p2);
  const main=[[2,0,0,'2–0'],[2,1,0,'2–1'],[1,2,0,'1–2'],[0,2,0,'0–2']];
  const more=[[1,0,0,'1–0'],[0,1,0,'0–1'],[1,1,0,'1–1'],[1,0,1,'1–0–1'],[0,1,1,'0–1–1'],[2,0,1,'2–0–1'],[0,2,1,'0–2–1'],[1,1,1,'1–1–1'],[0,0,1,'0–0–1']];
  const mkBtn=s=>`<button class="score-btn" onclick="setRes(${viewingRound-1},${idx},${s[0]},${s[1]},${s[2]})">${s[3]}</button>`;
  return `<div style="padding:4px 16px;font-size:0.72rem;color:var(--text-dim);text-align:center;font-weight:600;">${esc(n1)} — ${esc(n2)}</div>`
    +`<div class="match-score-btns main">${main.map(mkBtn).join('')}<button class="score-btn draw-btn" onclick="setRes(${viewingRound-1},${idx},0,0,1)" title="Pareggio intenzionale (0 partite giocate, 1 punto a testa)">ID</button></div>`
    +`<details class="more-results"><summary aria-label="Mostra altri risultati per fine tempo">Altri risultati…<button class="score-info-btn" type="button" aria-label="Cosa significano i numeri?" onclick="event.preventDefault();event.stopPropagation();showScoreInfo();">?</button></summary><div class="match-score-btns">${more.map(mkBtn).join('')}</div></details>`;}
function rrBtns(idx,m){const n1=shortName(m.p1),n2=shortName(m.p2);
  return `<div class="match-score-btns"><button class="score-btn win-btn" onclick="setRes(${viewingRound-1},${idx},1,0,0)">${esc(n1)}</button><button class="score-btn win-btn" onclick="setRes(${viewingRound-1},${idx},0,1,0)">${esc(n2)}</button></div>`;}

// Restituisce HTML (va in innerHTML): i nomi passano da esc()
function fmtRes(m){if(m.bye)return'BYE';if(m.rest)return'Riposo';if(m.p1wins==null)return'—';const winner=()=>esc(shortName(m.p1wins>m.p2wins?m.p1:m.p2));if(m.forfeit)return`${winner()} (forfeit)`;if(T.mode==='roundrobin')return`${winner()} vince`;if(m.p1wins===0&&m.p2wins===0&&m.draws>0)return'ID (patta)';return m.draws>0?`${m.p1wins} – ${m.p2wins} – ${m.draws}`:`${m.p1wins} – ${m.p2wins}`;}

function setRes(ri,mi,w1,w2,d){const r=T.rounds[ri],m=r&&r.pairings[mi],force=T.mode!=='roundrobin'&&ri<T.currentRound-1;if(!m||!doOp({t:'res',r:ri,m:mi,p1:m.p1,p2:m.p2,w1,w2,d,force}))return;lastScoredMatch=mi;vibrate(50);renderRound();renderStandings();save();if(checkUpset(m)){toast('💥 Colpaccio!');celebrate();}else toast('Risultato salvato');}
function editMatch(ri,mi){const m=T.rounds[ri].pairings[mi],p1=m.p1,p2=m.p2,force=T.mode!=='roundrobin'&&ri<T.currentRound-1;showModal('Modificare risultato?',force?'Round già chiuso: cambiano classifica e tiebreaker, ma i pairing dei round successivi restano quelli già fatti.':'Il risultato verrà resettato.',()=>{if(!doOp({t:'res',r:ri,m:mi,p1,p2,w1:null,w2:null,d:0,force})){toast(opRejectedMsg({t:'res'}));return;}renderRound();renderStandings();save();});}
function showScoreInfo(){
  showModalCustom('Sistema punteggio MTG','Formato: V – S – P (Best of 3)',
    `<div style="text-align:left;font-size:0.88rem;line-height:1.6;color:var(--text-mid);">
      <p style="margin:0 0 12px;"><b>V</b> = partite vinte dal 1° giocatore<br><b>S</b> = partite vinte dal 2° giocatore<br><b>P</b> = partite finite in patta</p>
      <p style="margin:0 0 6px;font-weight:700;color:var(--text);">Risultati normali (2 numeri):</p>
      <p style="margin:0 0 12px;">Usa <b>2–0</b>, <b>2–1</b>, <b>1–2</b>, <b>0–2</b> quando il match è finito normalmente, senza partite pattate.</p>
      <p style="margin:0 0 6px;font-weight:700;color:var(--text);">Quando aggiungere il 3° numero (patte):</p>
      <ul style="margin:0 0 12px;padding-left:20px;">
        <li>Tempo scaduto a metà di una partita</li>
        <li>Danno letale simultaneo</li>
        <li>Patta intenzionale di un singolo game</li>
      </ul>
      <p style="margin:0 0 6px;font-weight:700;color:var(--text);">Esempi tipici:</p>
      <ul style="margin:0 0 12px;padding-left:20px;">
        <li><b>1–0</b> → giocata 1 sola partita, vinta dal 1°</li>
        <li><b>1–0–1</b> → 1° vince gara 1, gara 2 in patta</li>
        <li><b>1–1–1</b> → 1 vittoria a testa + 1 patta → match patta</li>
        <li><b>0–0–1</b> → solo 1 partita giocata e pattata</li>
        <li><b>ID</b> → patta intenzionale dell'intero match (0 partite)</li>
      </ul>
      <p style="margin:0;font-size:0.78rem;color:var(--text-dim);">Le patte di game contano per il GW% (tiebreaker della classifica), quindi vanno sempre registrate correttamente.</p>
    </div>
    <button class="btn btn-primary mt" onclick="closeModal()">Ho capito</button>`);
}

// ── ANNOUNCE ──
function openAnnounce(){
  const round=T.rounds[viewingRound-1];if(!round)return;
  let h=`<div class="announce-title">Round ${viewingRound}</div><div class="announce-sub">Accoppiamenti</div>`;
  round.pairings.forEach((m,i)=>{
    const p1=P(m.p1),p2=m.p2?P(m.p2):null;
    if(m.rest){h+=`<div class="announce-match"><div class="announce-table">Riposo</div><div class="announce-names">${esc(p1.name)}</div></div>`;return;}
    if(m.bye){h+=`<div class="announce-match"><div class="announce-table">Bye</div><div class="announce-names">${esc(p1.name)}</div></div>`;return;}
    h+=`<div class="announce-match"><div class="announce-table">Tavolo ${i+1}</div><div class="announce-names">${esc(p1.name)}<span class="announce-vs">vs</span>${p2?esc(p2.name):'?'}</div>${p2?rivalryHtml(p1,p2):''}</div>`;
  });
  $id('announceContent').innerHTML=h;
  $id('announceOverlay').classList.add('active');
  const closeBtn=$id('announceOverlay').querySelector('.announce-actions button:last-child');if(closeBtn)closeBtn.focus();
}
function closeAnnounce(){$id('announceOverlay').classList.remove('active');}
function copyText(t,msg){
  const fallback=()=>{let ok=false;try{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();ok=document.execCommand('copy');document.body.removeChild(ta);}catch(e){}toast(ok?msg:'Copia non riuscita');};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(()=>toast(msg),fallback);else fallback();
}
function copyPairings(){
  const round=T.rounds[viewingRound-1];if(!round)return;
  let t=`⚔️ Round ${viewingRound} — Pairing\n${'─'.repeat(26)}\n`;
  round.pairings.forEach((m,i)=>{
    const p1=P(m.p1),p2=m.p2?P(m.p2):null;
    if(m.rest){t+=`💤 ${p1.name} riposa\n`;return;}
    if(m.bye){t+=`🎁 ${p1.name} — bye\n`;return;}
    t+=`T${i+1}: ${p1.name} vs ${p2?p2.name:'?'}\n`;
  });
  copyText(t,'Pairing copiati!');
}

function confirmEnd(){showModal('Terminare il torneo?','La classifica diventerà definitiva e i risultati non si potranno più modificare.',endTournament);}
function confirmUndo(){showModal('Annullare il round?','Tornerai al round precedente.',undoRound);}
function undoRound(){if(!doOp({t:'undo',from:T.currentRound}))return;viewingRound=T.currentRound;updateStatus();renderRound();renderStandings();save();toast('Round annullato');}
function endTournament(){if(!doOp({t:'end'}))return;const archived=archiveCurrent();updateStatus();renderRound();renderStandings();save();switchTab('standings');celebrate();vibrate([100,60,100,60,250]);toast(archived?'🏆 Torneo concluso e salvato nella lega':'Torneo concluso!');}
// L'id in archivio è quello del torneo: se due telefoni che lo gestiscono insieme lo salvano, resta un solo documento
function archiveCurrent(){if(!T.ended||T.archivedId)return false;try{const t=archiveTournament();doOp({t:'archived',id:t.id,lids:Object.fromEntries(T.players.map(p=>[p.id,p.leagueId]))});save();return true;}catch(e){console.error(e);toast('Errore nel salvataggio nello storico');return false;}}
function celebrate(){try{if(!document.body||document.getElementById('confettiWrap')||reducedMotion())return;const wrap=document.createElement('div');wrap.id='confettiWrap';wrap.style.cssText='position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:500;';const colors=['#3d6b8e','#c4793c','#3a8a5c','#e8b13c','#c0453a','#8aa3b8'];for(let i=0;i<70;i++){const p=document.createElement('div');p.className='confetti-piece';p.style.left=Math.random()*100+'%';p.style.background=colors[i%colors.length];p.style.animationDuration=(2.4+Math.random()*1.8)+'s';p.style.animationDelay=(Math.random()*0.7)+'s';p.style.transform=`rotate(${Math.random()*360}deg)`;wrap.appendChild(p);}document.body.appendChild(wrap);setTimeout(()=>{if(wrap.parentNode)wrap.parentNode.removeChild(wrap);},5500);}catch(e){}}

// ── STANDINGS ──
function standingsAt(limit){const saved=T.rounds;T.rounds=saved.slice(0,limit);const st=getSwissStandings();T.rounds=saved;return st;}
// Medaglie a fine torneo: i primi tre non ritirati (un drop resta in classifica ma non va sul podio)
function medalsById(st){const m=new Map();if(T.ended)st.filter(p=>!p.dropped).slice(0,3).forEach((p,i)=>m.set(p.id,['🥇','🥈','🥉'][i]));return m;}
function renderStandings(){
  const isRR=T.mode==='roundrobin',st=getSwissStandings(),medals=medalsById(st);let h='';
  const podium=st.filter(p=>medals.has(p.id));
  if(podium.length>=3){
    const[w1,w2,w3]=podium;
    h+=`<div class="card text-center" style="border-color:var(--accent);border-width:2px;">
      <div style="font-family:'Fraunces',serif;font-weight:900;font-size:1.05rem;color:var(--accent-dark);">Torneo concluso</div>
      <div class="podium-wrap">
        <div class="podium-step second"><div class="podium-medal">🥈</div><div class="podium-name">${esc(w2.name)}</div><div class="podium-block">2</div></div>
        <div class="podium-step first"><div class="podium-medal">🥇</div><div class="podium-name">${esc(w1.name)}</div><div class="podium-block">1</div></div>
        <div class="podium-step third"><div class="podium-medal">🥉</div><div class="podium-name">${esc(w3.name)}</div><div class="podium-block">3</div></div>
      </div></div>`;
  }
  let deltas=null;
  if(!isRR&&T.rounds.length>1){
    const prev=standingsAt(T.rounds.length-1);
    const prevRank=new Map(prev.map((p,i)=>[p.id,i]));
    deltas=new Map(st.map((p,i)=>{const pr=prevRank.get(p.id);return[p.id,(pr==null?i:pr)-i];}));
  }
  const cols=4+(deltas?1:0);
  h+=`<div class="card"><div class="card-title">Classifica${T.ended?' finale':''} <span class="mode-badge ${isRR?'rr':'swiss'}">${isRR?'BO1':'Swiss'}</span></div><div style="overflow-x:auto;margin:0 -4px;padding:0 4px;"><table class="standings-table"><thead><tr><th scope="col">#</th><th scope="col">Giocatore</th><th scope="col">${isRR?'W-L':'W-L-D'}</th><th scope="col">Pts</th>${deltas?'<th scope="col" aria-label="Variazione posizione">Δ</th>':''}</tr></thead><tbody>
    ${st.map((p,i)=>{
      const rank=medals.get(p.id)||i+1;
      const rec=isRR?`${p.record.wins}-${p.record.losses}`:`${p.record.wins}-${p.record.losses}-${p.record.draws}`;
      let dCell='';
      if(deltas){const d=deltas.get(p.id)||0;dCell=`<td><span class="standings-delta ${d>0?'up':d<0?'down':'flat'}">${d>0?'▲'+d:d<0?'▼'+(-d):'–'}</span></td>`;}
      return `<tr onclick="togglePlayer(${p.id})" tabindex="0" role="button" aria-expanded="${expandedPlayer===p.id}" class="${p.dropped?'dropped':''} ${(T.ended?medals.has(p.id):i<3)?'top3':''}"><td class="standings-rank">${rank}</td><td class="standings-name">${esc(p.name)}${p.dropped?' ✗':''} <span class="who-titles">${leagueTitles(tournamentLid(p))}</span></td><td class="standings-record">${rec}</td><td>${p.mp}</td>${dCell}</tr>${expandedPlayer===p.id?`<tr><td colspan="${cols}" class="detail-cell" style="padding:0;">${renderDetail(p.id)}</td></tr>`:''}`;
    }).join('')}
    </tbody></table></div>
    <div class="text-xs text-dim mt" style="text-align:center;">Tocca un giocatore per match e tiebreaker (Pts → ${isRR?'scontri diretti → ':''}OMW% → GW% → OGW%)</div></div>`;
  if(T.ended&&!T.archivedId)h+=`<button class="btn btn-primary mt" onclick="if(archiveCurrent()){renderStandings();toast('Salvato nella lega');}">🏆 Salva nello storico della lega</button>`;
  if(T.started)h+=`<button class="share-btn" onclick="copyStandings()">📋 Copia classifica</button>`+historyBtn();
  h+=`<button class="btn btn-secondary mt" onclick="confirmReset()">Nuovo torneo</button>`;
  $id('standingsContent').innerHTML=h;
}
function togglePlayer(pid){expandedPlayer=expandedPlayer===pid?null:pid;renderStandings();}
function renderDetail(pid){const ms=getPlayerMatches(pid);const lid=tournamentLid(P(pid));const tb=`<div class="player-detail-tb">OMW ${(omw(pid)*100).toFixed(1)}% · GW ${(gwp(pid)*100).toFixed(1)}% · OGW ${(ogw(pid)*100).toFixed(1)}%</div>${deckPickerHtml(pid)}${lid?`<button class="link-btn" onclick="event.stopPropagation();openProfile('${lid}')">Profilo in lega →</button>`:''}`;if(!ms.length)return`<div class="player-detail"><div class="text-sm text-dim">Nessun match</div>${tb}</div>`;return`<div class="player-detail">${ms.map(m=>{const c=m.result==='W'?'var(--green)':m.result==='L'?'var(--red)':'var(--text-dim)';return`<div class="player-detail-match"><span>R${m.round} vs ${esc(m.opp)}</span><span style="color:${c};font-weight:700;">${m.score}</span></div>`;}).join('')}${tb}</div>`;}
function copyStandings(){const isRR=T.mode==='roundrobin',st=getSwissStandings();let t=`${T.ended?'🏆 CLASSIFICA FINALE':'📊 Classifica'}\n${isRR?'Round Robin BO1':'Swiss'} · ${T.players.length} giocatori\n${'─'.repeat(26)}\n`;const medals=medalsById(st);st.forEach((p,i)=>{const m=medals.get(p.id)||`${i+1}.`;t+=isRR?`${m} ${p.name} — ${p.record.wins}W ${p.record.losses}L (${p.mp}pts)\n`:`${m} ${p.name} — ${p.record.wins}W ${p.record.losses}L ${p.record.draws}D (${p.mp}pts)\n`;});copyText(t,'Classifica copiata!');}
function confirmReset(){
  // Torneo gestito anche da altri telefoni: si può uscire solo da qui senza toglierlo agli altri
  if(T.started&&!T.ended&&typeof liveOthersManaging==='function'&&liveOthersManaging()){
    showModalCustom('Nuovo torneo?','Questo torneo lo stanno gestendo anche altri telefoni.',
      `<button class="btn btn-primary" onclick="closeModal();resetTournament(false)">Esci solo da questo telefono</button>
      <button class="btn btn-danger mt" onclick="closeModal();requireMaster(()=>resetTournament(true))">Chiudi il torneo per tutti</button>
      <button class="btn btn-secondary btn-sm mt" onclick="closeModal()">Annulla</button>`);
    return;
  }
  showModal('Nuovo torneo?',T.archivedId?'Il torneo è già salvato nello storico della lega.':T.ended?'Attenzione: questo torneo non è stato salvato nello storico della lega.':T.started?'Il torneo in corso non è concluso: non finirà nello storico della lega.':'I giocatori inseriti verranno tolti. Lo storico della lega resta.',()=>resetTournament(true));
}
function resetTournament(clearLive){if(clearLive)liveClearOnReset();localStorage.removeItem('mtg-t');location.reload();}
// Il torneo concluso ancora aperto qui è stato eliminato dalla lega (da questo telefono o da un altro, via sync):
// Setup, Tavolo, Round e Classifica si svuotano come con "Nuovo torneo". Dopo il reload si torna sulla Lega.
function currentTournamentDeleted(){if(!T.started||!T.ended)return false;const t=L.tournaments[T.archivedId||T.id];return !!(t&&t.deleted);}
function clearDeletedTournament(msg){if(!currentTournamentDeleted())return false;try{sessionStorage.setItem('mtg-after-reset',JSON.stringify({tab:'league',msg}));}catch(e){}resetTournament(true);return true;}

// ── NAV + SWIPE ──
function switchTab(tab,fromPop){$qsa('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$qsa('.screen').forEach(s=>s.classList.toggle('active',s.id===`screen-${tab}`));if(tab==='round'){if(!T.mode||T.mode==='swiss')viewingRound=T.currentRound||1;renderRound();}if(tab==='standings')renderStandings();if(tab==='draft')renderSeating();if(tab==='league')renderLeague();window.scrollTo(0,0);if(!fromPop&&(!history.state||history.state.tab!==tab))history.pushState({tab},'');}
history.replaceState({tab:'setup'},'');
window.addEventListener('popstate',e=>{
  // Con modal/annuncio aperto il back chiude solo quello: la voce del tab corrente viene rimessa in cronologia
  if($id('modal').classList.contains('active')||$id('announceOverlay').classList.contains('active')){
    closeModal();closeAnnounce();
    const cur=document.querySelector('.nav-btn.active');history.pushState({tab:(cur&&cur.dataset.tab)||'setup'},'');return;
  }
  let tab=(e.state&&e.state.tab)||'setup';
  // La cronologia sopravvive al reload di "Nuovo torneo": non tornare su tab che richiedono un torneo avviato
  if(((tab==='round'||tab==='standings')&&!T.started)||(tab==='draft'&&T.players.length<4))tab='setup';
  switchTab(tab,true);
});
$qsa('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const t=btn.dataset.tab;if(t==='setup'){switchTab(t);return;}if(t==='draft'&&T.players.length<4){toast('Servono almeno 4 giocatori');return;}if((t==='round'||t==='standings')&&!T.started){toast('Inizia prima il torneo');return;}switchTab(t);}));
function updateStatus(){const bar=$id('statusBar'),sub=$id('headerSub');if(!T.started){bar.classList.add('hidden');sub.textContent='Nuovo torneo';return;}bar.classList.remove('hidden');const ml=T.mode==='roundrobin'?'Round Robin BO1':'Swiss';if(T.ended){bar.className='status status-ended';bar.textContent=`Concluso · ${ml} · ${T.players.length} giocatori`;sub.textContent='Torneo concluso';}else{bar.className='status status-active';const done=T.rounds.filter(r=>r.pairings.filter(m=>!m.rest).every(m=>m.p1wins!==null)).length;bar.textContent=`${ml} · ${done}/${T.totalRounds} round`;sub.textContent=`${ml} · Round ${viewingRound}`;}}

let sx=0,sy=0;
document.addEventListener('touchstart',e=>{if(!e.target.closest('.swipe-area'))return;sx=e.touches[0].clientX;sy=e.touches[0].clientY;},{passive:true});
document.addEventListener('touchend',e=>{if(!e.target.closest('.swipe-area'))return;const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5){if(dx<0)viewRound(viewingRound+1);else viewRound(viewingRound-1);}},{passive:true});
