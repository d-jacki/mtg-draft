// Test suite per MTG Draft Swiss — zero dipendenze, solo Node >= 18.
// Uso: node tests/run-tests.mjs
// Estrae lo <script> principale da index.html, lo esegue in una sandbox vm
// con un DOM finto e verifica gli scenari dell'audit (tiebreaker MTR, pairing,
// bye, drop, ID, round robin).

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appJs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])[0];
if (!appJs || !appJs.includes('getPlayerRecord')) {
  console.error('FATAL: impossibile estrarre lo script principale da index.html');
  process.exit(2);
}

// ── DOM stub ──
function mkEl() {
  const classes = new Set();
  return {
    addEventListener() {}, removeEventListener() {},
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      toggle(c, force) { (force ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); },
      contains: c => classes.has(c),
    },
    querySelectorAll: () => [], querySelector: () => null,
    style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', className: '',
    disabled: false, clientWidth: 320,
    focus() {}, select() {}, scrollIntoView() {},
    appendChild() {}, removeChild() {}, setAttribute() {},
  };
}
const elements = new Map();
const store = new Map();
const sandbox = {
  document: {
    getElementById: id => { if (!elements.has(id)) elements.set(id, mkEl()); return elements.get(id); },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, createElement: () => mkEl(),
    body: mkEl(), activeElement: null,
  },
  window: { addEventListener() {}, scrollTo() {} },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  navigator: {},
  location: { reload() {}, origin: 'http://localhost' },
  history: { state: null, pushState(s) { this.state = s; }, replaceState(s) { this.state = s; }, back() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Espone lo stato lessicale (const/let) del modulo app al test harness.
const exportShim = `
;globalThis.__t = {
  get T() { return T }, get TM() { return TM },
  get viewingRound() { return viewingRound }, set viewingRound(v) { viewingRound = v },
  get playerIdCounter() { return playerIdCounter }, set playerIdCounter(v) { playerIdCounter = v },
};`;
vm.runInContext(appJs + exportShim, sandbox, { filename: 'index.html<script>' });

const app = sandbox; // le function declaration sono globali nella sandbox
const S = sandbox.__t;

// ── harness ──
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }
function match(p1, p2, w1, w2, d = 0) { const m = app.mkM(p1, p2); m.p1wins = w1; m.p2wins = w2; m.draws = d; return m; }
function byeMatch(pid) { return { p1: pid, p2: null, p1wins: 2, p2wins: 0, draws: 0, bye: true, rest: false, forfeit: false }; }
function reset(names, mode = 'swiss') {
  const T = S.T;
  T.players = names.map((name, i) => ({ id: i + 1, name, dropped: false, droppedAtRound: null }));
  T.draftOrder = T.players.map(p => p.id);
  T.rounds = []; T.started = true; T.ended = false;
  T.totalRounds = 3; T.currentRound = 1; T.mode = mode;
  S.viewingRound = 1; S.playerIdCounter = names.length;
}

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

// ── esito ──
console.log(`\n${passed} passati, ${failed} falliti`);
process.exit(failed ? 1 : 0);
