// Test della lega: archivio, anagrafica, campionato, Elo, scontri diretti, achievement, import/export,
// agganci nel torneo e rendering delle viste (smoke test).
import { app, S, sandbox, check, section, match, reset } from './harness.mjs';

section('Lega');

let seq = 0;
function resetLeague() {
  S.L.players = {}; S.L.tournaments = {}; S.L.dirty = [];
  app.saveLeague(true);
}
function players(...names) { return names.map(n => app.createPlayer(n).id); }
// Torneo archiviato costruito a mano: rounds = [[ [a, b, w1, w2, d?], ... ], ...], a/b id di lega (b null = bye)
function archived(date, entrants, final, rounds, extra = {}) {
  const t = {
    id: `t_test${++seq}`, date, season: date.slice(0, 4), set: '', mode: 'swiss', totalRounds: rounds.length,
    createdAt: seq, entrants, names: {}, dropped: [], final, decks: {},
    rounds: rounds.map(r => r.map(([p1, p2, w1, w2, d = 0]) => p2 == null
      ? { p1, p2: null, p1wins: 2, p2wins: 0, draws: 0, bye: true, rest: false, forfeit: false }
      : { p1, p2, p1wins: w1, p2wins: w2, draws: d, bye: false, rest: false, forfeit: false })),
    ...extra,
  };
  S.L.tournaments[t.id] = app.touch(t);
  app.saveLeague(true);
  return t;
}

// ── 1. Fine torneo → archivio, anagrafica creata, niente doppioni ──
{
  resetLeague();
  reset(['Anna', 'Bruno', 'Carla', 'Dario']);
  S.T.rounds = [
    { pairings: [match(1, 2, 2, 0), match(3, 4, 2, 1)] },
    { pairings: [match(1, 3, 2, 1), match(2, 4, 2, 0)] },
  ];
  S.T.ended = true; S.T.archivedId = null; S.T.set = 'Duskmourn'; S.T.decks = { 1: 'WU', 3: 'BR' };
  check('archivio: torneo concluso salvato', app.archiveCurrent() === true && Object.keys(S.L.tournaments).length === 1);
  const t = Object.values(S.L.tournaments)[0];
  check('archivio: giocatori creati in anagrafica', app.leaguePlayers().length === 4 && S.T.players.every(p => p.leagueId));
  check('archivio: classifica finale, set e mazzi salvati',
    app.leagueName(t.final[0]) === 'Anna' && t.set === 'Duskmourn' && t.decks[S.T.players[0].leagueId] === 'WU');
  check('archivio: seconda chiamata non duplica', app.archiveCurrent() === false && Object.keys(S.L.tournaments).length === 1);
  check('archivio: documenti in coda per il sync', S.L.dirty.length === 5);
}

// ── 2. Nome scritto a mano collegato all'anagrafica (maiuscole indifferenti) ──
{
  S.T.players = []; S.T.draftOrder = []; S.T.rounds = []; S.T.started = false; S.T.ended = false; S.playerIdCounter = 0;
  sandbox.document.getElementById('playerInput').value = 'anna';
  app.addPlayer();
  const p = S.T.players[0];
  check('setup: nome esistente collegato al profilo con il nome canonico', p.name === 'Anna' && p.leagueId === app.findPlayerByName('Anna').id);
  const bruno = app.findPlayerByName('Bruno');
  app.addRosterPlayer(bruno.id); app.addRosterPlayer(bruno.id);
  check('setup: giocatore abituale aggiunto una volta sola', S.T.players.filter(x => x.leagueId === bruno.id).length === 1);
}

// ── 3. Campionato: punti per piazzamento ──
{
  resetLeague();
  const [a, b, c, d] = players('A', 'B', 'C', 'D');
  archived('2026-03-01', [a, b, c, d], [a, b, c, d], [[[a, b, 2, 0], [c, d, 2, 0]], [[a, c, 2, 1], [b, d, 2, 1]]]);
  archived('2026-04-01', [a, b, c, d], [b, a, d, c], [[[b, a, 2, 0], [d, c, 2, 0]]], { dropped: [c] });
  const tab = app.championshipTable('2026');
  const pts = Object.fromEntries(tab.map(r => [app.leagueName(r.id), r.points]));
  // T1: A 3+1+2=6, B 3, C 2, D 1 — T2 (C ritirato in fondo): B 6, A 3, D 2, C 1
  check('campionato: punti per piazzamento (+presenza, +2 al vincitore, ritirato = 1)',
    pts.A === 9 && pts.B === 9 && pts.C === 3 && pts.D === 3, JSON.stringify(pts));
  check('campionato: a pari punti conta chi ha più vittorie, poi i podi', tab[0].points === tab[1].points && tab[0].wins === 1);
  check('campionato: filtro per stagione', app.championshipTable('2025').length === 0);
}

// ── 4. Elo: somma zero, chi vince sale, bye e forfeit non contano ──
{
  resetLeague();
  const [a, b, c, d] = players('A', 'B', 'C', 'D');
  archived('2026-03-01', [a, b, c, d], [a, c, b, d], [[[a, b, 2, 0], [c, d, 2, 1]], [[a, c, 2, 0], [d, null]]]);
  const e = [a, b, c, d].map(id => app.playerStats(id).elo);
  check('Elo: somma invariata (4×1500)', Math.abs(e.reduce((x, y) => x + y, 0) - 6000) <= 2, e.join(','));
  // A: +16, +16 · C: +16 poi −16 contro A (stesso rating) · B: −16
  check('Elo: chi vince tutto sale, chi perde scende, 1-1 a pari rating torna in pari', e[0] === 1532 && e[2] === 1500 && e[1] === 1484, e.join(','));
  const t2 = archived('2026-03-08', [a, b], [a, b], [[[a, b, 2, 0]]]);
  t2.rounds[0][0].forfeit = true; app.saveLeague(true);
  check('Elo: il forfeit non sposta il rating', app.playerStats(a).elo === e[0]);
  check('bye: contato nelle statistiche', app.playerStats(d).byes === 1);
}

// ── 5. Scontri diretti, nemesi e vittima ──
{
  resetLeague();
  const [a, b, c] = players('A', 'B', 'C');
  for (let i = 0; i < 3; i++) archived(`2026-05-0${i + 1}`, [a, b, c], [b, c, a], [[[a, b, 0, 2], [c, null]], [[a, c, 2, 1], [b, null]]]);
  const h = app.headToHead(a, b), s = app.playerStats(a);
  check('H2H: record dal punto di vista del primo', h.w === 0 && h.l === 3 && app.headToHead(b, a).w === 3);
  check('rivalità: nemesi = chi ti batte di più (min 3 match)', s.nemesis && s.nemesis.id === b);
  check('rivalità: vittima preferita = chi batti di più', s.victim && s.victim.id === c);
}

// ── 6. Unione profili doppi ──
{
  resetLeague();
  const [m1, m2, x] = players('Marco', 'Marco R.', 'X');
  archived('2026-06-01', [m1, x], [m1, x], [[[m1, x, 2, 0]]]);
  archived('2026-06-08', [m2, x], [m2, x], [[[m2, x, 2, 1]]]);
  app.mergePlayers(m2, m1);
  const s = app.playerStats(m1);
  check('unione: tornei e vittorie sommati sul profilo che resta', s.tournaments === 2 && s.wins === 2 && s.mW === 2);
  check('unione: il doppione sparisce dalla lista', app.leaguePlayers().length === 2 && app.canonicalId(m2) === m1);
  check('unione: non si unisce un profilo a se stesso', app.mergePlayers(m1, m2) === false);
}

// ── 7. Achievement ──
{
  resetLeague();
  const [a, b, c, d, f] = players('A', 'B', 'C', 'D', 'Ferro il Ludopatico');
  // A perde il R1 ma vince il torneo (rimonta); D ultimo (cucchiaio)
  archived('2026-07-01', [a, b, c, d], [a, b, c, d], [[[b, a, 2, 1], [c, d, 2, 0]], [[a, c, 2, 0], [b, d, 2, 0]], [[a, d, 2, 0], [b, c, 1, 2]]]);
  // B vince 3-0 tutto 2-0 (cappotto + imbattuto)
  archived('2026-07-08', [a, b, c, f], [b, a, c, f], [[[b, a, 2, 0], [c, f, 2, 1]], [[b, c, 2, 0], [a, f, 2, 0]], [[b, f, 2, 0], [a, c, 2, 1]]]);
  const has = (id, ach) => !!app.playerStats(id).achievements[ach];
  check('achievement: rimonta per chi vince dopo aver perso il R1', has(a, 'comeback') && has(a, 'first_win') && !has(a, 'undefeated'));
  check('achievement: imbattuto e cappotto', has(b, 'undefeated') && has(b, 'sweep'));
  check('achievement: cucchiaio di legno all\'ultimo', has(d, 'wooden') && !has(c, 'wooden'));
  check('achievement: Ludopatico', has(f, 'ludo'));
  check('titoli: 👑 al vincitore dell\'ultimo torneo', app.leagueTitles(b).includes('👑') && !app.leagueTitles(a).includes('👑'));
}

// ── 8. Torneo eliminato: esce dalle statistiche ──
{
  resetLeague();
  const [a, b] = players('A', 'B');
  const t = archived('2026-08-01', [a, b], [a, b], [[[a, b, 2, 0]]]);
  app.deleteTournament(t.id);
  check('eliminazione: tombstone e statistiche ricalcolate', S.L.tournaments[t.id].deleted === true && app.playerStats(a).tournaments === 0);
}

// ── 9. Merge documenti (sync/import): vince il più recente ──
{
  resetLeague();
  const [a] = players('Anna');
  const local = S.L.players[a];
  app.mergeLeagueDocs([{ kind: 'player', data: { ...local, name: 'Vecchia', updatedAt: local.updatedAt - 10 } }], false);
  check('LWW: documento più vecchio ignorato', S.L.players[a].name === 'Anna');
  app.mergeLeagueDocs([{ kind: 'player', data: { ...local, name: 'Anna B.', updatedAt: local.updatedAt + 10 } }], false);
  check('LWW: documento più recente applicato', S.L.players[a].name === 'Anna B.');
}

// ── 10. Export → import ──
{
  resetLeague();
  const [a, b] = players('A', 'B');
  archived('2026-09-01', [a, b], [a, b], [[[a, b, 2, 1]]]);
  const json = JSON.stringify({ format: 'mtg-draft-league', version: 1, players: S.L.players, tournaments: S.L.tournaments });
  resetLeague();
  const n = app.importLeagueText(json);
  check('import: giocatori e tornei ripristinati', n === 3 && app.playerStats(a).wins === 1);
  check('import: segnati per il sync', S.L.dirty.length === 3);
  let threw = false; try { app.importLeagueText('{"foo":1}'); } catch { threw = true; }
  check('import: file non valido rifiutato', threw);
}

// ── 11. Colori del mazzo e statistiche per colore ──
{
  resetLeague();
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [{ pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0)] }];
  S.T.decks = {}; S.T.ended = true; S.T.archivedId = null;
  app.toggleDeckColor(1, 'U'); app.toggleDeckColor(1, 'W'); app.toggleDeckColor(1, 'U'); app.toggleDeckColor(1, 'U');
  check('mazzo: colori in ordine WUBRG, toggle on/off', S.T.decks[1] === 'WU');
  app.archiveCurrent();
  app.toggleDeckColor(1, 'B');
  const lid = S.T.players[0].leagueId, t = S.L.tournaments[S.T.archivedId];
  check('mazzo: modifica dopo l\'archivio aggiornata anche nello storico', t.decks[lid] === 'WUB');
  const col = app.playerStats(lid).colors;
  check('statistiche colore: mazzi e match vinti', col.W.decks === 1 && col.B.mW === 1 && !col.R);
}

// ── 12. Colpaccio: vince lo sfavorito secondo l'Elo ──
{
  resetLeague();
  const [a, b, c, d] = players('Forte', 'Debole', 'C', 'D');
  for (let i = 1; i <= 9; i++) archived(`2026-01-0${i}`, [a, b, c, d], [a, c, d, b], [[[a, b, 2, 0], [c, d, 2, 0]], [[a, c, 2, 0], [d, b, 2, 0]], [[a, d, 2, 0], [c, b, 2, 0]]]);
  reset(['Forte', 'Debole', 'C', 'D']);
  S.T.players.forEach(p => { p.leagueId = app.findPlayerByName(p.name).id; });
  check('colpaccio: lo sfavorito che vince fa scattare l\'upset', app.checkUpset(match(1, 2, 0, 2)) === true);
  check('colpaccio: il favorito che vince no', app.checkUpset(match(1, 2, 2, 0)) === false);
  check('annuncio: precedenti e pronostico', /Precedenti 9–0 · pronostico \d+%–\d+%/.test(app.rivalryHtml(S.T.players[0], S.T.players[1])));
}

// ── 13. Smoke test del rendering di tutte le viste ──
{
  let err = null;
  try {
    for (const v of ['champ', 'elo', 'history', 'h2h', 'players']) { app.setLeagueView(v); }
    const id = app.leaguePlayers()[0].id;
    app.openProfile(id); app.closeProfile();
    app.openTournament(Object.keys(S.L.tournaments)[0]);
    app.renderRosterChips(); app.renderStandings(); app.openAnnounce();
  } catch (e) { err = e; }
  check('rendering: tutte le viste della lega senza eccezioni', !err, err && err.stack);
}
