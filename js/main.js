// Avvio: ripristino dello stato salvato e registrazione del service worker. Va caricato per ultimo.

// ── LEGA E SYNC ──
loadLeague();
loadSyncCfg();
if (applyInviteHash()) setTimeout(() => toast(`Collegato alla lega${syncCfg.name ? ' ' + syncCfg.name : ''}`), 300);
renderRosterChips();
window.addEventListener('online', () => syncSoon());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - syncState.lastSync > 60000) syncNow(false); });

// ── RESTORE ──
(function(){
  const timerWasRunning = load();
  if (!T.started && T.players.length === 0) return;
  renderPlayerList();
  if (T.draftOrder.length) renderSeating();
  if (T.started) {
    $id('screen-setup').querySelectorAll('input, button').forEach(el => el.disabled = true);
    $id('startBtn').classList.add('hidden'); $id('reshuffleBtn').classList.add('hidden');
    updateStatus();
    renderRound(); renderStandings();
    if (timerWasRunning) startTimer();
    if (T.ended) switchTab('standings'); else switchTab('round');
  } else if (T.players.length >= 4 && T.draftOrder.length) {
    switchTab('draft');
  }
})();

syncNow(false);

// ── SERVICE WORKER ──
if ('serviceWorker' in navigator) {
  // Va letto subito: dopo clients.claim() il controller è attivo anche alla prima installazione
  const wasControlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'activated' && wasControlled) {
          document.getElementById('updateBanner').classList.add('show');
        }
      });
    });
  });
}
