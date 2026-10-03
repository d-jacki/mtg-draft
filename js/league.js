// Lega: anagrafica giocatori, archivio tornei, campionato, rating Elo, statistiche, scontri diretti, achievement.
// Local-first: tutto sta in localStorage ('mtg-league'); sync.js lo sincronizza con Supabase se configurato.
// Ogni documento (giocatore o torneo) ha updatedAt; le cancellazioni sono tombstone (deleted: true) così il
// sync può propagarle. Le statistiche non vengono mai salvate: si ricalcolano dall'archivio (cache in memoria).

const LEAGUE_KEY = 'mtg-league';
const L = { players: {}, tournaments: {}, dirty: [] };
const ELO_START = 1500, ELO_K = 32;
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAMES = { W: 'Bianco', U: 'Blu', B: 'Nero', R: 'Rosso', G: 'Verde' };
const PLAYER_EMOJIS = ['🦉', '🐉', '🧙', '🗡️', '🛡️', '🔥', '💧', '🌲', '💀', '☀️', '🐺', '🦊', '🐙', '🌙', '⚡', '🍄', '🦇', '🐍', '🦁', '🪄'];

function uid(prefix) {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${r}`;
}
function isoDate(d) { d = d || new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// ── Validazione di quello che arriva da fuori (sync, import, torneo live) ──
// Id e numeri finiscono dentro innerHTML e onclick senza escape: chi ha il PIN (o un server diverso aperto da un
// link invito) non deve poter iniettare markup, e un documento malformato non deve rompere il tab Lega.
const safeId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const isStr = s => typeof s === 'string';
const isScore = n => Number.isInteger(n) && n >= 0 && n <= 9;
function validMatch(m, isId) {
  return !!m && typeof m === 'object' && isId(m.p1) && (m.p2 == null || isId(m.p2))
    && (m.p1wins == null || isScore(m.p1wins)) && (m.p2wins == null || isScore(m.p2wins)) && (m.draws == null || isScore(m.draws));
}
function validPlayerDoc(p) {
  return safeId(p.id) && isStr(p.name) && (p.emoji == null || isStr(p.emoji)) && (p.mergedInto == null || safeId(p.mergedInto));
}
function validTournamentDoc(t) {
  const ids = a => Array.isArray(a) && a.every(safeId);
  const obj = o => !!o && typeof o === 'object' && !Array.isArray(o);
  return safeId(t.id) && isStr(t.date) && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && (t.season == null || /^\d{4}$/.test(t.season))
    && ids(t.entrants) && ids(t.final) && (t.dropped == null || ids(t.dropped))
    && Array.isArray(t.rounds) && t.rounds.every(r => Array.isArray(r) && r.every(m => validMatch(m, safeId)))
    && (t.decks == null || (obj(t.decks) && Object.entries(t.decks).every(([k, v]) => safeId(k) && isStr(v))))
    && (t.names == null || (obj(t.names) && Object.values(t.names).every(isStr)))
    && (t.set == null || isStr(t.set));
}

// ── Persistenza ──
function loadLeague() {
  try {
    const d = JSON.parse(localStorage.getItem(LEAGUE_KEY));
    if (d) { L.players = d.players || {}; L.tournaments = d.tournaments || {}; L.dirty = d.dirty || []; }
  } catch (e) {}
  _stats = null;
}
// silent: dati arrivati dal sync, non vanno rimandati al server né fanno ripartire il sync
function saveLeague(silent) {
  localStorage.setItem(LEAGUE_KEY, JSON.stringify({ players: L.players, tournaments: L.tournaments, dirty: L.dirty }));
  _stats = null;
  if (!silent && typeof syncSoon === 'function') syncSoon();
}
// Aggiorna il timestamp (sempre crescente, anche con orologi imprecisi) e segna il documento da sincronizzare
function touch(doc) {
  doc.updatedAt = Math.max(Date.now(), (doc.updatedAt || 0) + 1);
  if (!L.dirty.includes(doc.id)) L.dirty.push(doc.id);
  return doc;
}
// Unisce documenti arrivati da fuori (sync o import): vince il più recente (last-write-wins)
function mergeLeagueDocs(docs, markDirty) {
  let changed = 0;
  for (const { kind, data } of docs) {
    if (!data || typeof data !== 'object') continue;
    const coll = kind === 'player' ? L.players : kind === 'tournament' ? L.tournaments : null;
    if (!coll || !(kind === 'player' ? validPlayerDoc(data) : validTournamentDoc(data))) continue;
    const local = coll[data.id];
    if (!local || (data.updatedAt || 0) > (local.updatedAt || 0)) {
      coll[data.id] = data; changed++;
      if (markDirty && !L.dirty.includes(data.id)) L.dirty.push(data.id);
    }
  }
  if (changed) saveLeague(!markDirty);
  return changed;
}
function leagueDocs(ids) {
  const out = [];
  for (const p of Object.values(L.players)) if (!ids || ids.includes(p.id)) out.push({ kind: 'player', data: p });
  for (const t of Object.values(L.tournaments)) if (!ids || ids.includes(t.id)) out.push({ kind: 'tournament', data: t });
  return out;
}

// ── Anagrafica ──
function resolvePlayer(id) { let p = L.players[id], guard = 0; while (p && p.mergedInto && guard++ < 20) p = L.players[p.mergedInto]; return p || null; }
function canonicalId(id) { const p = resolvePlayer(id); return p ? p.id : id; }
function leaguePlayers() { return Object.values(L.players).filter(p => !p.deleted && !p.mergedInto); }
function findPlayerByName(name) { const n = String(name).trim().toLowerCase(); return leaguePlayers().find(p => p.name.toLowerCase() === n) || null; }
function leagueName(id) { const p = resolvePlayer(id); return p ? p.name : '?'; }
// HTML: l'emoji è un testo libero del documento, va escapato come il nome
function leagueEmoji(id) { const p = resolvePlayer(id); return esc((p && p.emoji) || '🙂'); }
function createPlayer(name, emoji, id) {
  const p = { id: id || uid('p'), name: String(name).trim(), emoji: emoji || PLAYER_EMOJIS[Math.floor(Math.random() * PLAYER_EMOJIS.length)], createdAt: Date.now() };
  L.players[p.id] = touch(p);
  return p;
}
function updatePlayer(id, fields) {
  const p = L.players[id]; if (!p) return null;
  Object.assign(p, fields); touch(p); saveLeague(); return p;
}
// Unione di due profili doppi: il vecchio punta al nuovo, i tornei archiviati non vanno riscritti
function mergePlayers(fromId, intoId) {
  if (fromId === intoId || canonicalId(intoId) === fromId) return false;
  const from = L.players[fromId]; if (!from) return false;
  from.mergedInto = canonicalId(intoId); touch(from); saveLeague(); return true;
}

// ── Archivio ──
// Classifica di un torneo archiviato: i ritirati scivolano in fondo (restano, ma non contendono podio e punti)
function rankedIds(t) { const dropped = new Set(t.dropped || []); return [...t.final.filter(id => !dropped.has(id)), ...t.final.filter(id => dropped.has(id))]; }
function sortedTournaments() {
  return Object.values(L.tournaments).filter(t => !t.deleted)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
}
function leagueSeasons() { return [...new Set(sortedTournaments().map(t => t.season))].sort().reverse(); }
function currentSeason() { return String(new Date().getFullYear()); }

// Salva nello storico il torneo concluso (T). Crea in anagrafica chi non c'è ancora.
function archiveTournament() {
  const map = {};
  for (const p of T.players) {
    let lid = p.leagueId && resolvePlayer(p.leagueId) ? canonicalId(p.leagueId) : null;
    if (!lid) {
      // Giocatore nuovo: id ricavato dagli id del torneo e del giocatore nel torneo, non casuale. Se due telefoni che gestiscono
      // insieme il torneo lo archiviano nello stesso momento creano lo stesso profilo invece di due doppi.
      const ex = findPlayerByName(p.name), did = T.id ? `p_${T.id}_${p.id}` : null;
      lid = ex ? ex.id : did && L.players[did] ? canonicalId(did) : createPlayer(p.name, null, did).id;
    }
    p.leagueId = lid; map[p.id] = lid;
  }
  const st = getSwissStandings();
  const decks = {};
  for (const [pid, colors] of Object.entries(T.decks || {})) if (map[pid] && colors) decks[map[pid]] = colors;
  const now = new Date();
  const t = {
    // Stesso id del torneo: se lo archiviano due telefoni che lo gestivano insieme resta un solo documento
    id: T.id || uid('t'), date: isoDate(now), season: String(now.getFullYear()),
    set: T.set || '', mode: T.mode, totalRounds: T.totalRounds, createdAt: Date.now(),
    entrants: T.players.map(p => map[p.id]),
    names: Object.fromEntries(T.players.map(p => [map[p.id], p.name])),
    dropped: T.players.filter(p => p.dropped).map(p => map[p.id]),
    final: st.map(p => map[p.id]),
    rounds: T.rounds.map(r => r.pairings.map(m => ({
      p1: map[m.p1], p2: m.p2 ? map[m.p2] : null, p1wins: m.p1wins, p2wins: m.p2wins, draws: m.draws || 0,
      bye: !!m.bye, rest: !!m.rest, forfeit: !!m.forfeit,
    }))),
    decks,
  };
  L.tournaments[t.id] = touch(t);
  saveLeague();
  return t;
}
function updateTournament(id, fields) { const t = L.tournaments[id]; if (!t) return null; Object.assign(t, fields); touch(t); saveLeague(); return t; }
function deleteTournament(id) { return updateTournament(id, { deleted: true }); }
// Eliminazione definitiva: resta un tombstone minimo, senza risultati né nomi, che il sync porta sugli altri telefoni
function purgeTournament(id) {
  const t = L.tournaments[id]; if (!t) return null;
  L.tournaments[id] = touch({ id, date: t.date, season: t.season, createdAt: t.createdAt, updatedAt: t.updatedAt, deleted: true, purged: true, entrants: [], final: [], rounds: [] });
  saveLeague(); return L.tournaments[id];
}

// ── Campionato: 1 punto per ogni giocatore che ti finisce dietro + 1 di presenza + 2 al vincitore ──
function championshipPoints(rank, entrants, dropped) { return dropped ? 1 : (entrants - 1 - rank) + 1 + (rank === 0 ? 2 : 0); }
function eloExpected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

// ── Achievement: calcolati dall'archivio, quindi retroattivi e sempre coerenti con le correzioni ──
// tiers: medaglia a livelli (n = traguardo, desc con {n}); fun: per ridere, fuori dai prossimi obiettivi; secret: "???" finché non la prendi
const ACHIEVEMENTS = [
  { id: 'first_win', emoji: '🏆', name: 'Prima vittoria', desc: 'Vinci un torneo' },
  { id: 'sweep', emoji: '🧹', name: 'Cappotto', desc: 'Vinci un torneo Swiss con tutti i match 2–0 (almeno 3)' },
  { id: 'comeback', emoji: '🔄', name: 'Rimonta', desc: 'Vinci un torneo dopo aver perso il primo round' },
  { id: 'phoenix', emoji: '🌅', name: 'Rinascita', desc: 'Vinci un torneo dopo essere arrivato ultimo in quello prima' },
  { id: 'fall', emoji: '🪂', name: 'Dalle stelle alle stalle', desc: 'Vinci un torneo e arriva ultimo in quello dopo', fun: true, secret: true },
  { id: 'davide', emoji: '🏹', name: 'Davide', desc: 'Vinci un torneo partendo con l\'Elo più basso del tavolo (almeno 4 giocatori)' },
  { id: 'triple', emoji: '🎩', name: 'Tripletta', desc: 'Vinci {n} tornei', tiers: [{ n: 3, name: 'Tripletta' }, { n: 5, name: 'Manita' }, { n: 10, name: 'Leggenda' }] },
  { id: 'double', emoji: '🔁', name: 'Bis', desc: 'Vinci due tornei di fila' },
  { id: 'streak3', emoji: '🔥', name: 'Filotto', desc: 'Sul podio in 3 tornei di fila' },
  { id: 'nailbiter', emoji: '💓', name: 'Al cardiopalma', desc: 'Vinci 3 match 2–1 nello stesso torneo' },
  { id: 'heartbreak', emoji: '💔', name: 'Crepacuore', desc: 'Perdi 3 match 1–2 nello stesso torneo', fun: true, secret: true },
  { id: 'unstoppable', emoji: '🚂', name: 'Inarrestabile', desc: 'Vinci 10 match di fila, anche in tornei diversi' },
  { id: 'second', emoji: '🥈', name: 'Eterno secondo', desc: 'Arriva 2° in 3 tornei' },
  { id: 'fourth', emoji: '🪵', name: 'Medaglia di legno', desc: 'Arriva 4° in 3 tornei, appena giù dal podio (almeno 5 giocatori)', fun: true },
  { id: 'wooden', emoji: '🥄', name: 'Cucchiaio di legno', desc: 'Arriva ultimo in un torneo', fun: true },
  { id: 'giant', emoji: '💥', name: 'Colpaccio', desc: 'Vinci {n} match da sfavorito (pronostico Elo sotto il 30%)', tiers: [{ n: 1, name: 'Colpaccio' }, { n: 3, name: 'Ammazzagiganti' }, { n: 5, name: 'Cacciatore di draghi' }] },
  { id: 'regicide', emoji: '🗡️', name: 'Regicida', desc: 'Batti il campione in carica (chi ha vinto il torneo prima)' },
  { id: 'exorcist', emoji: '😈', name: 'Esorcista', desc: 'Batti chi ti era in vantaggio negli scontri diretti (almeno 3 match)' },
  { id: 'revenge', emoji: '🔪', name: 'Vendetta', desc: 'Batti chi ti aveva battuto 3 volte di fila' },
  { id: 'climber', emoji: '🧗', name: 'Scalatore', desc: 'Guadagna almeno 50 punti Elo in un solo torneo' },
  { id: 'elo1700', emoji: '📈', name: 'Quota 1700', desc: 'Raggiungi 1700 punti Elo' },
  { id: 'purist', emoji: '💎', name: 'Purista', desc: 'Vinci un torneo con un mazzo monocolore' },
  { id: 'domain', emoji: '🌀', name: 'Domain', desc: 'Vinci un torneo con un mazzo di 3 o più colori' },
  { id: 'rainbow', emoji: '🌈', name: 'Pentacromatico', desc: 'Vinci almeno un match con un mazzo a 5 colori' },
  { id: 'greed', emoji: '🤡', name: 'Avidità', desc: 'Mazzo a 5 colori senza vincere neanche un match', fun: true, secret: true },
  { id: 'chameleon', emoji: '🦎', name: 'Camaleonte', desc: 'Vinci tornei con 3 combinazioni di colori diverse' },
  { id: 'palette', emoji: '🎨', name: 'Tavolozza', desc: 'Vinci almeno un match con ognuno dei 5 colori' },
  { id: 'monogamy', emoji: '🐑', name: 'Monogamo', desc: 'Gioca gli stessi colori in 3 tornei di fila' },
  { id: 'explorer', emoji: '📚', name: 'Esploratore', desc: 'Vinci tornei in 3 set o cube diversi' },
  { id: 'veteran', emoji: '🎖️', name: 'Veterano', desc: 'Gioca {n} tornei', tiers: [{ n: 10, name: 'Veterano' }, { n: 25, name: 'Habitué' }, { n: 50, name: 'Istituzione' }] },
  { id: 'tourist', emoji: '🧳', name: 'Turista', desc: 'Chiudi un torneo senza vincere un match (almeno 3 giocati)', fun: true, secret: true },
  { id: 'bye_king', emoji: '🎁', name: 'Re del bye', desc: 'Ricevi 3 bye', fun: true },
  { id: 'diplomat', emoji: '🤝', name: 'Diplomatico', desc: '5 patte intenzionali (ID)', fun: true },
  { id: 'snail', emoji: '🐌', name: 'Lumaca', desc: 'Finisci un match in pareggio a tempo scaduto (non un ID)', fun: true, secret: true },
  { id: 'ludo', emoji: '🎰', name: 'Ludopatico', desc: 'Si sa chi è', fun: true, secret: true },
];
const ACH = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
// Nome e descrizione del livello i (0 = primo) di una medaglia; per le medaglie senza livelli quelli fissi
function achTier(a, i) {
  if (!a.tiers) return { name: a.name, desc: a.desc };
  const t = a.tiers[Math.min(i, a.tiers.length - 1)];
  return { name: t.name, desc: a.desc.replace('{n}', t.n), n: t.n };
}

// ── Statistiche (cache invalidata a ogni saveLeague) ──
let _stats = null;
function emptyStat(id) {
  return {
    id, tournaments: 0, wins: 0, podiums: 0, finishes: [], mW: 0, mL: 0, mD: 0, gW: 0, gL: 0, gD: 0,
    byes: 0, ids: 0, elo: ELO_START, eloHistory: [], colors: {}, opponents: {}, achievements: {},
    seasonPoints: {}, podiumStreak: 0, lastDate: null, seconds: 0, fourths: 0, winSets: {},
    winStreak: 0, winCombos: {}, prevLast: false, prevWin: false, upsets: 0, lastCombo: null, comboStreak: 0,
  };
}
function leagueStats() {
  if (_stats) return _stats;
  const P = new Map();
  const stat = id => { if (!P.has(id)) P.set(id, emptyStat(id)); return P.get(id); };
  const unlock = (s, aid, t) => { if (!s.achievements[aid]) s.achievements[aid] = { date: t.date, tid: t.id }; };
  // Medaglie a livelli: level = quanti traguardi raggiunti, la data è quella dell'ultimo livello
  const unlockLevel = (s, aid, value, t) => {
    const level = ACH[aid].tiers.filter(x => value >= x.n).length, e = s.achievements[aid];
    if (level > (e ? e.level : 0)) s.achievements[aid] = { date: t.date, tid: t.id, level };
  };
  // Colori in ordine WUBRG: "UW" e "WU" sono la stessa combinazione
  const comboOf = deck => COLORS.filter(c => (deck || '').includes(c)).join('');
  const tournaments = sortedTournaments();
  let lastWinner = null, prevChampion = null;

  for (const t of tournaments) {
    const ids = t.entrants.map(canonicalId);
    const cid = id => canonicalId(id);
    const ranked = rankedIds(t).map(cid);
    const droppedSet = new Set((t.dropped || []).map(cid));
    const decks = {}; for (const [k, v] of Object.entries(t.decks || {})) decks[cid(k)] = v;
    const per = new Map(ids.map(id => [id, { mW: 0, mL: 0, mD: 0, gL: 0, played: 0, all20: true, lostR1: false, close: 0, closeL: 0 }]));
    // Elo a inizio torneo, per Davide
    const startElo = new Map(ranked.map(id => [id, stat(id).elo]));

    t.rounds.forEach((round, ri) => {
      for (const m of round) {
        if (m.rest) continue;
        if (m.bye) { const s = stat(cid(m.p1)); s.byes++; continue; }
        if (m.p1wins == null || m.p2 == null || m.forfeit) continue;
        const a = cid(m.p1), b = cid(m.p2); if (a === b) continue;
        const sa = stat(a), sb = stat(b), pa = per.get(a), pb = per.get(b);
        const ra = sa.elo, rb = sb.elo, ea = eloExpected(ra, rb);
        const res = m.p1wins > m.p2wins ? 1 : m.p1wins < m.p2wins ? 0 : 0.5;
        sa.elo = ra + ELO_K * (res - ea); sb.elo = rb + ELO_K * ((1 - res) - (1 - ea));
        // Colpaccio: stessa soglia del toast nel torneo (pronostico Elo sotto il 30%)
        if (res === 1 && ea < 0.3) unlockLevel(sa, 'giant', ++sa.upsets, t);
        if (res === 0 && 1 - ea < 0.3) unlockLevel(sb, 'giant', ++sb.upsets, t);
        if (prevChampion && res === 1 && b === prevChampion) unlock(sa, 'regicide', t);
        if (prevChampion && res === 0 && a === prevChampion) unlock(sb, 'regicide', t);
        for (const s of [sa, sb]) if (Math.round(s.elo) >= 1700) unlock(s, 'elo1700', t);
        const isID = m.p1wins === 0 && m.p2wins === 0 && m.draws > 0;
        if (isID) { sa.ids++; sb.ids++; }
        if (res === 0.5 && m.p1wins + m.p2wins > 0) { unlock(sa, 'snail', t); unlock(sb, 'snail', t); }
        sa.gW += m.p1wins; sa.gL += m.p2wins; sa.gD += m.draws; sb.gW += m.p2wins; sb.gL += m.p1wins; sb.gD += m.draws;
        for (const [s, p, opp, r, mine, theirs, col] of [[sa, pa, b, res, m.p1wins, m.p2wins, decks[a]], [sb, pb, a, 1 - res, m.p2wins, m.p1wins, decks[b]]]) {
          const o = s.opponents[opp] || (s.opponents[opp] = { w: 0, l: 0, d: 0, last: null, lossStreak: 0 });
          if (r === 1 && o.w + o.l + o.d >= 3 && o.l > o.w) unlock(s, 'exorcist', t);
          if (r === 1 && o.lossStreak >= 3) unlock(s, 'revenge', t);
          o.lossStreak = r === 0 ? o.lossStreak + 1 : 0;
          if (r === 1) { s.mW++; o.w++; } else if (r === 0) { s.mL++; o.l++; } else { s.mD++; o.d++; }
          // Serie di match vinti: la interrompono sconfitte e patte (bye e forfeit non contano, come per l'Elo)
          s.winStreak = r === 1 ? s.winStreak + 1 : 0;
          if (s.winStreak >= 10) unlock(s, 'unstoppable', t);
          o.last = { date: t.date, r };
          if (p) {
            p.played++; p.gL += theirs; if (r === 1) p.mW++; else if (r === 0) p.mL++; else p.mD++;
            if (!(r === 1 && mine === 2 && theirs === 0)) p.all20 = false;
            if (ri === 0 && r === 0) p.lostR1 = true;
            if (r === 1 && mine === 2 && theirs === 1) p.close++;
            if (r === 0 && mine === 1 && theirs === 2) p.closeL++;
          }
          for (const c of (col || '').split('')) {
            if (!COLORS.includes(c)) continue;
            const cs = s.colors[c] || (s.colors[c] = { decks: 0, mW: 0, mL: 0, mD: 0 });
            if (r === 1) cs.mW++; else if (r === 0) cs.mL++; else cs.mD++;
          }
        }
      }
    });

    const active = ranked.filter(x => !droppedSet.has(x)).length;
    ranked.forEach((id, rank) => {
      const s = stat(id), p = per.get(id) || { mW: 0, mL: 0, mD: 0, gL: 0, played: 0, all20: false, lostR1: false, close: 0, closeL: 0 };
      const dropped = droppedSet.has(id), N = ranked.length, combo = comboOf(decks[id]);
      s.tournaments++; s.lastDate = t.date;
      s.finishes.push({ tid: t.id, date: t.date, pos: rank + 1, of: N, dropped });
      s.seasonPoints[t.season] = (s.seasonPoints[t.season] || 0) + championshipPoints(rank, N, dropped);
      for (const c of new Set((decks[id] || '').split(''))) if (COLORS.includes(c)) (s.colors[c] || (s.colors[c] = { decks: 0, mW: 0, mL: 0, mD: 0 })).decks++;
      const podium = !dropped && rank < 3;
      if (podium) { s.podiums++; s.podiumStreak++; } else s.podiumStreak = 0;
      const prevElo = s.eloHistory.length ? s.eloHistory[s.eloHistory.length - 1].elo : ELO_START;
      if (s.elo - prevElo >= 50) unlock(s, 'climber', t);
      if (s.podiumStreak >= 3) unlock(s, 'streak3', t);
      if (!dropped && rank === 0) {
        s.wins++; unlock(s, 'first_win', t);
        if (t.mode === 'swiss' && p.played >= 3 && p.all20) unlock(s, 'sweep', t);
        if (p.lostR1) unlock(s, 'comeback', t);
        unlockLevel(s, 'triple', s.wins, t);
        if (prevChampion === id) unlock(s, 'double', t);
        if (s.prevLast) unlock(s, 'phoenix', t);
        // Davide: Elo di partenza più basso di tutti gli altri (a pari Elo, per esempio al primo torneo, non vale)
        if (N >= 4 && ranked.every(x => x === id || startElo.get(x) > startElo.get(id))) unlock(s, 'davide', t);
        if (combo.length === 1) unlock(s, 'purist', t);
        if (combo.length >= 3) unlock(s, 'domain', t);
        if (combo) { s.winCombos[combo] = true; if (Object.keys(s.winCombos).length >= 3) unlock(s, 'chameleon', t); }
        if (t.set && t.set.trim()) { s.winSets[t.set.trim().toLowerCase()] = true; if (Object.keys(s.winSets).length >= 3) unlock(s, 'explorer', t); }
      }
      if (!dropped && rank === 1 && ++s.seconds >= 3) unlock(s, 'second', t);
      // 4° con almeno 5 giocatori rimasti: con 4 il quarto è l'ultimo, e c'è già il cucchiaio
      if (!dropped && rank === 3 && active >= 5 && ++s.fourths >= 3) unlock(s, 'fourth', t);
      if (p.close >= 3) unlock(s, 'nailbiter', t);
      if (p.closeL >= 3) unlock(s, 'heartbreak', t);
      if (p.played >= 3 && p.mW === 0) unlock(s, 'tourist', t);
      if (combo.length === 5 && p.mW >= 1) unlock(s, 'rainbow', t);
      if (combo.length === 5 && p.played >= 2 && p.mW === 0) unlock(s, 'greed', t);
      if (COLORS.every(c => s.colors[c] && s.colors[c].mW > 0)) unlock(s, 'palette', t);
      // Monogamo: i tornei senza mazzo segnato non interrompono la serie
      if (combo) { s.comboStreak = combo === s.lastCombo ? s.comboStreak + 1 : 1; s.lastCombo = combo; if (s.comboStreak >= 3) unlock(s, 'monogamy', t); }
      const last = !dropped && N >= 4 && rank === active - 1;
      if (last) unlock(s, 'wooden', t);
      if (last && s.prevWin) unlock(s, 'fall', t);
      s.prevLast = last; s.prevWin = !dropped && rank === 0;
      unlockLevel(s, 'veteran', s.tournaments, t);
      if (s.ids >= 5) unlock(s, 'diplomat', t);
      if (s.byes >= 3) unlock(s, 'bye_king', t);
      if (/ludopatic/i.test(leagueName(id))) unlock(s, 'ludo', t);
      s.eloHistory.push({ tid: t.id, date: t.date, elo: s.elo });
    });
    if (ranked.length) lastWinner = ranked[0];
    // Per il Bis conta il vincitore vero: se il primo in classifica si è ritirato il torneo non ha campione
    prevChampion = ranked.length && !droppedSet.has(ranked[0]) ? ranked[0] : null;
  }

  for (const s of P.values()) {
    s.elo = Math.round(s.elo);
    const pos = s.finishes.filter(f => !f.dropped).map(f => f.pos);
    s.avgFinish = pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null;
    s.bestFinish = pos.length ? Math.min(...pos) : null;
    const mt = s.mW + s.mL + s.mD, gt = s.gW + s.gL + s.gD;
    s.matchWinPct = mt ? (s.mW + s.mD / 2) / mt : null;
    s.gameWinPct = gt ? (s.gW + s.gD / 2) / gt : null;
    // Nemesi: l'avversario con il peggior saldo (almeno 3 match); vittima preferita: il migliore
    const opps = Object.entries(s.opponents).map(([id, o]) => ({ id, ...o, n: o.w + o.l + o.d, net: o.w - o.l })).filter(o => o.n >= 3);
    s.nemesis = opps.filter(o => o.net < 0).sort((a, b) => a.net - b.net || b.n - a.n)[0] || null;
    s.victim = opps.filter(o => o.net > 0).sort((a, b) => b.net - a.net || b.n - a.n)[0] || null;
  }
  _stats = { players: P, lastWinner, tournaments };
  return _stats;
}
// ── Obiettivi: progresso verso le medaglie a conteggio non ancora sbloccate (o verso il livello successivo) ──
// [valore attuale, traguardo, unità, partenza] (l'Elo parte da ELO_START, non da zero); traguardo null = dai livelli
function achievementProgress(s) {
  const n = o => Object.keys(o).length;
  const goals = {
    triple: [s.wins, null, 'vittorie'],
    streak3: [s.podiumStreak, 3, 'podi di fila'],
    second: [s.seconds, 3, 'secondi posti'],
    unstoppable: [s.winStreak, 10, 'match vinti di fila'],
    giant: [s.upsets, null, 'colpacci'],
    elo1700: [s.elo, 1700, 'Elo', ELO_START],
    chameleon: [n(s.winCombos), 3, 'combinazioni vincenti'],
    palette: [COLORS.filter(c => s.colors[c] && s.colors[c].mW > 0).length, 5, 'colori'],
    monogamy: [s.comboStreak, 3, 'tornei di fila'],
    explorer: [n(s.winSets), 3, 'set vinti'],
    veteran: [s.tournaments, null, 'tornei'],
    fourth: [s.fourths, 3, 'quarti posti'],
    diplomat: [s.ids, 5, 'ID'],
    bye_king: [s.byes, 3, 'bye'],
  };
  const out = {};
  for (const [id, [cur, goal0, unit, from0 = 0]] of Object.entries(goals)) {
    const a = ACH[id], e = s.achievements[id];
    let goal = goal0, from = from0, tier = achTier(a, 0);
    if (a.tiers) {
      const level = e ? e.level : 0;
      if (level >= a.tiers.length) continue;
      tier = achTier(a, level); goal = tier.n; if (level) from = a.tiers[level - 1].n;
    } else if (e) continue;
    out[id] = { cur, goal, unit, name: tier.name, desc: tier.desc, ratio: Math.max(0, Math.min(1, (cur - from) / (goal - from))) };
  }
  return out;
}
// Le n medaglie più vicine (solo quelle già avviate e non per ridere), a parità nell'ordine di ACHIEVEMENTS
function nextGoals(s, n) {
  const p = achievementProgress(s);
  return ACHIEVEMENTS.filter(a => !a.fun && p[a.id] && p[a.id].ratio > 0).map(a => ({ a, ...p[a.id] })).sort((x, y) => y.ratio - x.ratio).slice(0, n);
}

function playerStats(id) { return leagueStats().players.get(canonicalId(id)) || emptyStat(canonicalId(id)); }
function currentElo(id) { return playerStats(id).elo; }

function championshipTable(season) {
  const { players } = leagueStats();
  return [...players.values()]
    .filter(s => s.seasonPoints[season] != null && resolvePlayer(s.id) && !resolvePlayer(s.id).deleted)
    .map(s => {
      const fin = s.finishes.filter(f => L.tournaments[f.tid] && L.tournaments[f.tid].season === season);
      return { id: s.id, points: s.seasonPoints[season], played: fin.length, wins: fin.filter(f => f.pos === 1 && !f.dropped).length, podiums: fin.filter(f => f.pos <= 3 && !f.dropped).length };
    })
    .sort((a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || a.played - b.played);
}
function eloTable() {
  const { players } = leagueStats();
  return [...players.values()].filter(s => resolvePlayer(s.id) && !resolvePlayer(s.id).deleted && s.tournaments > 0)
    .map(s => { const h = s.eloHistory; return { id: s.id, elo: s.elo, delta: h.length ? Math.round(h[h.length - 1].elo - (h.length > 1 ? h[h.length - 2].elo : ELO_START)) : 0, history: h, tournaments: s.tournaments }; })
    .sort((a, b) => b.elo - a.elo);
}
function headToHead(a, b) { const o = playerStats(a).opponents[canonicalId(b)]; return o ? { w: o.w, l: o.l, d: o.d, last: o.last } : { w: 0, l: 0, d: 0, last: null }; }

// Titoli mostrati accanto al nome durante i tornei
function leagueTitles(id) {
  if (!id) return '';
  const cid = canonicalId(id), st = leagueStats();
  let t = '';
  if (st.lastWinner && canonicalId(st.lastWinner) === cid) t += '👑';
  const champ = championshipTable(currentSeason());
  if (champ.length && champ[0].id === cid && champ[0].points > 0) t += '🩷';
  return t;
}
