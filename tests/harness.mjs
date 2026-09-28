// Harness condiviso: carica gli script dell'app nell'ordine di index.html dentro una sandbox vm
// con un DOM finto, ed espone check() e helper per costruire tornei.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const sources = [...html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)]
  .map(m => ({ name: m[1] || 'index.html<script>', code: m[1] ? readFileSync(new URL(m[1], root), 'utf8') : m[2] }));
if (!sources.some(s => s.code.includes('getPlayerRecord'))) {
  console.error('FATAL: script dell\'app non trovati da index.html');
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
    disabled: false, clientWidth: 320, files: null,
    focus() {}, select() {}, scrollIntoView() {}, click() {},
    appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute() { return null; },
  };
}
const elements = new Map();
const store = new Map();
export const winListeners = {};
export const sandbox = {
  document: {
    getElementById: id => { if (!elements.has(id)) elements.set(id, mkEl()); return elements.get(id); },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, createElement: () => mkEl(),
    body: mkEl(), activeElement: null,
  },
  window: { addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); }, scrollTo() {} },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  navigator: { onLine: true },
  location: { reload() {}, origin: 'http://localhost', hash: '', pathname: '/', href: 'http://localhost/' },
  history: { state: null, pushState(s) { this.state = s; }, replaceState(s) { this.state = s; }, back() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, URL, Blob: class { constructor(parts) { this.parts = parts; } },
  TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
  fetch: async () => { throw new Error('fetch non disponibile nei test'); },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// Espone lo stato lessicale (const/let) degli script al test harness.
const exportShim = `
;globalThis.__t = {
  get T() { return T }, get TM() { return TM }, get L() { return L },
  get syncCfg() { return syncCfg }, get syncState() { return syncState },
  get viewingRound() { return viewingRound }, set viewingRound(v) { viewingRound = v },
  get playerIdCounter() { return playerIdCounter }, set playerIdCounter(v) { playerIdCounter = v },
};`;
for (const s of sources) vm.runInContext(s.code, sandbox, { filename: s.name });
vm.runInContext(exportShim, sandbox, { filename: 'shim' });

export const app = sandbox; // le function declaration sono globali nella sandbox
export const S = sandbox.__t;
export const storage = store;

// ── harness ──
let passed = 0, failed = 0;
export function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
export function summary() {
  console.log(`\n${passed} passati, ${failed} falliti`);
  return failed;
}
export function section(title) { console.log(`\n# ${title}`); }
export function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }
export function match(p1, p2, w1, w2, d = 0) { const m = app.mkM(p1, p2); m.p1wins = w1; m.p2wins = w2; m.draws = d; return m; }
export function byeMatch(pid) { return { p1: pid, p2: null, p1wins: 2, p2wins: 0, draws: 0, bye: true, rest: false, forfeit: false }; }
export function reset(names, mode = 'swiss') {
  const T = S.T;
  T.players = names.map((name, i) => ({ id: i + 1, name, dropped: false, droppedAtRound: null }));
  T.draftOrder = T.players.map(p => p.id);
  T.rounds = []; T.started = true; T.ended = false;
  T.totalRounds = 3; T.currentRound = 1; T.mode = mode;
  S.viewingRound = 1; S.playerIdCounter = names.length;
}
