// Test degli strumenti master: PIN master, cronologia del torneo live e ripristino, correzione dei round chiusi,
// tornei eliminati.
import { app, S, sandbox, check, section, reset } from './harness.mjs';
import { LEAGUE, server, resetServer, setLive } from './mock-supabase.mjs';

section('Cronologia e PIN master');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const el = id => sandbox.document.getElementById(id);
const push = async () => { await app.livePublishNow(false); await sleep(80); };
const connect = pin => app.configureSync({ url: 'https://demo.supabase.co', key: 'sb_publishable_abc', league: LEAGUE, pin, name: '' });

resetServer(); server.master = '9999';
connect('1234'); S.syncCfg.live = true;
S.live.rev = 0; S.live.updatedAt = 0; S.live.data = null;
reset(['Anna', 'Bruno', 'Carla', 'Dario']);
S.T.started = false; S.T.rounds = []; S.T.currentRound = 0;
app.startWithMode('swiss', 3, 50); await push();
app.setRes(0, 0, 2, 0, 0); await push();
app.setRes(0, 1, 2, 1, 0); await push();
app.nextRound(); await push();
const tid = S.T.id;

// ── 1. La lega dice se ha un PIN master ──
{
  await app.syncNow(false);
  check('master: la lega ha un PIN master', S.syncCfg.hasMaster === true && app.masterRequired());
  check('master: senza sbloccarlo le operazioni delicate sono bloccate', !app.masterOn() && !app.canAdmin());
}

// ── 2. Cronologia: una versione per ogni pubblicazione, con descrizione ──
{
  check('cronologia: una versione per pubblicazione', server.history.length === 4, String(server.history.length));
  await app.openHistory(tid);
  const body = el('modalBody').innerHTML;
  check('cronologia: descrizioni leggibili', body.includes('Torneo avviato') && body.includes('R1 · Anna 2–0 Carla') && body.includes('Round 2 generato'), body.slice(0, 400));
  check('cronologia: la versione più recente è quella attuale', body.includes('Attuale'));
  check('cronologia: ripristino con lucchetto senza PIN master', body.includes('🔒 Ripristina'));
  await app.openHistory();
  check('cronologia: elenco dei tornei live recenti', el('modalBody').innerHTML.includes(`openHistory('${tid}')`) && el('modalBody').innerHTML.includes('Anna, Bruno, Carla, Dario'));
}

// ── 3. Ripristino: chiede il PIN master, poi riporta il torneo indietro per tutti ──
{
  const before = server.history.find(h => h.data.note === 'Round 2 generato').rev - 1;
  app.confirmRestore(tid, before);
  check('ripristino: senza master chiede il PIN master', el('modalTitle').textContent === 'PIN master');
  el('masterInp').value = '0000'; await app.saveMasterForm();
  check('ripristino: PIN master sbagliato rifiutato', !app.masterOn() && el('toast').textContent === 'PIN master errato');
  el('masterInp').value = '9999'; await app.saveMasterForm(); await sleep(30);
  check('ripristino: PIN master giusto sblocca e prosegue', app.masterOn() && el('modalTitle').textContent === 'Ripristinare questa versione?');
  el('modalConfirm').onclick(); await push();
  check('ripristino: torneo di nuovo al round 1 con i risultati', S.T.currentRound === 1 && S.T.rounds.length === 1 && S.T.rounds[0].pairings[1].p1wins === 2);
  check('ripristino: arriva agli altri telefoni come nuova versione', server.live.data.currentRound === 1 && /^Ripristinata la versione delle/.test(server.live.data.note), server.live.data.note);
  check('ripristino: la versione annullata resta in cronologia', server.history.some(h => h.data.note === 'Round 2 generato'));
}

// ── 4. Correzione di un round chiuso (solo in modalità master) ──
{
  app.nextRound(); await push();
  S.viewingRound = 1; app.renderRound();
  check('round chiuso: in master i risultati si possono modificare', el('roundContent').innerHTML.includes('editMatch(0,0)'));
  app.exitMaster(); S.viewingRound = 1; app.renderRound();
  check('round chiuso: senza master restano bloccati', !el('roundContent').innerHTML.includes('editMatch(0,0)'));
  const r2 = JSON.stringify(S.T.rounds[1].pairings);
  app.setRes(0, 0, 0, 2, 0); await push();
  check('round chiuso: correzione applicata e condivisa, round successivo intatto',
    S.T.rounds[0].pairings[0].p2wins === 2 && server.live.data.rounds[0].pairings[0].p2wins === 2 && JSON.stringify(S.T.rounds[1].pairings) === r2);
  check('round chiuso: marcata come correzione in cronologia', /\(correzione\)/.test(server.live.data.note), server.live.data.note);
  check('round chiuso: senza "force" l\'operazione non passa', app.applyOp({ t: 'res', r: 0, m: 1, p1: S.T.rounds[0].pairings[1].p1, p2: S.T.rounds[0].pairings[1].p2, w1: 0, w2: 2, d: 0 }) === false);
}

// ── 5. Recupero di un torneo sostituito da un altro telefono ──
{
  const d = { ...JSON.parse(JSON.stringify(server.live.data)), id: 't_altro', device: 'd_altro', acks: {} };
  setLive({ data: d, rev: server.live.rev + 1, updated_at: server.live.updated_at + 1 });
  app.liveOnMessage({ topic: 'realtime:mtg-live', event: 'postgres_changes', payload: { data: { type: 'UPDATE', record: { league_id: LEAGUE, ...JSON.parse(JSON.stringify(server.live)) } } } });
  check('recupero: il torneo sostituito continua solo qui', app.liveSh().detached === true && S.T.id === tid);
  const last = server.history.filter(h => h.data.id === tid).sort((a, b) => b.rev - a.rev)[0];
  el('masterInp').value = '9999'; app.openMasterForm(); await app.saveMasterForm();
  app.confirmRestore(tid, last.rev); await sleep(30);
  check('recupero: avvisa che il torneo in diretta verrà sostituito', /verrà sostituito/.test(el('modalText').textContent), el('modalText').textContent);
  el('modalConfirm').onclick(); await push();
  check('recupero: il torneo torna in diretta', server.live.data.id === tid && !app.liveSh().detached && app.liveSh().rev === server.live.rev);
}

// ── 6. Tornei eliminati ──
{
  S.L.tournaments.t_del1 = { id: 't_del1', date: '2026-09-01', season: '2026', set: 'MH3', mode: 'swiss', totalRounds: 3, entrants: ['p_z'], names: { p_z: 'Zed' }, final: ['p_z'], dropped: [], rounds: [], decks: {}, deleted: true, updatedAt: 1 };
  app.openDeletedTournaments();
  check('eliminati: elenco con vincitore', el('modalBody').innerHTML.includes('vinto da Zed') && el('modalBody').innerHTML.includes("restoreTournament('t_del1')"));
  app.restoreTournament('t_del1');
  check('eliminati: ripristinato in master', S.L.tournaments.t_del1.deleted === false);
  app.exitMaster();
  app.confirmDeleteTournament('t_del1');
  check('eliminare un torneo richiede il PIN master', el('modalTitle').textContent === 'PIN master');
  app.closeModal();
}

// ── 6b. Eliminazione definitiva (tombstone ridotto + cronologia live sul server) ──
{
  S.L.tournaments.t_del1.deleted = true; S.L.tournaments.t_del1.updatedAt = 5;
  S.L.dirty.push('t_del1'); await app.syncNow(false);
  // Il torneo aveva versioni nella cronologia live ed è ancora quello mostrato in diretta
  setLive({ data: { ...JSON.parse(JSON.stringify(server.live.data)), id: 't_del1', ended: true }, rev: server.live.rev + 1, updated_at: server.live.updated_at + 1 });
  const otherHist = server.history.filter(h => h.data.id !== 't_del1').length;
  app.confirmPurgeTournament('t_del1');
  check('eliminazione definitiva: senza master chiede il PIN master', el('modalTitle').textContent === 'PIN master');
  el('masterInp').value = '9999'; await app.saveMasterForm();
  check('eliminazione definitiva: chiede conferma', el('modalTitle').textContent === 'Eliminare per sempre?');
  el('modalConfirm').onclick(); await sleep(60);
  const t = S.L.tournaments.t_del1, row = server.rows.get('t_del1');
  check('eliminazione definitiva: resta solo un tombstone ridotto', t.purged === true && t.deleted === true && !t.names && t.entrants.length === 0 && t.rounds.length === 0);
  check('eliminazione definitiva: il tombstone arriva sul server', row && row.data.purged === true && !row.data.names);
  check('eliminazione definitiva: sparisce dagli eliminati', app.deletedTournaments().every(x => x.id !== 't_del1'));
  check('eliminazione definitiva: via dalla cronologia live, le altre restano', server.history.every(h => h.data.id !== 't_del1') && server.history.length === otherHist);
  check('eliminazione definitiva: chiuso anche il live che lo mostrava', server.live.data === null);
  app.restoreTournament('t_del1');
  check('eliminazione definitiva: non si ripristina più', S.L.tournaments.t_del1.deleted === true);
  const valid = app.mergeLeagueDocs([{ kind: 'tournament', data: { ...row.data, updatedAt: row.data.updatedAt + 1 } }], false);
  check('eliminazione definitiva: il tombstone passa la validazione del sync', valid === 1);
  // Schema non ancora aggiornato: il torneo si elimina comunque dalla lega e l'app lo dice
  S.L.tournaments.t_del2 = { ...JSON.parse(JSON.stringify(S.L.tournaments.t_del1)), id: 't_del2', purged: undefined, entrants: ['p_z'], final: ['p_z'], updatedAt: 1 };
  server.noPurge = true;
  await app.purgeTournamentEverywhere('t_del2');
  check('schema vecchio: eliminato comunque dalla lega', S.L.tournaments.t_del2.purged === true);
  check('schema vecchio: avvisa di rilanciare schema.sql', /schema\.sql/.test(el('toast').textContent), el('toast').textContent);
  server.noPurge = false;
  app.exitMaster();
}

// ── 7. Lega senza PIN master: tutto come prima ──
{
  server.master = null; await app.syncNow(false);
  check('senza PIN master: operazioni libere per chi ha il PIN', S.syncCfg.hasMaster === false && app.canAdmin());
  app.confirmDeleteTournament('t_del1');
  check('senza PIN master: eliminazione chiede solo conferma', el('modalTitle').textContent === 'Eliminare il torneo?');
  app.closeModal();
  server.master = '9999'; S.syncCfg.adminPin = '9999';
  app.confirmRemovePin(); el('modalConfirm').onclick();
  check('togliendo il PIN si esce anche dalla modalità master', !app.masterOn() && !S.syncCfg.pin);
}
