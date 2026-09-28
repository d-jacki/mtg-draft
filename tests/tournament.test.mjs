// Test del torneo: tiebreaker MTR, pairing, bye, drop, ID, round robin, tavolo, UX.
import { app, S, sandbox, winListeners, check, section, approx, match, byeMatch, reset } from './harness.mjs';

section('Torneo');

// ── 1. esc() escapa anche le virgolette (iniezione attributi) ──
{
  const out = app.esc(`a<b>&"c"'d'`);
  check('esc: < > & " \' tutti escapati',
    out === 'a&lt;b&gt;&amp;&quot;c&quot;&#39;d&#39;', `got: ${out}`);
}

// ── 2. Scenario 3 audit: R1 2-0, R2 ID, R3 0-2 → GW% = 7/15 (Option A) ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [
    { pairings: [match(1, 2, 2, 0)] },
    { pairings: [match(1, 3, 0, 0, 1)] },
    { pairings: [match(1, 4, 0, 2)] },
  ];
  const r = app.getPlayerRecord(1);
  check('scenario 3: record 1-1-1', r.wins === 1 && r.losses === 1 && r.draws === 1);
  check('scenario 3: match points = 4', app.matchPoints(1) === 4);
  check('scenario 3: GW% = 7/15 ≈ 46.67%', approx(app.gwp(1), 7 / 15), `got ${app.gwp(1)}`);
  check('scenario 3: ID conta come round giocato (MWP su 3 round)', approx(app.mwp(1), 4 / 9), `got ${app.mwp(1)}`);
}

// ── 3. Bye = 2-0 (3 MP, 6 GP), escluso dagli avversari (MTR Appendix C) ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [{ pairings: [byeMatch(1), match(2, 3, 2, 1)] }];
  const r = app.getPlayerRecord(1);
  check('bye: vittoria 2-0, 3 match points', r.wins === 1 && r.gameWins === 2 && app.matchPoints(1) === 3);
  check('bye: conta nel proprio MWP (=1.0)', approx(app.mwp(1), 1));
  check('bye: conta nel proprio GW% (=1.0)', approx(app.gwp(1), 1));
  check('bye: nessun avversario registrato', r.opponents.length === 0);
  check('bye: OMW% floor 0.33 senza avversari', approx(app.omw(1), 0.33));
}

// ── 4. Floor 0.33 su MWP e GW% ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [
    { pairings: [match(1, 2, 0, 2)] },
    { pairings: [match(1, 3, 0, 2)] },
    { pairings: [match(1, 4, 0, 2)] },
  ];
  check('floor: MWP min 0.33 per 0-3', approx(app.mwp(1), 0.33));
  check('floor: GW% min 0.33 per 0-6 games', approx(app.gwp(1), 0.33));
}

// ── 5. Ordine standings: MP → OMW% → GW% → OGW% ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [
    { pairings: [match(1, 2, 2, 0), match(3, 4, 2, 1)] }, // A>B, C>D
    { pairings: [match(1, 3, 2, 0), match(2, 4, 2, 0)] }, // A>C, B>D
  ];
  const st = app.getSwissStandings().map(p => p.name);
  // B e C hanno 3 MP e stesso OMW% (entrambi hanno giocato A e D); B vince sul GW% (0.50 vs 0.40)
  check('standings: A(6) > B(3, GW 50%) > C(3, GW 40%) > D(0)',
    JSON.stringify(st) === JSON.stringify(['A', 'B', 'C', 'D']), st.join(','));
}

// ── 6. H2H circolare (A>B>C>A): tiebreaker identici, ordine di inserimento stabile ──
{
  reset(['A', 'B', 'C'], 'roundrobin');
  S.T.rounds = [
    { pairings: [match(1, 2, 1, 0)] },
    { pairings: [match(2, 3, 1, 0)] },
    { pairings: [match(3, 1, 1, 0)] },
  ];
  const st = app.getSwissStandings().map(p => p.name);
  check('H2H circolare: ordine stabile A,B,C', JSON.stringify(st) === JSON.stringify(['A', 'B', 'C']), st.join(','));
}

// ── 7. Pairing Swiss R2: niente rematch, stessi bracket ──
{
  for (let trial = 0; trial < 20; trial++) {
    reset(['A', 'B', 'C', 'D']);
    S.T.rounds = [{ pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0)] }];
    S.T.currentRound = 2;
    const pairs = app.generateSwiss();
    const rematch = pairs.some(m => app.havePlayed(m.p1, m.p2));
    const crossBracket = pairs.some(m => app.matchPoints(m.p1) !== app.matchPoints(m.p2));
    if (rematch || crossBracket) {
      check('pairing R2: no rematch, bracket rispettati (20 estrazioni)', false,
        `trial ${trial}: rematch=${rematch} crossBracket=${crossBracket}`);
      break;
    }
    if (trial === 19) check('pairing R2: no rematch, bracket rispettati (20 estrazioni)', true);
  }
}

// ── 8. Bye a rotazione: chi l'ha già avuto non lo riceve ──
{
  for (let trial = 0; trial < 20; trial++) {
    reset(['A', 'B', 'C', 'D', 'E']);
    S.T.rounds = [{ pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0), byeMatch(5)] }];
    S.T.currentRound = 2;
    const pairs = app.generateSwiss();
    const bye = pairs.find(m => m.bye);
    if (!bye || bye.p1 === 5) {
      check('bye R2: mai due volte allo stesso giocatore (20 estrazioni)', false, `bye a ${bye && bye.p1}`);
      break;
    }
    if (trial === 19) check('bye R2: mai due volte allo stesso giocatore (20 estrazioni)', true);
  }
}

// ── 9. Round robin 5 giocatori: schedule completo ──
{
  reset(['A', 'B', 'C', 'D', 'E'], 'roundrobin');
  app.generateAllRRRounds();
  const rounds = S.T.rounds;
  check('RR: 5 round', rounds.length === 5);
  const rests = {};
  const seen = new Set();
  let ok = true;
  for (const r of rounds) {
    const real = r.pairings.filter(m => !m.rest), rest = r.pairings.filter(m => m.rest);
    if (real.length !== 2 || rest.length !== 1) ok = false;
    rest.forEach(m => rests[m.p1] = (rests[m.p1] || 0) + 1);
    real.forEach(m => { const k = [m.p1, m.p2].sort().join('-'); if (seen.has(k)) ok = false; seen.add(k); });
  }
  check('RR: 2 match + 1 riposo per round, nessuna coppia ripetuta', ok);
  check('RR: 10 coppie uniche totali', seen.size === 10);
  check('RR: ogni giocatore riposa una volta', Object.values(rests).every(v => v === 1) && Object.keys(rests).length === 5);
}

// ── 10. Round robin con N pari: guard esplicito ──
{
  reset(['A', 'B', 'C', 'D'], 'roundrobin');
  let threw = false;
  try { app.generateAllRRRounds(); } catch { threw = true; }
  check('RR: throw con numero pari di giocatori', threw);
}

// ── 11. Drop: il match aperto del round corrente diventa forfeit 2-0 ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [{ pairings: [app.mkM(1, 2), match(3, 4, 2, 0)] }];
  S.T.currentRound = 1;
  sandbox.document.getElementById('dropSel').value = '2';
  app.dropPlayer();
  sandbox.document.getElementById('modalConfirm').onclick(); // conferma nel modal
  const m = S.T.rounds[0].pairings[0];
  const p2 = S.T.players.find(p => p.id === 2);
  check('drop: giocatore marcato ritirato', p2.dropped === true && p2.droppedAtRound === 1);
  check('drop: match aperto forfeit 2-0 per l\'avversario', m.forfeit === true && m.p1wins === 2 && m.p2wins === 0);
}

// ── 12. Undo round: ripristina i drop del round annullato ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [
    { pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0)] },
    { pairings: [app.mkM(1, 3), app.mkM(2, 4)] },
  ];
  S.T.currentRound = 2; S.viewingRound = 2;
  const p4 = S.T.players.find(p => p.id === 4);
  p4.dropped = true; p4.droppedAtRound = 2;
  app.undoRound();
  check('undo: torna al round 1', S.T.currentRound === 1 && S.T.rounds.length === 1);
  check('undo: drop del round annullato ripristinato', p4.dropped === false && p4.droppedAtRound === null);
}

// ── 13. startWithMode: timer configurabile + smoke test del rendering ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.started = false; S.T.rounds = []; S.T.currentRound = 0;
  app.startWithMode('swiss', 3, 40);
  check('start: timer impostato a 40 minuti', S.TM.total === 40 * 60);
  check('start: torneo avviato con R1 generato', S.T.started === true && S.T.rounds.length === 1 && S.T.currentRound === 1);
  check('start: R1 draft cross-table (seat 1 vs seat 3)', S.T.rounds[0].pairings[0].p1 === 1 && S.T.rounds[0].pairings[0].p2 === 3);
}

// ── 14. standingsAt: delta posizioni senza effetti collaterali ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [
    { pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0)] }, // dopo R1: A,C in testa
    { pairings: [match(1, 3, 0, 2), match(2, 4, 2, 0)] }, // R2: C batte A
  ];
  const prev = app.standingsAt(1);
  check('standingsAt: classifica al round 1 (2 in testa a 3pt)', prev[0].mp === 3 && prev[1].mp === 3 && prev[2].mp === 0);
  check('standingsAt: T.rounds ripristinato', S.T.rounds.length === 2);
  const now = app.getSwissStandings();
  check('standingsAt: dopo R2 C guida a 6pt', now[0].name === 'C' && now[0].mp === 6);
}

// ── 15. Pairing 16 giocatori: veloce anche con fasce dispari (patte), niente rematch evitabili ──
{
  const RES = [[2, 0, 0], [2, 1, 0], [1, 2, 0], [0, 2, 0], [1, 1, 1], [1, 0, 0], [0, 0, 1]];
  let worst = 0, rematches = 0;
  for (let trial = 0; trial < 10; trial++) {
    reset(Array.from({ length: 16 }, (_, i) => 'P' + (i + 1)));
    S.T.totalRounds = 5;
    for (let r = 1; r <= 5; r++) {
      S.T.currentRound = r;
      const t0 = performance.now();
      const pairs = app.generatePairings();
      worst = Math.max(worst, performance.now() - t0);
      rematches += pairs.filter(m => !m.bye && app.havePlayed(m.p1, m.p2)).length;
      S.T.rounds.push({ pairings: pairs });
      for (const m of pairs) { const x = RES[Math.floor(Math.random() * RES.length)]; [m.p1wins, m.p2wins, m.draws] = x; }
    }
  }
  check('pairing 16 giocatori: ogni round < 250 ms', worst < 250, `peggiore ${worst.toFixed(0)} ms`);
  check('pairing 16 giocatori: nessun rematch in 5 round', rematches === 0, `${rematches} rematch`);
}

// ── 16. Ordine al tavolo sempre allineato ai giocatori iscritti ──
{
  const T = S.T;
  const fresh = () => { T.players = []; T.draftOrder = []; T.rounds = []; T.started = false; T.ended = false; T.currentRound = 0; S.playerIdCounter = 0; };
  const add = n => { sandbox.document.getElementById('playerInput').value = n; app.addPlayer(); };

  fresh(); ['A', 'B', 'C', 'D'].forEach(add);
  app.goToSeating();
  const before = T.draftOrder.slice();
  add('E');
  check('tavolo: giocatore aggiunto dopo va in coda, posizioni esistenti invariate',
    T.draftOrder.length === 5 && T.draftOrder[4] === 5 && before.every((id, i) => T.draftOrder[i] === id));
  let threw = false;
  try { app.startWithMode('roundrobin'); } catch { threw = true; }
  check('tavolo: RR con giocatore aggiunto dopo parte e lo include',
    !threw && T.rounds.length === 5 && T.rounds.some(r => r.pairings.some(m => m.p1 === 5 || m.p2 === 5)));

  fresh(); ['A', 'B', 'C', 'D', 'E'].forEach(add);
  app.goToSeating(); app.removePlayer(3);
  threw = false;
  try { app.switchTab('draft'); } catch { threw = true; }
  check('tavolo: rimozione dopo il tavolo non manda in crash la tab Tavolo', !threw && !T.draftOrder.includes(3) && T.draftOrder.length === 4);

  fresh(); ['A', 'B', 'C', 'D'].forEach(add);
  T.draftOrder = []; // tavolo mai aperto: si passa dalla nav invece che dal pulsante
  app.startWithMode('swiss', 2, 50);
  check('tavolo: avvio senza aver aperto il tavolo genera comunque R1 completo', T.rounds[0].pairings.length === 2);
}

// ── 17. Round robin: a parità di punti decide lo scontro diretto ──
{
  reset(['A', 'B', 'C', 'D', 'E'], 'roundrobin');
  app.generateAllRRRounds();
  // A (id 1) ed E (id 5) chiudono 3-1, E ha battuto A. A inserito prima di E: senza H2H vincerebbe A.
  // Totali: A 3V, E 3V, C 2V, B 1V, D 1V.
  const winners = { '1-2': 1, '1-3': 1, '1-4': 1, '1-5': 5, '2-5': 2, '3-5': 5, '4-5': 5, '2-3': 3, '2-4': 4, '3-4': 3 };
  for (const r of S.T.rounds) for (const m of r.pairings) {
    if (m.rest) continue;
    const w = winners[[m.p1, m.p2].sort().join('-')];
    m.p1wins = w === m.p1 ? 1 : 0; m.p2wins = w === m.p2 ? 1 : 0;
  }
  const st = app.getSwissStandings();
  check('RR H2H: A ed E a pari punti, E davanti per lo scontro diretto',
    st[0].mp === st[1].mp && st[0].name === 'E' && st[1].name === 'A', st.map(p => `${p.name}:${p.mp}`).join(','));
}

// ── 18. "Termina torneo" chiede conferma ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [{ pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0)] }];
  S.T.totalRounds = 1;
  app.confirmEnd();
  check('termina: dopo il tap il torneo non è ancora concluso', S.T.ended === false);
  sandbox.document.getElementById('modalConfirm').onclick();
  check('termina: concluso dopo la conferma', S.T.ended === true);
}

// ── 19. Nomi brevi non ambigui + risultati escapati ──
{
  reset(['Marco Rossi', 'Marco Bianchi', 'Luca Verdi', '<img/src=x/onerror=alert(1)>'], 'roundrobin');
  check('nome breve: primo nome se unico', app.shortName(3) === 'Luca');
  check('nome breve: nome intero se il primo nome è condiviso', app.shortName(1) === 'Marco Rossi' && app.shortName(2) === 'Marco Bianchi');
  const html = app.fmtRes({ p1: 4, p2: 3, p1wins: 1, p2wins: 0, draws: 0 });
  check('fmtRes: nome del vincitore escapato', !html.includes('<img') && html.includes('&lt;img'), html);
  const btns = app.rrBtns(0, { p1: 1, p2: 2 });
  check('pulsanti RR: i due Marco sono distinguibili', btns.includes('Marco Rossi') && btns.includes('Marco Bianchi'));
}

// ── 20. Barra di stato aggiornata dopo ogni risultato (anche in round robin) ──
{
  reset(['A', 'B', 'C', 'D', 'E'], 'roundrobin');
  app.generateAllRRRounds(); S.T.totalRounds = 5; S.viewingRound = 1;
  S.T.rounds[0].pairings.forEach((m, i) => { if (!m.rest) app.setRes(0, i, 1, 0, 0); });
  const bar = sandbox.document.getElementById('statusBar').textContent;
  check('status bar: 1/5 round dopo aver completato il round 1', bar.includes('1/5'), bar);
}

// ── 21. Undo round azzera il timer ──
{
  reset(['A', 'B', 'C', 'D']);
  S.T.rounds = [{ pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0)] }, { pairings: [app.mkM(1, 3), app.mkM(2, 4)] }];
  S.T.currentRound = 2; S.viewingRound = 2;
  S.TM.seconds = 1234; S.TM.firedWarning = true;
  app.undoRound();
  check('undo: timer azzerato', S.TM.seconds === 0 && S.TM.running === false && S.TM.firedWarning === false);
}

// ── 22. Podio e medaglie saltano i giocatori ritirati ──
{
  reset(['A', 'B', 'C', 'D', 'E']);
  S.T.rounds = [{ pairings: [match(1, 2, 2, 0), match(3, 4, 2, 0), byeMatch(5)] }];
  S.T.players.find(p => p.id === 1).dropped = true; // A in testa ma ritirato
  S.T.ended = true;
  const medals = app.medalsById(app.getSwissStandings());
  check('podio: il ritirato non prende medaglia', !medals.has(1) && medals.size === 3);
  S.T.ended = false;
}

// ── 23. Copia: fallback quando navigator.clipboard non esiste ──
{
  const toastEl = sandbox.document.getElementById('toast');
  sandbox.document.execCommand = () => true;
  app.copyText('x', 'Copiato!');
  check('copia: fallback execCommand senza Clipboard API', toastEl.textContent === 'Copiato!', toastEl.textContent);
  sandbox.document.execCommand = () => false;
  app.copyText('x', 'Copiato!');
  check('copia: messaggio di errore se anche il fallback fallisce', toastEl.textContent === 'Copia non riuscita');
  delete sandbox.document.execCommand;
}

// ── 24. Back con un modal aperto: chiude il modal senza perdere il tab ──
{
  reset(['A', 'B', 'C', 'D']);
  const modal = sandbox.document.getElementById('modal');
  app.confirmEnd();
  check('back: modal aperto prima del back', modal.classList.contains('active'));
  sandbox.history.state = { tab: 'draft' }; // il browser è già tornato alla voce precedente
  winListeners.popstate.forEach(fn => fn({ state: sandbox.history.state }));
  check('back: modal chiuso e voce del tab corrente rimessa in cronologia',
    !modal.classList.contains('active') && S.T.ended === false && sandbox.history.state.tab === 'setup');
}
