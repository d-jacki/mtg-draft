// Test del torneo live e della lega predefinita (config.js): pubblicazione, lettura, Realtime,
// vista "Segui live", PIN (verifica, blocco anti forza bruta, schema vecchio).
import { app, S, sandbox, storage, check, section, match, reset } from './harness.mjs';
import { LEAGUE, server, resetServer } from './mock-supabase.mjs';

section('Live e lega predefinita');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const connect = pin => app.configureSync({ url: 'https://demo.supabase.co', key: 'sb_publishable_abc', league: LEAGUE, pin, name: '' });
function tournament() {
  reset(['Anna', 'Bruno', 'Carla', 'Dario', 'Elena']);
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
  S.T.rounds[0].pairings[1].p1wins = 0; S.T.rounds[0].pairings[1].p2wins = 2;
  app.save();
  await sleep(1000);
  check('live: save() ripubblica da solo dopo le modifiche', server.live.data.rounds[0].pairings[1].p2wins === 2);
  S.syncCfg.live = false; S.T.rounds[0].pairings[0].p1wins = 0;
  check('live: disattivato → non pubblica', await app.livePublishNow(false) === false && server.live.data.rounds[0].pairings[0].p1wins === 2);
  S.syncCfg.live = true;
  app.liveClearOnReset(); await sleep(50);
  const last = server.calls[server.calls.length - 1];
  check('live: "Nuovo torneo" toglie il torneo dal live (keepalive)', server.live.data === null && last.keepalive === true);
}

// ── 4. Chi segue: banner, vista, "Io sono", tempo ──
{
  tournament();
  const snap = { ...app.liveSnapshot(), device: 'd_altro' };
  S.live.updatedAt = 0;
  app.liveApply(snap, 100);
  check('segui: torneo di un altro telefono → banner visibile', app.liveVisible() && /Round 1\/3/.test(app.liveBannerHtml()));
  app.liveApply({ ...snap, device: app.deviceId() }, 101);
  check('segui: il proprio torneo non mostra il banner', !app.liveVisible());
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
  const snap = { ...app.liveSnapshot(), device: 'd_altro' };
  S.live.updatedAt = 0; S.live.data = null;
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
  resetServer(); server.live = { data: snap, updated_at: 700 };
  S.live.updatedAt = 0;
  connect('');
  await app.liveFetch();
  check('lettura: stato live scaricato dal server', S.live.data && S.live.data.set === 'Duskmourn', S.live.error);
  app.stopLive();
  check('stop: scollegando il live si svuota', S.live.data === null && !S.live.started);
}
