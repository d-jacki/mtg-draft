// Test del torneo live e della lega predefinita (config.js): pubblicazione, lettura, Realtime,
// vista "Segui live", PIN (verifica, blocco anti forza bruta, schema vecchio), torneo gestito da più telefoni.
import { app, S, sandbox, storage, check, section, match, reset } from './harness.mjs';
import { LEAGUE, server, resetServer } from './mock-supabase.mjs';

section('Live e lega predefinita');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const connect = pin => app.configureSync({ url: 'https://demo.supabase.co', key: 'sb_publishable_abc', league: LEAGUE, pin, name: '' });
let tcount = 0;
function tournament() {
  reset(['Anna', 'Bruno', 'Carla', 'Dario', 'Elena']);
  S.T.id = 't_test' + (++tcount);
  S.T.totalRounds = 3; S.T.currentRound = 1; S.T.set = 'Duskmourn';
  S.T.rounds = [{ pairings: [match(1, 2, 2, 1), app.mkM(3, 4), { p1: 5, p2: null, p1wins: 2, p2wins: 0, draws: 0, bye: true, rest: false, forfeit: false }] }];
  S.TM.total = 50 * 60; S.TM.running = true; S.TM.startedAt = Date.now() - 60000; S.TM.seconds = 60;
}

// ── 1. Lega predefinita: collegati in sola lettura senza configurare niente ──
{
  resetServer();
  storage.delete('mtg-sync');
  sandbox.DEFAULT_LEAGUE = { url: 'https://demo.supabase.co', key: 'sb_publishable_abc', league: LEAGUE, name: '' };
  app.loadSyncCfg();
  check('lega predefinita: collegato in sola lettura al primo avvio', app.syncConfigured() && !app.syncCanWrite() && app.isDefaultLeague());
  app.disconnectSync(); app.loadSyncCfg();
  check('lega predefinita: dopo "Scollega" non si ricollega da sola', !app.syncConfigured());
  app.reconnectDefault();
  check('lega predefinita: "Ricollega" la ripristina', app.syncConfigured() && app.isDefaultLeague());
  delete sandbox.DEFAULT_LEAGUE;
}

// ── 2. PIN: verifica, blocco anti forza bruta, compatibilità con lo schema vecchio ──
{
  resetServer(); connect('');
  let err = null;
  try { await app.verifyPin('0000'); } catch (e) { err = e.message; }
  check('PIN: errato → "PIN non valido" (risposta {error} con HTTP 200)', err === 'PIN non valido');
  check('PIN: giusto → verificato senza scrivere documenti', await app.verifyPin('1234') === true && server.rows.size === 0);
  for (let i = 0; i < 10; i++) { try { await app.verifyPin('x' + i); } catch (e) { err = e.message; } }
  check('PIN: dopo 10 errori la lega blocca i tentativi', /Troppi PIN sbagliati/.test(err), err);
  resetServer(); server.legacy = true; connect('0000');
  app.createPlayer('Zeta'); app.saveLeague(true);
  const ok = await app.syncNow(false);
  check('PIN: con lo schema vecchio (HTTP 403) l\'errore resta leggibile', ok === false && S.syncState.error === 'PIN non valido');
  server.legacy = false;
}

// ── 3. Pubblicazione del torneo in corso ──
{
  resetServer(); connect('');
  tournament();
  check('live: senza PIN non pubblica', await app.livePublishNow(false) === false && !server.live);
  connect('1234');
  check('live: con PIN pubblica', await app.livePublishNow(false) === true);
  const d = server.live.data;
  check('live: stato completo (giocatori, round, set, dispositivo)',
    d.players.length === 5 && d.rounds[0].pairings.length === 3 && d.currentRound === 1 && d.set === 'Duskmourn' && d.device === app.deviceId());
  check('live: timer con inizio assoluto (chi segue calcola il tempo da sé)', d.timer.running === true && Math.abs(d.timer.startedAt - (Date.now() - 60000)) < 2000);
  app.setRes(0, 1, 0, 2, 0);
  await sleep(1000);
  check('live: save() ripubblica da solo dopo le modifiche', server.live.data.rounds[0].pairings[1].p2wins === 2);
  S.syncCfg.live = false; app.setRes(0, 0, 0, 2, 0);
  check('live: disattivato → non pubblica', await app.livePublishNow(false) === false && server.live.data.rounds[0].pairings[0].p1wins === 2);
  S.syncCfg.live = true;
  check('live: ogni pubblicazione incrementa la revisione', server.live.rev === 2);
  app.liveClearOnReset(); await sleep(50);
  const last = server.calls[server.calls.length - 1];
  check('live: "Nuovo torneo" toglie il torneo dal live (keepalive)', server.live.data === null && last.keepalive === true);
}

// ── 4. Chi segue: banner, vista, "Io sono", tempo ──
{
  tournament();
  const snap = { ...app.liveSnapshot(), id: 't_altro', device: 'd_altro' };
  S.live.updatedAt = 0; S.live.rev = 0;
  app.liveApply(snap, 100);
  check('segui: torneo di un altro telefono → banner visibile', app.liveVisible() && /Round 1\/3/.test(app.liveBannerHtml()));
  app.liveApply({ ...snap, id: S.T.id }, 101);
  check('segui: il torneo gestito da qui non mostra il banner', !app.liveVisible());
  app.liveApply({ ...snap, id: undefined, device: app.deviceId() }, 101);
  check('segui: stato vecchio senza id pubblicato da qui → niente banner', !app.liveVisible());
  app.liveApply({ ...snap, ended: true, publishedAt: Date.now() - 7 * 3600e3 }, 102);
  check('segui: torneo concluso da ore → banner nascosto', !app.liveVisible());
  app.liveApply(snap, 103);
  app.liveApply({ ...snap, currentRound: 9 }, 50);
  check('segui: aggiornamento più vecchio ignorato', S.live.data.currentRound === 1);

  // la vista usa il torneo live senza toccare quello locale
  reset(['Locale1', 'Locale2', 'Locale3', 'Locale4']);
  const before = S.T.players;
  app.setLiveMe('Carla');
  S.LUI.live = true;
  const html = app.renderLiveView();
  check('segui: classifica e pairing del torneo live', html.includes('Anna') && html.includes('T1') && html.includes('in corso'));
  check('segui: "Io sono" mostra il proprio tavolo e avversario', /Tavolo 2<\/span> contro <b>Dario<\/b>/.test(html), html.match(/live-mine">[^<]*<[^>]*>[^<]*/)?.[0]);
  check('segui: il torneo locale resta intatto', S.T.players === before && S.T.players[0].name === 'Locale1');
  app.setLiveMe('Elena');
  check('segui: bye riconosciuto', app.renderLiveView().includes('Hai il bye'));
  const t = app.liveTimerText({ ...snap, timer: { total: 3000, running: true, seconds: 0, startedAt: Date.now() - 60500 } });
  check('segui: timer calcolato dall\'inizio assoluto', t === '49:00', t);
  check('segui: timer in pausa', app.liveTimerText({ ...snap, timer: { total: 3000, running: false, seconds: 3060, startedAt: null } }) === '+01:00 ⏸');
  S.LUI.live = false;
}

// ── 5. Realtime e lettura ──
{
  tournament();
  const snap = { ...app.liveSnapshot(), id: 't_altro', device: 'd_altro' };
  S.live.updatedAt = 0; S.live.rev = 0; S.live.data = null;
  app.liveOnMessage({ topic: 'realtime:mtg-live', event: 'phx_reply', ref: '1', payload: { status: 'ok', response: {} } });
  check('realtime: iscrizione confermata', S.live.joined === true);
  app.liveOnMessage({ topic: 'realtime:mtg-live', event: 'postgres_changes', payload: { data: { type: 'UPDATE', record: { league_id: LEAGUE, data: snap, updated_at: 500 } } } });
  check('realtime: modifica ricevuta e applicata', S.live.data && S.live.data.device === 'd_altro');
  app.liveOnMessage({ topic: 'realtime:mtg-live', event: 'postgres_changes', payload: { data: { type: 'UPDATE', record: { league_id: LEAGUE, data: null, updated_at: 600 } } } });
  check('realtime: torneo chiuso → live vuoto', S.live.data === null);
  app.liveOnMessage({ topic: 'realtime:mtg-live', event: 'system', payload: { status: 'error', message: 'x' } });
  check('realtime: errore di sistema → si torna alla lettura periodica', S.live.joined === false);
  // la conferma d'iscrizione fa partire una lettura in background con lo stato della sezione 3 (timestamp più
  // recente): aspetto che finisca e riparto da zero, come un telefono appena aperto
  await sleep(20);
  resetServer(); server.live = { data: snap, updated_at: 700, rev: 1 };
  S.live.updatedAt = 0; S.live.rev = 0;
  connect('');
  await app.liveFetch();
  check('lettura: stato live scaricato dal server', S.live.data && S.live.data.set === 'Duskmourn', S.live.error);
  app.stopLive();
  check('stop: scollegando il live si svuota', S.live.data === null && !S.live.started);
}

// ── 6. Torneo gestito da più telefoni ──
section('Torneo condiviso');
{
  // L'altro telefono è simulato scrivendo direttamente sul server finto, come farebbe league_live_sync
  const remote = (fn, dev = 'd_altro') => {
    const d = JSON.parse(JSON.stringify(server.live.data));
    fn(d);
    d.device = dev; d.publishedAt = Date.now(); d.acks = { ...d.acks, [dev]: (d.acks[dev] || 0) + 1 };
    server.live = { data: d, rev: server.live.rev + 1, updated_at: server.live.updated_at + 1 };
  };
  const push = async () => { const r = await app.livePublishNow(false); await sleep(120); return r; };
  const toastText = () => sandbox.document.getElementById('toast').textContent;
  const liveRec = () => ({ topic: 'realtime:mtg-live', event: 'postgres_changes', payload: { data: { type: 'UPDATE', record: { league_id: LEAGUE, ...JSON.parse(JSON.stringify(server.live)) } } } });

  resetServer(); connect('1234'); S.syncCfg.live = true; S.live.rev = 0; S.live.updatedAt = 0; S.live.data = null;
  reset(['Anna', 'Bruno', 'Carla', 'Dario']);
  S.T.started = false; S.T.rounds = []; S.T.currentRound = 0;
  app.startWithMode('swiss', 3, 50);
  await push();
  const sh = app.liveSh();
  check('condiviso: torneo creato sul server con id e revisione', server.live.rev === 1 && server.live.data.id === S.T.id && sh.rev === 1 && sh.pending.length === 0);

  // Risultati su tavoli diversi nello stesso momento: restano entrambi
  remote(d => { const m = d.rounds[0].pairings[1]; m.p1wins = 2; m.p2wins = 0; });
  app.setRes(0, 0, 2, 1, 0);
  check('conflitto: la prima scrittura viene rifiutata', await app.livePublishNow(false) === false);
  await sleep(150);
  const pr = server.live.data.rounds[0].pairings;
  check('conflitto: dopo il riallineamento restano entrambi i risultati', pr[0].p1wins === 2 && pr[0].p2wins === 1 && pr[1].p1wins === 2 && pr[1].p2wins === 0, JSON.stringify(pr));
  check('conflitto: anche il torneo locale li ha entrambi', S.T.rounds[0].pairings[1].p1wins === 2 && S.T.rounds[0].pairings[0].p2wins === 1);
  check('conflitto: coda svuotata, revisione allineata', app.liveSh().pending.length === 0 && app.liveSh().rev === server.live.rev);

  // Due telefoni premono "Round successivo" insieme: vale il primo, il secondo prende i suoi pairing
  remote(d => { d.currentRound = 2; d.rounds.push({ locked: false, pairings: [app.mkM(1, 4), app.mkM(2, 3)] }); });
  const revBefore = server.live.rev;
  app.nextRound();
  check('round concorrente: in locale il round 2 è partito', S.T.currentRound === 2);
  await push();
  const r2 = S.T.rounds[1].pairings;
  check('round concorrente: niente doppio round', S.T.rounds.length === 2 && S.T.currentRound === 2);
  check('round concorrente: restano i pairing dell\'altro telefono', r2[0].p1 === 1 && r2[0].p2 === 4 && r2[1].p1 === 2 && r2[1].p2 === 3, JSON.stringify(r2));
  check('round concorrente: avviso all\'utente', /già generato/.test(toastText()), toastText());
  check('round concorrente: niente da riscrivere sul server', server.live.rev === revBefore && app.liveSh().pending.length === 0);

  // Aggiornamento in tempo reale da un altro telefono
  remote(d => { const m = d.rounds[1].pairings[0]; m.p1wins = 0; m.p2wins = 2; });
  app.liveOnMessage(liveRec());
  check('realtime: risultato di un altro telefono applicato al torneo locale', S.T.rounds[1].pairings[0].p2wins === 2 && app.liveSh().rev === server.live.rev);

  // Timer avviato da un altro telefono
  const started = Date.now() - 120000;
  remote(d => { d.timer = { total: 3000, running: true, seconds: 0, startedAt: started }; });
  app.liveOnMessage(liveRec());
  check('timer condiviso: parte anche qui dal momento giusto', S.TM.running === true && S.TM.startedAt === started && Math.abs(S.TM.seconds - 120) <= 1);
  app.pauseTimer(); await push();
  check('timer condiviso: la pausa arriva agli altri', server.live.data.timer.running === false && S.TM.interval === null);

  // Conferma persa: la scrittura è arrivata ma la risposta no. Nessuna operazione applicata due volte
  app.setRes(1, 1, 1, 1, 1);
  const sh2 = app.liveSh(), mine = app.liveSnapshot();
  server.live = { data: mine, rev: server.live.rev + 1, updated_at: server.live.updated_at + 1 };
  const revMine = server.live.rev;
  await push();
  check('conferma persa: si riconosce il proprio stato, niente riscrittura', server.live.rev === revMine && sh2.pending.length === 0 && sh2.rev === revMine);

  // Operazione non più valida: risultato su un round che un altro telefono ha annullato
  remote(d => { d.currentRound = 1; d.rounds.pop(); });
  app.editMatch(1, 0); sandbox.document.getElementById('modalConfirm').onclick();
  await push();
  check('undo concorrente: il risultato sul round annullato viene scartato', S.T.currentRound === 1 && S.T.rounds.length === 1 && /round è cambiato/.test(toastText()), toastText());

  // Chiusura "per tutti" solo se in diretta c'è ancora questo torneo
  check('altri telefoni: riconosciuti come co-gestori', app.liveOthersManaging() === true);
  const realId = S.T.id;
  await app.sbRpc('league_live_sync', { p_league: LEAGUE, p_pin: '1234', p_id: 't_non_mio', p_data: null, p_rev: null, p_updated_at: Date.now() });
  check('chiusura: non chiude il torneo di un altro', server.live.data && server.live.data.id === realId);

  // Un altro telefono avvia un torneo nuovo: questo continua solo qui
  remote(d => { d.id = 't_nuovo'; d.acks = {}; });
  app.liveOnMessage(liveRec());
  check('sostituito: il torneo locale si stacca dal live', app.liveSh().detached === true && S.T.id === realId && /nuovo torneo live/.test(toastText()), toastText());
  app.setRes(0, 0, 0, 2, 0);
  const revNew = server.live.rev;
  await push();
  check('sostituito: le modifiche locali non toccano il nuovo torneo', server.live.rev === revNew && server.live.data.id === 't_nuovo');
  const calls = server.calls.length;
  app.liveStop(); app.liveClearOnReset(); await sleep(20);
  check('staccato: "Disattiva live" e "Nuovo torneo" non chiudono il torneo degli altri', server.calls.length === calls && server.live.data.id === 't_nuovo');

  // Unirsi al torneo di un altro telefono
  S.live.rev = 0; await app.liveFetch();
  check('unisciti: il torneo dell\'altro è visibile con il banner', app.liveVisible());
  check('unisciti: pulsante nella vista live', app.renderLiveView().includes('liveJoin()'));
  app.liveJoin(); sandbox.document.getElementById('modalConfirm').onclick();
  check('unisciti: torneo locale sostituito da quello condiviso', S.T.id === 't_nuovo' && S.T.started && app.liveSh().rev === server.live.rev && !app.liveSh().detached);
  check('unisciti: il banner sparisce', !app.liveVisible());
  await push();
  check('unisciti: gli altri vedono il nuovo co-gestore', server.live.data.acks[app.deviceId()] === 1 && server.live.data.device === app.deviceId());
  app.setRes(0, 1, 2, 0, 0); await push();
  check('unisciti: i risultati inseriti da qui arrivano agli altri', server.live.data.rounds[0].pairings[1].p1wins === 2);

  // Fine torneo: archiviato con l'id del torneo, così due telefoni non creano due documenti
  S.T.rounds[0].pairings.forEach((m, i) => { if (m.p1wins == null) app.setRes(0, i, 2, 0, 0); });
  S.T.totalRounds = 1;
  app.endTournament(); await push();
  check('fine: archivio con l\'id del torneo condiviso', S.T.archivedId === 't_nuovo' && !!S.L.tournaments['t_nuovo']);
  check('fine: gli altri ricevono fine e archivio', server.live.data.ended === true && server.live.data.archivedId === 't_nuovo');

  // Avviare un torneo con un altro già in diretta chiede prima cosa fare
  remote(d => { d.id = 't_terzo'; d.acks = {}; d.ended = false; });
  app.liveOnMessage(liveRec());
  reset(['A', 'B', 'C', 'D']); S.T.started = false; S.T.rounds = []; S.T.currentRound = 0;
  sandbox.document.getElementById('modalTitle').textContent = '';
  app.handleStart();
  check('avvio: con un torneo live di un altro telefono chiede prima', sandbox.document.getElementById('modalTitle').textContent === 'Torneo già in corso' && S.T.started === false);
  app.closeModal();
}
