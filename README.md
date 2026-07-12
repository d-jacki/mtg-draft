# MTG Draft Swiss

PWA per gestire tornei di Magic: The Gathering tra amici — draft con pairing **Swiss** (BO3) o **round robin BO1** per numeri dispari.

**App live:** https://d-jacki.github.io/mtg-draft/

## Funzionalità

- 4–16 giocatori, disposizione al tavolo per il draft con pairing cross-table al round 1
- Pairing Swiss conforme alle [MTR](https://blogs.magicjudges.org/rules/mtr-appendix-c/): random dentro le fasce di punti, minimizzazione dei rematch (backtracking), bye a rotazione nella fascia più bassa
- Tiebreaker MTR Appendix C: Match Points → OMW% → GW% → OGW% (floor 33%, bye = 2-0 escluso dai calcoli sugli avversari)
- Risultati completi inclusi i casi a tempo scaduto (1-0, 1-1, 1-0-1, 0-0-1, …) e ID come `(0,0,1)`
- Timer round wall-clock (regge reload e background), drop con auto-forfeit, undo round
- Offline-first (service worker), installabile su Android e iOS, salvataggio automatico in localStorage

## Test

Suite senza dipendenze (serve solo Node ≥ 18):

```
node tests/run-tests.mjs
```

Copre gli scenari dell'audit 2026-05: tiebreaker, GW% con ID/bye, pairing senza rematch, schedule round robin, drop/forfeit, undo.

## Deploy

L'app è un singolo `index.html` servito da GitHub Pages (branch `master`).

1. Modifica i file
2. **Incrementa `CACHE_NAME` in `sw.js`** (es. `mtg-draft-v14`) per invalidare la cache offline
3. `node tests/run-tests.mjs`
4. Commit e push — Pages si aggiorna in 1-2 minuti

## Note architetturali

Tutto in un file (`index.html`), niente build né dipendenze: è una scelta deliberata per la scala del progetto (≤16 giocatori, un dispositivo). I test estraggono lo script dall'HTML e lo eseguono in una sandbox Node con DOM stub.
