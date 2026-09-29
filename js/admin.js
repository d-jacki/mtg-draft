// Strumenti master: PIN master, cronologia del torneo live con ripristino, tornei eliminati.
// Il PIN master (se la lega ne ha uno, vedi supabase/schema.sql) sblocca su un telefono le operazioni delicate:
// ripristinare versioni del torneo, correggere round chiusi, eliminare tornei e giocatori, unire profili, chiudere
// il live per tutti. La verifica del PIN è sul server (league_verify_master), ma il blocco è solo nell'app: chi ha
// il PIN normale può comunque scrivere via API. Serve contro gli errori, non contro chi vuole fare danni apposta.

// ── PIN master ──
function masterRequired() { return syncConfigured() && syncCfg.hasMaster === true; }
function masterOn() { return !!(syncConfigured() && syncCfg.adminPin); }
function canAdmin() { return !masterRequired() || masterOn(); }
let _afterMaster = null;
// Esegue fn se permesso, altrimenti chiede prima il PIN master
function requireMaster(fn) {
  if (canAdmin()) return fn();
  _afterMaster = fn;
  openMasterForm('Questa operazione è riservata a chi ha il PIN master.');
}
function openMasterForm(text) {
  showModalCustom('PIN master', text || 'Sblocca su questo telefono le operazioni avanzate: ripristino dalla cronologia, correzione dei round chiusi, eliminazioni.',
    `<input type="password" id="masterInp" autocomplete="off" aria-label="PIN master" onkeydown="if(event.key==='Enter')saveMasterForm()">
    <div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="_afterMaster=null;closeModal()">Annulla</button><button class="btn btn-primary btn-sm" id="masterSaveBtn" onclick="saveMasterForm()">Sblocca</button></div>`);
}
async function saveMasterForm() {
  const pin = $id('masterInp').value, btn = $id('masterSaveBtn');
  if (!pin) return;
  btn.disabled = true; btn.textContent = 'Verifica…';
  try {
    await sbRpc('league_verify_master', { p_league: syncCfg.league, p_pin: pin });
    syncCfg.adminPin = pin; syncCfg.hasMaster = true; saveSyncCfg();
    closeModal(); toast('🔑 Modalità master attiva su questo telefono');
    refreshAfterMaster();
    const f = _afterMaster; _afterMaster = null;
    if (f) f();
  } catch (e) {
    toast(e.message || 'Verifica non riuscita');
    btn.disabled = false; btn.textContent = 'Sblocca';
  }
}
function exitMaster() { syncCfg.adminPin = ''; saveSyncCfg(); refreshAfterMaster(); toast('Modalità master disattivata'); }
function refreshAfterMaster() { renderSyncBox(); if (T.started) renderRound(true); }

// ── Cronologia del torneo live ──
// Ogni scrittura su league_live finisce in league_live_history (trigger sul server, ultimi 14 giorni).
// Si leggono solo i campi leggeri; lo stato completo si scarica solo per la versione da ripristinare.
const HIST_COLS = 'rev,updated_at,tid:data->>id,device:data->>device,by:data->>by,note:data->>note,round:data->>currentRound,total:data->>totalRounds,ended:data->>ended,set:data->>set';
async function historyQuery(params) {
  const res = await fetch(`${syncCfg.url}/rest/v1/league_live_history?league_id=eq.${encodeURIComponent(syncCfg.league)}&${params}`, { headers: sbHeaders() });
  if (!res.ok) throw await sbError(res);
  return res.json();
}
function histWhen(ms) {
  const d = new Date(Number(ms)), today = d.toDateString() === new Date().toDateString();
  return (today ? '' : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function histWho(r) { return r.device === deviceId() ? 'questo telefono' : r.by ? esc(r.by) : 'un altro telefono'; }
// tid: versioni di un torneo; senza tid: elenco dei tornei live recenti
async function openHistory(tid) {
  if (!syncConfigured()) return;
  if (tid && !safeId(tid)) return;
  showModalCustom(tid ? 'Cronologia modifiche' : 'Cronologia live', 'Caricamento…', '');
  let rows;
  try {
    rows = await historyQuery(tid
      ? `select=${HIST_COLS}&data->>id=eq.${encodeURIComponent(tid)}&order=rev.desc&limit=300`
      : `select=${HIST_COLS},players:data->players&order=rev.desc&limit=200`);
  } catch (e) {
    $id('modalText').textContent = /league_live_history/.test(e.message || '') ? 'Rilancia supabase/schema.sql per attivare la cronologia' : (e.message || 'Errore di rete');
    $id('modalBody').innerHTML = '<button class="btn btn-secondary btn-sm" onclick="closeModal()">Chiudi</button>';
    return;
  }
  if (!$id('modal').classList.contains('active')) return; // chiuso nel frattempo
  if (tid) renderHistoryVersions(tid, rows); else renderHistoryTournaments(rows);
}
function renderHistoryVersions(tid, rows) {
  // La prima riga è lo stato attuale se questo telefono gestisce quel torneo ed è allineato a quella revisione
  const current = rows.length && T.id === tid && sharingOn() && liveSh().rev === Number(rows[0].rev);
  const locked = !canAdmin() ? '🔒 ' : '';
  $id('modalText').textContent = rows.length
    ? `${rows.length} version${rows.length === 1 ? 'e' : 'i'}. Ripristinando, il torneo torna a quel momento su tutti i telefoni che lo gestiscono.${locked ? ' Serve il PIN master.' : ''}`
    : 'Nessuna modifica registrata per questo torneo.';
  $id('modalBody').innerHTML = `<div class="hist-list">${rows.map((r, i) => `<div class="hist-row"><div class="hist-main"><div class="hist-note">${esc(r.note || 'Modifica')}</div>
      <div class="text-xs text-dim">${histWhen(r.updated_at)} · ${histWho(r)} · ${r.ended === 'true' ? 'concluso' : `R${esc(r.round)}/${esc(r.total)}`}</div></div>
      ${i === 0 && current ? '<span class="hist-now">Attuale</span>' : `<button class="btn btn-secondary btn-sm" onclick="confirmRestore('${tid}',${Number(r.rev)})">${locked}Ripristina</button>`}</div>`).join('')}</div>
    <div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="openHistory()">Altri tornei</button><button class="btn btn-secondary btn-sm" onclick="closeModal()">Chiudi</button></div>`;
}
function renderHistoryTournaments(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!safeId(r.tid)) continue;
    if (!groups.has(r.tid)) groups.set(r.tid, { last: r, n: 0 });
    groups.get(r.tid).n++;
  }
  $id('modalText').textContent = groups.size ? 'Tornei trasmessi in diretta negli ultimi 14 giorni. Aprine uno per vedere le modifiche e ripristinarlo.' : 'Nessun torneo live negli ultimi 14 giorni.';
  $id('modalBody').innerHTML = [...groups].map(([tid, g]) => {
    const r = g.last, names = (Array.isArray(r.players) ? r.players : []).map(p => p.name);
    const who = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
    return `<button class="mode-choice-btn hist-t" onclick="openHistory('${tid}')"><strong>${esc(r.set || 'Draft')} · ${histWhen(r.updated_at)}${T.id === tid ? ' · questo' : ''}</strong>
      <span class="desc">${esc(who)}${who ? ' · ' : ''}${r.ended === 'true' ? 'concluso' : `round ${esc(r.round)}/${esc(r.total)}`} · ${g.n} modific${g.n === 1 ? 'a' : 'he'}</span></button>`;
  }).join('') + '<button class="btn btn-secondary btn-sm" onclick="closeModal()">Chiudi</button>';
}
function confirmRestore(tid, rev) {
  if (!syncCanWrite()) { toast('Serve il PIN della lega'); return; }
  requireMaster(async () => {
    let rows;
    try { rows = await historyQuery(`select=data,updated_at&rev=eq.${Number(rev)}`); } catch (e) { toast(e.message || 'Errore di rete'); return; }
    const d = rows[0] && rows[0].data;
    if (!d || d.id !== tid || !validLiveState(d)) { toast('Versione non trovata'); return; }
    const when = histWhen(rows[0].updated_at);
    const otherLive = live.data && live.data.started && !live.data.ended && live.data.id !== tid;
    const otherLocal = T.started && !T.ended && T.id !== tid;
    showModal('Ripristinare questa versione?',
      `Il torneo torna com'era alle ${when} (${d.ended ? 'concluso' : `round ${d.currentRound}/${d.totalRounds}`}) su tutti i telefoni che lo gestiscono. Le modifiche successive restano in cronologia.`
      + (otherLive ? ' In diretta c\'è un altro torneo: verrà sostituito.' : '')
      + (otherLocal ? ' Il torneo in corso su questo telefono verrà sostituito.' : ''),
      () => restoreVersion(d, when));
  });
}
function restoreVersion(d, when) {
  const state = JSON.parse(JSON.stringify(d));
  delete state.note; delete state.by;
  // Torneo diverso, staccato dal live o mai gestito da qui: diventa quello gestito da questo telefono
  if (!(T.started && T.id === state.id && sharingOn())) liveAdopt(state);
  doOp({ t: 'restore', state, label: 'delle ' + when });
  viewingRound = T.currentRound || 1;
  save(); LUI.live = false;
  showStartedTournament(); switchTab(T.ended ? 'standings' : 'round');
  livePublishSoon(0);
  toast('Versione ripristinata');
}

// ── Tornei eliminati ──
function deletedTournaments() { return Object.values(L.tournaments).filter(t => t.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
function openDeletedTournaments() {
  const list = deletedTournaments().filter(t => safeId(t.id));
  showModalCustom('Tornei eliminati', list.length ? 'Ripristinati tornano in campionato, Elo e statistiche.' : 'Nessun torneo eliminato.',
    `<div class="hist-list">${list.map(t => {
      const win = rankedIds(t)[0], wname = win ? (t.names && t.names[win]) || leagueName(win) : '';
      return `<div class="hist-row"><div class="hist-main"><div class="hist-note">${fmtDate(t.date)} · ${esc(t.set || 'Draft')}</div>
        <div class="text-xs text-dim">${t.entrants.length} giocatori${wname ? ' · vinto da ' + esc(wname) : ''}</div></div>
        <button class="btn btn-secondary btn-sm" onclick="restoreTournament('${t.id}')">${canAdmin() ? '' : '🔒 '}Ripristina</button></div>`;
    }).join('')}</div><button class="btn btn-secondary btn-sm mt" onclick="closeModal()">Chiudi</button>`);
}
function restoreTournament(id) {
  requireMaster(() => { updateTournament(id, { deleted: false }); renderLeague(); openDeletedTournaments(); toast('Torneo ripristinato'); });
}
