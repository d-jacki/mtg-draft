# MTG Draft Swiss

PWA per gestire tornei di Magic: The Gathering tra amici — draft con pairing **Swiss** (BO3) o **round robin BO1** per numeri dispari — e una **lega** con storico, campionato e statistiche di ogni giocatore.

**App live:** https://d-jacki.github.io/mtg-draft/

## Funzionalità

### Torneo
- 4–16 giocatori, disposizione al tavolo per il draft con pairing cross-table al round 1
- Pairing Swiss conforme alle [MTR](https://blogs.magicjudges.org/rules/mtr-appendix-c/): random dentro le fasce di punti, minimizzazione dei rematch (matching ottimo con memoizzazione, istantaneo fino a 16 giocatori), bye a rotazione nella fascia più bassa
- Tiebreaker MTR Appendix C: Match Points → OMW% → GW% → OGW% (floor 33%, bye = 2-0 escluso dai calcoli sugli avversari)
- Round robin: a parità di punti decide lo scontro diretto (mini-classifica tra i pari merito), poi i tiebreaker MTR
- Risultati completi inclusi i casi a tempo scaduto (1-0, 1-1, 1-0-1, 0-0-1, …) e ID come `(0,0,1)`
- Timer round wall-clock configurabile (30–60 min) con wake lock (schermo sempre acceso), beep + vibrazione a −5 minuti e allo scadere
- Schermata "Annuncia pairing" a caratteri grandi da mostrare al tavolo, con precedenti e pronostico Elo per ogni tavolo
- Drop con auto-forfeit, undo round, podio finale con coriandoli, delta posizioni in classifica, colori del mazzo per giocatore
- Offline-first (service worker, font self-hosted), installabile su Android e iOS, salvataggio automatico in localStorage, avviso quando è disponibile una nuova versione

### Lega (tab "Lega")
- **Anagrafica**: giocatori abituali da toccare nel setup invece di riscrivere i nomi; avatar, rinomina, unione di profili doppi
- **Storico**: ogni torneo concluso viene archiviato (classifica, round, set/cube, mazzi); consultabile e correggibile
- **Campionato** stagionale: 1 punto per ogni giocatore che ti arriva dietro + 1 di presenza + 2 al vincitore (chi si ritira: solo presenza)
- **Rating Elo** su tutti i match (partenza 1500, K=32; bye e forfeit esclusi), con andamento nel tempo
- **Profilo**: tornei, vittorie, podi, record match/game, forma recente, grafico Elo, statistiche per colore, nemesi e vittima preferita
- **Scontri diretti**: matrice tutti-contro-tutti
- **Achievement** (13, retroattivi) e titoli: 👑 campione in carica, 🩷 leader del campionato
- **💥 Colpaccio** quando vince lo sfavorito secondo l'Elo (pronostico sotto il 30%)
- **Backup**: esporta/importa l'archivio in JSON
- **Sync Supabase** (facoltativo): tutti vedete la lega dal vostro telefono — vedi sotto

## Sincronizzazione con Supabase (facoltativa)

L'app è local-first: senza Supabase funziona tutto, i dati stanno sul telefono. Con Supabase la lega si condivide tra più telefoni.

1. Crea un progetto su [supabase.com](https://supabase.com) (piano gratuito).
2. Nel **SQL Editor** esegui `supabase/schema.sql`.
3. Sempre nel SQL Editor crea la lega con il tuo PIN (le istruzioni sono in fondo a `schema.sql`) e copia l'**id** restituito.
4. Nell'app: **Lega → Dati e sync → Collega Supabase**, con Project URL e chiave pubblica (Project Settings → API), id lega e PIN.
5. **Link invito**: mandalo agli amici — aprendolo, il loro telefono si collega in sola lettura. Chi deve registrare tornei inserisce anche il PIN.

Sicurezza: la chiave pubblica di Supabase è pubblica per natura. Con quella si può solo **leggere** la lega; ogni scrittura passa dalla funzione `league_push`, che verifica il PIN. Conflitti tra telefoni: vince la modifica più recente per ogni giocatore/torneo.

## Struttura

```
index.html          markup
css/app.css         stili
js/tournament.js    torneo: setup, tavolo, pairing, punteggi, timer, round, classifica, navigazione
js/league.js        lega: anagrafica, archivio, campionato, Elo, statistiche, achievement (logica pura)
js/sync.js          sync Supabase via REST (nessuna libreria)
js/league-ui.js     tab Lega, profilo, dettaglio torneo, agganci nel torneo
js/main.js          avvio: caricamento dati, ripristino, service worker (va caricato per ultimo)
supabase/schema.sql schema e funzione di scrittura con PIN
tests/              test senza dipendenze
```

Niente build né dipendenze: script classici che condividono lo scope globale, caricati in ordine da `index.html`.

## Test

Suite senza dipendenze (serve solo Node ≥ 18):

```
node tests/run-tests.mjs
```

L'harness (`tests/harness.mjs`) carica gli script nell'ordine di `index.html` in una sandbox Node con DOM finto. Tre suite:
- `tournament.test.mjs` — tiebreaker, GW% con ID/bye, pairing (anche performance a 16 giocatori), round robin, drop/forfeit, undo, tavolo, UX
- `league.test.mjs` — archivio, campionato, Elo, scontri diretti, unione profili, achievement, import/export, colori, colpaccio, rendering
- `sync.test.mjs` — sync contro un finto server PostgREST: primo caricamento, modifiche remote, last-write-wins, PIN errato, sola lettura, paginazione, link invito

## Deploy

GitHub Pages dal branch `master`.

1. Modifica i file
2. **Incrementa `CACHE_NAME` in `sw.js`** (es. `mtg-draft-v17`) per invalidare la cache offline; se aggiungi un file, mettilo in `ASSETS`
3. `node tests/run-tests.mjs`
4. Commit e push — Pages si aggiorna in 1-2 minuti
