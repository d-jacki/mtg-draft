# Tournament Manager — Audit & Fix Progress

## Status: CHIUSO (2026-07-12)

Tutte le fasi dell'audit 2026-05 sono completate e mergiate:

- **Phase 1** — HIGH-severity fixes → PR #1 (merged 2026-05-16)
- **Phase 2** — A11y bundle → PR #2 (merged 2026-05-16)
- **Phase 3** — Score input completeness, Option A (draws=1) → PR #3 (merged 2026-05-17)
- **Follow-up 2026-07-12** — icone PNG/maskable, service worker riscritto, item residui dell'audit, test suite (vedi sotto)

## Decisioni prese (log storico)

- **ID encoding**: Option A (draws=1). Allineato a Eventlink/Companion, GW% con denominatore onesto, coerente con MTR "unplayed games = 0 points".
- **File locale `mtg-tournament.html`**: eliminato (era `.bak`); `pwa/index.html` è l'unica source of truth.
- **Scenario 5 (H2H circolare)**: i tiebreaker MTR non possono separare A>B>C>A (per simmetria MP/OMW%/GW%/OGW% identici). Ordine di inserimento stabile = esito strict-MTR corretto. Coperto da test.
- **Scenario 3**: GW% atteso con Option A è 46.67% (7/15). La formula in codice era corretta; il valore atteso nel doc originale era sbagliato. Coperto da test.
- **Bye e GW% personale** (verificato su MTR Appendix C, 2026-07-12): il bye vale 2–0 → 3 match points e 6 game points, conta nel proprio MWP/GW%, ed è escluso solo dai calcoli sugli avversari (OMW%/OGW%). Il codice era già corretto. Coperto da test.
- **Ultimo round** (decisione utente, 2026-07-12): pairing casuale dentro le fasce come tutti i round (MTR standard). Il ramo speciale per-classifica è stato rimosso.
- **Easter egg "Ferro"** (decisione utente, 2026-07-12): si tiene.
- **Soglia minima 4 giocatori**: confermata — un draft sotto i 4 non ha senso. Wontfix.

## Item "out of scope" dell'audit — esito (2026-07-12)

| Item | Esito |
|---|---|
| sw.js: restrict same-origin, considerare SWR | ✅ Fatto — sw.js v13: shell same-origin in stale-while-revalidate, font Google cache-first, fallback a index.html solo per navigazioni |
| pushState / back button | ✅ Fatto — history per tab, il back chiude il modal / naviga i tab |
| maxlength=40 + ellipsis sui nomi | ✅ Fatto (+ `esc()` ora escapa anche le virgolette: fix iniezione attributi) |
| Guard su generateAllRRRounds con N pari | ✅ Fatto — throw esplicito, coperto da test |
| Dead fallback in pairPool | ✅ Rimosso, con commento sul perché pairPool non fallisce mai |
| Last-round standings-sort | ✅ Rimosso (MTR standard, decisione utente) |
| R1 cross-table | ✅ Documentato (testo in UI + README): intenzionale per i pod di draft |
| Soglia n<4 | ✅ Wontfix (vedi decisioni) |
| Editing round Swiss passati (judge override) | 📋 Issue [#4](https://github.com/d-jacki/mtg-draft/issues/4) |

## Test

`node tests/run-tests.mjs` — 25 assert su: scenario 3 (GW% 7/15), bye MTR, floor 0.33, catena tiebreaker, H2H circolare stabile, pairing R2 senza rematch, bye a rotazione, schedule RR a 5, guard RR pari, drop→forfeit, undo→ripristino drop.

Eseguirli prima di ogni push (vedi README).
