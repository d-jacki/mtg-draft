// Test suite per MTG Draft Swiss — zero dipendenze, solo Node >= 18.
// Uso: node tests/run-tests.mjs
// Carica gli script dell'app (nell'ordine di index.html) in una sandbox vm con un DOM finto
// e lancia tutte le suite.

import { summary } from './harness.mjs';
await import('./tournament.test.mjs');
await import('./league.test.mjs');
await import('./sync.test.mjs');

process.exit(summary() ? 1 : 0);
