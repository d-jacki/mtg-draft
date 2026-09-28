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
- **Sync Supabase**: tutti vedete la lega dal vostro telefono — vedi sotto

### Torneo in diretta
- Il telefono che gestisce il torneo (con il PIN) lo pubblica a ogni risultato, round o avvio del timer — badge **● LIVE** nel round
- Gli altri vedono il banner **🔴 Torneo in corso · Segui**: pairing, risultati, classifica e timer in tempo reale
- **"Io sono…"**: scegli il tuo nome e l'app ti dice tavolo e avversario (o bye/riposo) ed evidenzia la tua riga
- Aggiornamenti istantanei con Supabase Realtime, lettura di riserva ogni 20 s; il torneo resta offline-first e ripubblica al ritorno della rete

## Sincronizzazione con Supabase

L'app è local-first: senza rete funziona tutto, i dati stanno sul telefono. La lega è già configurata in `js/config.js` (URL, chiave publishable, id lega): chi apre l'app è collegato **in sola lettura** senza fare niente. Per registrare tornei e trasmetterli in diretta: **Lega → Dati e sync → Inserisci PIN**, una volta sola sul telefono di chi gestisce.

Da zero, per una lega nuova:
1. Crea un progetto su [supabase.com](https://supabase.com) (piano gratuito).
2. Nel **SQL Editor** esegui `supabase/schema.sql` (rieseguibile: dopo un aggiornamento dello schema basta rilanciarlo, i dati restano).
3. Sempre nel SQL Editor crea la lega con il PIN (istruzioni in fondo a `schema.sql`) e copia l'**id** restituito.
4. Metti Project URL, chiave publishable (Project Settings → API Keys) e id lega in `js/config.js`. **Mai la secret key.**

In alternativa, **Lega → Dati e sync → Avanzate → Altra lega** collega a mano un'altra lega (e da lì si genera un link invito).

Sicurezza: URL e chiave publishable sono pubblici per natura (e sono nel repo). Con quelli si può solo **leggere**; ogni scrittura passa da `league_push` / `league_live_push`, che verificano il PIN, e dopo **10 PIN sbagliati in 15 minuti** la lega rifiuta le scritture per 15 minuti. Usa un PIN di almeno 6 caratteri. Conflitti tra telefoni: vince la modifica più recente per ogni giocatore/torneo; un solo torneo live per lega.

## Struttura

```
index.html          markup
css/app.css         stili
js/config.js        lega predefinita (URL, chiave publishable, id lega)
js/tournament.js    torneo: setup, tavolo, pairing, punteggi, timer, round, classifica, navigazione
js/league.js        lega: anagrafica, archivio, campionato, Elo, statistiche, achievement (logica pura)
js/sync.js          sync Supabase via REST (nessuna libreria), verifica PIN
js/league-ui.js     tab Lega, profilo, dettaglio torneo, dati e sync, agganci nel torneo
js/live.js          torneo in diretta: pubblicazione, Realtime (WebSocket Phoenix), vista "Segui live"
js/main.js          avvio: caricamento dati, ripristino, service worker (va caricato per ultimo)
supabase/schema.sql schema, funzioni di scrittura con PIN e limite di tentativi, Realtime
tests/              test senza dipendenze
```

Niente build né dipendenze: script classici che condividono lo scope globale, caricati in ordine da `index.html`.

## Test

Suite senza dipendenze (serve solo Node ≥ 18):

```
node tests/run-tests.mjs
```

L'harness (`tests/harness.mjs`) carica gli script nell'ordine di `index.html` (tranne `config.js`: i test non toccano il Supabase vero) in una sandbox Node con DOM finto. `tests/mock-supabase.mjs` è un finto Supabase con lo stesso contratto di `schema.sql`. Quattro suite:
- `tournament.test.mjs` — tiebreaker, GW% con ID/bye, pairing (anche performance a 16 giocatori), round robin, drop/forfeit, undo, tavolo, UX
- `league.test.mjs` — archivio, campionato, Elo, scontri diretti, unione profili, achievement, import/export, colori, colpaccio, rendering
- `sync.test.mjs` — primo caricamento, modifiche remote, last-write-wins, PIN errato, sola lettura, paginazione, link invito
- `live.test.mjs` — lega predefinita, verifica PIN e blocco anti forza bruta, pubblicazione live, vista "Segui live", Realtime

## Deploy

GitHub Pages dal branch `master`.

1. Modifica i file
2. **Incrementa `CACHE_NAME` in `sw.js`** (es. `mtg-draft-v18`) per invalidare la cache offline; se aggiungi un file, mettilo in `ASSETS`
3. `node tests/run-tests.mjs`
4. Commit e push — Pages si aggiorna in 1-2 minuti
