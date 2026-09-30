// Interfaccia della lega: tab "Lega" (campionato, Elo, tornei, scontri diretti, giocatori), profilo giocatore,
// dettaglio torneo archiviato, dati e sync. Più gli agganci nel torneo: giocatori abituali nel setup,
// precedenti nell'annuncio pairing, colori del mazzo, "colpaccio".

const LUI = { view: 'champ', season: null, profile: null, live: false };
const LEAGUE_VIEWS = [['champ', 'Campionato'], ['elo', 'Elo'], ['history', 'Tornei'], ['h2h', 'Scontri'], ['players', 'Giocatori']];

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number), dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function pct(x) { return x == null ? '—' : `${Math.round(x * 100)}%`; }
function pips(colors) { return (colors || '').split('').filter(c => COLORS.includes(c)).map(c => `<span class="pip pip-${c}" title="${COLOR_NAMES[c]}">${c}</span>`).join(''); }
function whoHtml(id, opts) {
  const o = opts || {};
  return `<span class="who"><span class="who-emoji" aria-hidden="true">${leagueEmoji(id)}</span><span class="who-name">${esc(leagueName(id))}</span>${o.titles ? `<span class="who-titles">${leagueTitles(id)}</span>` : ''}</span>`;
}
// Id di lega di un giocatore del torneo corrente (se non è ancora in anagrafica lo cerco per nome)
function tournamentLid(p) { if (!p) return null; if (p.leagueId && resolvePlayer(p.leagueId)) return canonicalId(p.leagueId); const f = findPlayerByName(p.name); return f ? f.id : null; }

// ── Tab Lega ──
function openProfile(id) { LUI.live = false; LUI.profile = canonicalId(id); if (!$id('screen-league').classList.contains('active')) switchTab('league'); else renderLeague(); window.scrollTo(0, 0); }
function closeProfile() { LUI.profile = null; renderLeague(); window.scrollTo(0, 0); }
function setLeagueView(v) { LUI.view = v; LUI.profile = null; LUI.live = false; renderLeague(); }
function setLeagueSeason(s) { LUI.season = s; renderLeague(); }
function onLeagueSynced() {
  if (clearDeletedTournament('Il torneo è stato eliminato dalla lega')) return;
  if ($id('screen-league').classList.contains('active')) renderLeague(); if (T.started) renderStandings();
}

function renderLeague() {
  const C = $id('leagueContent');
  if (LUI.live) { C.innerHTML = `<div id="liveView">${renderLiveView()}</div>`; return; }
  if (LUI.profile && resolvePlayer(LUI.profile)) { C.innerHTML = renderProfile(canonicalId(LUI.profile)); renderSyncBox(); return; }
  LUI.profile = null;
  const tournaments = sortedTournaments();
  let h = `<div id="leagueLiveBanner">${liveBannerHtml()}</div><div class="league-tabs" role="tablist">${LEAGUE_VIEWS.map(([v, label]) => `<button role="tab" aria-selected="${LUI.view === v}" class="league-tab${LUI.view === v ? ' active' : ''}" onclick="setLeagueView('${v}')">${label}</button>`).join('')}</div>`;
  if (!tournaments.length && LUI.view !== 'players') {
    h += `<div class="card text-center"><div class="empty-emoji" aria-hidden="true">🏆</div><div class="card-title" style="margin-bottom:6px;">La lega parte dal prossimo torneo</div>
      <div class="text-sm text-dim" style="line-height:1.6;">Quando confermi <b>Termina torneo</b>, risultati, mazzi e classifica finiscono qui: campionato, rating Elo, scontri diretti e achievement si calcolano da soli.</div></div>`;
  } else if (LUI.view === 'champ') h += renderChampionship();
  else if (LUI.view === 'elo') h += renderEloView();
  else if (LUI.view === 'history') h += renderHistory();
  else if (LUI.view === 'h2h') h += renderH2H();
  else h += renderRoster();
  h += `<div class="card" id="syncBox"></div>`;
  C.innerHTML = h;
  renderSyncBox();
}

function renderChampionship() {
  const seasons = leagueSeasons();
  if (!LUI.season || !seasons.includes(LUI.season)) LUI.season = seasons[0];
  const rows = championshipTable(LUI.season);
  const n = sortedTournaments().filter(t => t.season === LUI.season).length;
  const sel = seasons.length > 1 ? `<select class="season-sel" aria-label="Stagione" onchange="setLeagueSeason(this.value)">${seasons.map(s => `<option value="${s}"${s === LUI.season ? ' selected' : ''}>Stagione ${s}</option>`).join('')}</select>` : `<span class="text-xs text-dim">Stagione ${esc(LUI.season)}</span>`;
  return `<div class="card"><div class="flex-between mb"><div class="card-title" style="margin:0;">Campionato</div>${sel}</div>
    <table class="standings-table league-table"><thead><tr><th scope="col">#</th><th scope="col">Giocatore</th><th scope="col" title="Tornei giocati">T</th><th scope="col" title="Vittorie">V</th><th scope="col">Pts</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr onclick="openProfile('${r.id}')" tabindex="0" role="button" class="${i < 3 ? 'top3' : ''}"><td class="standings-rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td><td>${whoHtml(r.id, { titles: true })}</td><td>${r.played}</td><td>${r.wins}</td><td class="standings-record">${r.points}</td></tr>`).join('')}
    </tbody></table>
    <div class="text-xs text-dim mt" style="line-height:1.55;">${n} ${n === 1 ? 'torneo' : 'tornei'} in stagione. Punti per torneo: 1 per ogni giocatore che ti arriva dietro + 1 di presenza + 2 al vincitore. Chi si ritira prende solo la presenza.</div></div>`;
}

function sparkline(history) {
  const vals = [ELO_START, ...history.map(h => h.elo)];
  if (vals.length < 2) return '';
  const w = 48, h = 20, min = Math.min(...vals), max = Math.max(...vals), span = Math.max(max - min, 1);
  const pts = vals.map((v, i) => [(i * (w - 4)) / (vals.length - 1) + 2, h - 3 - ((v - min) / span) * (h - 6)]);
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="var(--accent)"/></svg>`;
}
function renderEloView() {
  const rows = eloTable();
  return `<div class="card"><div class="card-title">Rating Elo</div>
    <table class="standings-table league-table"><thead><tr><th scope="col">#</th><th scope="col">Giocatore</th><th scope="col">Elo</th><th scope="col" aria-label="Variazione ultimo torneo">Δ</th><th scope="col"><span class="sr-only">Andamento</span></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr onclick="openProfile('${r.id}')" tabindex="0" role="button"><td class="standings-rank">${i + 1}</td><td>${whoHtml(r.id)}</td><td class="standings-record">${r.elo}</td><td><span class="standings-delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'flat'}">${r.delta > 0 ? '▲' + r.delta : r.delta < 0 ? '▼' + (-r.delta) : '–'}</span></td><td>${sparkline(r.history)}</td></tr>`).join('')}
    </tbody></table>
    <div class="text-xs text-dim mt" style="line-height:1.55;">Ogni match sposta il rating in base alla forza dell'avversario (partenza ${ELO_START}, K=${ELO_K}): battere chi sta sopra vale di più. Bye e forfeit non contano.</div></div>`;
}

function renderHistory() {
  const list = sortedTournaments().slice().reverse();
  return `<div class="card"><div class="card-title">Storico tornei</div>${list.map(t => {
    const w = rankedIds(t)[0];
    return `<button class="history-item" onclick="openTournament('${t.id}')"><div class="history-date">${fmtDate(t.date)}</div><div class="history-main"><div class="history-set">${t.set ? esc(t.set) : 'Draft'} <span class="mode-badge ${t.mode === 'roundrobin' ? 'rr' : 'swiss'}">${t.mode === 'roundrobin' ? 'BO1' : 'Swiss'}</span></div><div class="text-xs text-dim">🥇 ${esc(leagueName(w))} · ${t.entrants.length} giocatori</div></div><span class="history-chev" aria-hidden="true">›</span></button>`;
  }).join('')}</div>`;
}

function renderH2H() {
  const ids = eloTable().map(r => r.id);
  if (ids.length < 2) return `<div class="card text-sm text-dim">Servono almeno due giocatori con match giocati.</div>`;
  const cell = (a, b) => {
    if (a === b) return `<td class="h2h-self" aria-hidden="true"></td>`;
    const r = headToHead(a, b), n = r.w + r.l + r.d;
    if (!n) return `<td class="h2h-cell h2h-none" title="${esc(leagueName(a))} – ${esc(leagueName(b))}: mai giocato">·</td>`;
    const net = (r.w - r.l) / n, alpha = (0.12 + Math.abs(net) * 0.5).toFixed(2);
    const bg = net > 0 ? `rgba(61,107,142,${alpha})` : net < 0 ? `rgba(196,121,60,${alpha})` : 'var(--bg-input)';
    return `<td class="h2h-cell" style="background:${bg}" title="${esc(leagueName(a))} contro ${esc(leagueName(b))}: ${r.w} vinti, ${r.l} persi${r.d ? `, ${r.d} patte` : ''}">${r.w}–${r.l}${r.d ? `<small>–${r.d}</small>` : ''}</td>`;
  };
  return `<div class="card"><div class="card-title">Scontri diretti</div>
    <div class="h2h-wrap"><table class="h2h"><thead><tr><th></th>${ids.map(id => `<th scope="col" title="${esc(leagueName(id))}"><span aria-hidden="true">${leagueEmoji(id)}</span><span class="sr-only">${esc(leagueName(id))}</span></th>`).join('')}</tr></thead>
    <tbody>${ids.map(a => `<tr><th scope="row" onclick="openProfile('${a}')">${leagueEmoji(a)} ${esc(leagueName(a).split(' ')[0])}</th>${ids.map(b => cell(a, b)).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="h2h-legend text-xs text-dim"><span><i class="h2h-sw" style="background:rgba(61,107,142,.5)"></i>in vantaggio</span><span><i class="h2h-sw" style="background:var(--bg-input)"></i>pari</span><span><i class="h2h-sw" style="background:rgba(196,121,60,.5)"></i>in svantaggio</span></div>
    <div class="text-xs text-dim mt">Si legge per riga: vittorie–sconfitte del giocatore a sinistra contro quello in colonna.</div></div>`;
}

function renderRoster() {
  const list = leaguePlayers().sort((a, b) => a.name.localeCompare(b.name, 'it'));
  return `<div class="card"><div class="card-title">Giocatori</div>
    <div style="display:flex;gap:8px;" class="mb"><input type="text" id="newLeaguePlayer" placeholder="Nuovo giocatore" maxlength="40" autocomplete="off" aria-label="Nome nuovo giocatore" onkeydown="if(event.key==='Enter')addLeaguePlayer()"><button class="btn btn-primary btn-sm btn-add" onclick="addLeaguePlayer()" aria-label="Aggiungi alla lega">+</button></div>
    ${list.length ? list.map(p => { const s = playerStats(p.id); return `<button class="history-item" onclick="openProfile('${p.id}')"><span class="roster-emoji" aria-hidden="true">${esc(p.emoji || '🙂')}</span><div class="history-main"><div class="history-set">${esc(p.name)} <span class="who-titles">${leagueTitles(p.id)}</span></div><div class="text-xs text-dim">${s.tournaments ? `${s.tournaments} ${s.tournaments === 1 ? 'torneo' : 'tornei'} · Elo ${s.elo}` : 'Nessun torneo'}</div></div><span class="history-chev" aria-hidden="true">›</span></button>`; }).join('') : '<div class="text-sm text-dim">Nessun giocatore. Si aggiungono da qui o in automatico alla fine del primo torneo.</div>'}
  </div>`;
}
function addLeaguePlayer() {
  const inp = $id('newLeaguePlayer'), name = inp.value.trim();
  if (!name) return;
  if (findPlayerByName(name)) return toast('Nome già presente');
  createPlayer(name); saveLeague(); renderLeague(); toast(`${name} aggiunto alla lega`);
}

// ── Profilo ──
function eloChart(history) {
  const pts = [{ date: null, elo: ELO_START }, ...history];
  if (pts.length < 2) return '';
  const W = 320, H = 150, pl = 38, pr = 36, pt = 12, pb = 24;
  const vals = pts.map(p => p.elo);
  const lo = Math.floor((Math.min(...vals) - 10) / 25) * 25, hi = Math.ceil((Math.max(...vals) + 10) / 25) * 25;
  const x = i => pl + (i * (W - pl - pr)) / (pts.length - 1), y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const step = (W - pl - pr) / (pts.length - 1);
  const label = i => (i === 0 ? `Partenza: ${ELO_START}` : `${fmtDate(pts[i].date)}: ${Math.round(pts[i].elo)}`);
  let s = `<svg class="elo-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento Elo dopo ogni torneo">`;
  s += ticks.map(t => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pl - 6}" y="${y(t) + 3.5}" text-anchor="end" class="tick">${t}</text>`).join('');
  if (ELO_START > lo && ELO_START < hi) s += `<line x1="${pl}" x2="${W - pr}" y1="${y(ELO_START)}" y2="${y(ELO_START)}" class="base"/>`;
  s += `<polyline points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p.elo).toFixed(1)}`).join(' ')}" class="line"/>`;
  s += pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.elo).toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 3.5}" class="dot${i === pts.length - 1 ? ' last' : ''}"/>`).join('');
  const lastI = pts.length - 1;
  // Etichetta diretta solo sul punto finale, a destra del punto (lo spazio è riservato da pr)
  s += `<text x="${(x(lastI) + 8).toFixed(1)}" y="${(y(pts[lastI].elo) + 4).toFixed(1)}" class="endlabel">${Math.round(pts[lastI].elo)}</text>`;
  s += `<text x="${pl}" y="${H - 6}" class="tick">inizio</text><text x="${x(lastI)}" y="${H - 6}" text-anchor="end" class="tick">${fmtDate(pts[lastI].date)}</text>`;
  // Aree di tocco larghe quanto lo spazio tra due punti: toccando si legge il valore sopra il grafico
  const hx0 = i => Math.max(0, x(i) - step / 2), hx1 = i => Math.min(W, x(i) + step / 2);
  s += pts.map((p, i) => `<rect x="${hx0(i).toFixed(1)}" y="0" width="${(hx1(i) - hx0(i)).toFixed(1)}" height="${H - pb}" class="hit" tabindex="0" onpointerenter="eloReadout(this)" onfocus="eloReadout(this)" onclick="eloReadout(this)" data-label="${esc(label(i))}"><title>${esc(label(i))}</title></rect>`).join('');
  return `<div class="elo-readout text-xs text-dim" id="eloReadout">Tocca il grafico per i valori · ora ${Math.round(pts[lastI].elo)}</div>${s}</svg>`;
}
function eloReadout(el) { const r = $id('eloReadout'); if (r) r.textContent = el.dataset.label; }

function renderProfile(id) {
  const p = resolvePlayer(id), s = playerStats(id);
  const tiles = [['Tornei', s.tournaments], ['Vittorie', s.wins], ['Podi', s.podiums], ['Elo', s.elo]];
  let h = `<button class="btn btn-secondary btn-sm mb" onclick="closeProfile()">← Lega</button>
    <div class="card profile-head"><div class="profile-emoji" aria-hidden="true">${esc(p.emoji || '🙂')}</div><div><div class="profile-name">${esc(p.name)} <span class="who-titles">${leagueTitles(id)}</span></div>
    <div class="text-xs text-dim">${s.lastDate ? `Ultimo torneo ${fmtDate(s.lastDate)}` : 'Nessun torneo giocato'}</div></div></div>`;
  h += `<div class="stat-tiles">${tiles.map(([k, v]) => `<div class="stat-tile"><div class="stat-value">${v}</div><div class="stat-label">${k}</div></div>`).join('')}</div>`;
  if (s.tournaments) {
    const form = s.finishes.slice(-5).map(f => `<span class="form-chip${!f.dropped && f.pos <= 3 ? ' podium' : ''}" title="${fmtDate(f.date)}: ${f.pos}° su ${f.of}">${!f.dropped && f.pos <= 3 ? ['🥇', '🥈', '🥉'][f.pos - 1] : f.dropped ? '✗' : f.pos + '°'}</span>`).join('');
    h += `<div class="card"><div class="card-title">Rendimento</div>
      <div class="kv"><span>Match</span><b>${s.mW}–${s.mL}–${s.mD} · ${pct(s.matchWinPct)}</b></div>
      <div class="kv"><span>Partite (game)</span><b>${s.gW}–${s.gL}–${s.gD} · ${pct(s.gameWinPct)}</b></div>
      <div class="kv"><span>Piazzamento medio</span><b>${s.avgFinish ? s.avgFinish.toFixed(1) + '°' : '—'} · migliore ${s.bestFinish ? s.bestFinish + '°' : '—'}</b></div>
      <div class="kv"><span>Ultimi tornei</span><span class="form-row">${form}</span></div></div>`;
    if (s.eloHistory.length) h += `<div class="card"><div class="card-title">Andamento Elo</div>${eloChart(s.eloHistory)}</div>`;
    h += renderColorStats(s);
    h += renderRivals(id, s);
  }
  h += renderAchievements(s);
  if (s.tournaments) h += `<div class="card"><div class="card-title">Tornei</div>${s.finishes.slice().reverse().map(f => { const t = L.tournaments[f.tid], e = s.eloHistory.find(x => x.tid === f.tid); return `<button class="history-item" onclick="openTournament('${f.tid}')"><div class="history-date">${fmtDate(f.date)}</div><div class="history-main"><div class="history-set">${f.dropped ? 'Ritirato' : `${f.pos}° su ${f.of}`} ${pips(t && t.decks && Object.entries(t.decks).find(([k]) => canonicalId(k) === id)?.[1])}</div><div class="text-xs text-dim">${t && t.set ? esc(t.set) + ' · ' : ''}Elo ${e ? Math.round(e.elo) : '—'}</div></div><span class="history-chev" aria-hidden="true">›</span></button>`; }).join('')}</div>`;
  h += renderProfileManage(id, s);
  return h;
}
function renderColorStats(s) {
  const rows = COLORS.map(c => ({ c, ...(s.colors[c] || { decks: 0, mW: 0, mL: 0, mD: 0 }) }));
  if (!rows.some(r => r.decks)) return `<div class="card"><div class="card-title">Colori</div><div class="text-sm text-dim">Nessun mazzo registrato. Durante il torneo, in Classifica tocca un giocatore e segna i colori del mazzo.</div></div>`;
  const max = Math.max(...rows.map(r => r.decks), 1);
  const best = rows.filter(r => r.mW + r.mL + r.mD >= 3).sort((a, b) => (b.mW + b.mD / 2) / (b.mW + b.mL + b.mD) - (a.mW + a.mD / 2) / (a.mW + a.mL + a.mD))[0];
  return `<div class="card"><div class="card-title">Colori</div>${rows.map(r => { const n = r.mW + r.mL + r.mD; return `<div class="color-row"><span class="pip pip-${r.c}" aria-hidden="true">${r.c}</span><span class="color-name">${COLOR_NAMES[r.c]}</span><span class="color-bar"><i style="width:${(r.decks / max) * 100}%"></i></span><span class="color-val">${r.decks} ${r.decks === 1 ? 'mazzo' : 'mazzi'}${n ? ` · ${pct((r.mW + r.mD / 2) / n)}` : ''}</span></div>`; }).join('')}
    <div class="text-xs text-dim mt">Barra = mazzi giocati con quel colore · % = match vinti con quel colore${best ? `. Il colore che ti rende di più: <b>${COLOR_NAMES[best.c]}</b>` : ''}.</div></div>`;
}
function renderRivals(id, s) {
  const opps = Object.entries(s.opponents).map(([o, r]) => ({ id: o, ...r, n: r.w + r.l + r.d })).sort((a, b) => b.n - a.n || (b.w - b.l) - (a.w - a.l));
  if (!opps.length) return '';
  const big = (label, o, emoji) => o ? `<button class="rival-card" onclick="openProfile('${o.id}')"><div class="text-xs text-dim">${emoji} ${label}</div><div class="rival-name">${leagueEmoji(o.id)} ${esc(leagueName(o.id))}</div><div class="text-sm"><b>${o.w}–${o.l}${o.d ? '–' + o.d : ''}</b></div></button>` : `<div class="rival-card empty"><div class="text-xs text-dim">${emoji} ${label}</div><div class="text-xs text-dim mt">Servono almeno 3 match contro qualcuno</div></div>`;
  return `<div class="card"><div class="card-title">Rivalità</div><div class="rival-grid">${big('Nemesi', s.nemesis, '💀')}${big('Vittima preferita', s.victim, '🎯')}</div>
    ${opps.map(o => `<div class="kv" onclick="openProfile('${o.id}')" style="cursor:pointer;"><span>${whoHtml(o.id)}</span><b>${o.w}–${o.l}${o.d ? '–' + o.d : ''}</b></div>`).join('')}</div>`;
}
function renderAchievements(s) {
  const got = ACHIEVEMENTS.filter(a => s.achievements[a.id]).length;
  return `<div class="card"><div class="card-title">Achievement <span class="text-xs text-dim" style="font-family:inherit;font-weight:600;">${got}/${ACHIEVEMENTS.length}</span></div><div class="ach-grid">${ACHIEVEMENTS.map(a => {
    const e = s.achievements[a.id];
    return `<div class="ach${e ? '' : ' locked'}"><div class="ach-emoji" aria-hidden="true">${a.emoji}</div><div class="ach-name">${a.name}</div><div class="ach-desc">${e ? fmtDate(e.date) : a.desc}</div></div>`;
  }).join('')}</div></div>`;
}
function renderProfileManage(id, s) {
  const p = resolvePlayer(id), others = leaguePlayers().filter(o => o.id !== id).sort((a, b) => a.name.localeCompare(b.name, 'it'));
  return `<details class="card manage"><summary class="card-title" style="margin:0;">Gestisci profilo</summary>
    <div class="mt"><label class="field-label" for="renameInp">Nome</label><div style="display:flex;gap:8px;"><input type="text" id="renameInp" value="${esc(p.name)}" maxlength="40"><button class="btn btn-secondary btn-sm" style="width:auto;" onclick="renamePlayer('${id}')">Salva</button></div></div>
    <div class="mt"><div class="field-label">Avatar</div><div class="emoji-grid">${PLAYER_EMOJIS.map(e => `<button class="emoji-btn${e === p.emoji ? ' active' : ''}" onclick="setPlayerEmoji('${id}','${e}')" aria-label="Avatar ${e}">${e}</button>`).join('')}</div></div>
    ${others.length ? `<div class="mt"><label class="field-label" for="mergeSel">Profilo doppio? Uniscilo a un altro</label><div style="display:flex;gap:8px;"><select id="mergeSel"><option value="">Scegli…</option>${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select><button class="btn btn-secondary btn-sm" style="width:auto;" onclick="confirmMerge('${id}')">Unisci</button></div></div>` : ''}
    ${s.tournaments ? '' : `<button class="btn btn-danger btn-sm mt" onclick="confirmDeletePlayer('${id}')">Elimina giocatore</button>`}
  </details>`;
}
function renamePlayer(id) {
  const name = $id('renameInp').value.trim(); if (!name) return;
  const clash = findPlayerByName(name); if (clash && clash.id !== id) return toast('Nome già usato: se è la stessa persona usa "Unisci"');
  updatePlayer(id, { name }); renderLeague(); toast('Nome aggiornato');
}
function setPlayerEmoji(id, e) { updatePlayer(id, { emoji: e }); renderLeague(); }
function confirmMerge(id) {
  const into = $id('mergeSel').value; if (!into) return;
  requireMaster(() => showModal(`Unire ${leagueName(id)} a ${leagueName(into)}?`, `Tutti i tornei di "${leagueName(id)}" verranno contati per "${leagueName(into)}". Il profilo "${leagueName(id)}" sparisce dalla lega.`, () => { mergePlayers(id, into); LUI.profile = canonicalId(into); renderLeague(); toast('Profili uniti'); }));
}
function confirmDeletePlayer(id) { requireMaster(() => showModal(`Eliminare ${leagueName(id)}?`, 'Non ha tornei archiviati: sparisce dalla lista dei giocatori abituali.', () => { updatePlayer(id, { deleted: true }); LUI.profile = null; renderLeague(); })); }

// ── Dettaglio torneo archiviato ──
function openTournament(tid) {
  const t = L.tournaments[tid]; if (!t) return;
  const ranked = rankedIds(t), dropped = new Set(t.dropped || []);
  const rec = id => { let w = 0, l = 0, d = 0; for (const r of t.rounds) for (const m of r) { if (m.rest || m.p1wins == null) continue; if (m.bye && m.p1 === id) { w++; continue; } if (m.p1 !== id && m.p2 !== id) continue; const mine = m.p1 === id ? m.p1wins : m.p2wins, th = m.p1 === id ? m.p2wins : m.p1wins; if (mine > th) w++; else if (mine < th) l++; else d++; } return t.mode === 'roundrobin' ? `${w}-${l}` : `${w}-${l}-${d}`; };
  const name = id => esc(t.names && t.names[id] ? t.names[id] : leagueName(id));
  const deckEdit = id => `<span class="deck-edit">${COLORS.map(c => `<button class="pip pip-${c}${(t.decks[id] || '').includes(c) ? '' : ' off'}" onclick="toggleArchivedDeck('${t.id}','${id}','${c}')" aria-pressed="${(t.decks[id] || '').includes(c)}" aria-label="${COLOR_NAMES[c]}">${c}</button>`).join('')}</span>`;
  t.decks = t.decks || {};
  const standings = ranked.map((id, i) => `<div class="td-row"><span class="td-pos">${dropped.has(id) ? '✗' : i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><span class="td-name">${leagueEmoji(id)} ${name(id)}</span><span class="td-rec">${rec(id)}</span></div><div class="td-deck">${deckEdit(id)}</div>`).join('');
  const rounds = t.rounds.map((r, ri) => `<details class="td-round"><summary>Round ${ri + 1}</summary>${r.map(m => m.rest ? `<div class="td-match text-dim">${name(m.p1)} riposa</div>` : m.bye ? `<div class="td-match">${name(m.p1)} — bye</div>` : `<div class="td-match"><span>${name(m.p1)} vs ${name(m.p2)}</span><b>${m.p1wins == null ? '—' : m.forfeit ? 'forfeit' : t.mode === 'roundrobin' ? (m.p1wins > m.p2wins ? name(m.p1).split(' ')[0] : name(m.p2).split(' ')[0]) : `${m.p1wins}–${m.p2wins}${m.draws ? '–' + m.draws : ''}`}</b></div>`).join('')}</details>`).join('');
  showModalCustom(`${fmtDate(t.date)} · ${t.set || 'Draft'}`, `${t.mode === 'roundrobin' ? 'Round robin BO1' : 'Swiss'} · ${t.entrants.length} giocatori`,
    `<div class="td-list">${standings}</div><div class="text-xs text-dim mt">Tocca i colori per correggere i mazzi.</div>
    <div class="mt">${rounds}</div>
    <div class="mt"><label class="field-label" for="tdSet">Set / cube</label><div style="display:flex;gap:8px;"><input type="text" id="tdSet" value="${esc(t.set || '')}" maxlength="40"><button class="btn btn-secondary btn-sm" style="width:auto;" onclick="saveTournamentSet('${t.id}')">Salva</button></div></div>
    <div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="closeModal()">Chiudi</button><button class="btn btn-danger btn-sm" onclick="confirmDeleteTournament('${t.id}')">Elimina</button></div>`);
}
function toggleArchivedDeck(tid, id, c) {
  const t = L.tournaments[tid], cur = (t.decks && t.decks[id]) || '';
  const next = COLORS.filter(x => (x === c ? !cur.includes(x) : cur.includes(x))).join('');
  updateTournament(tid, { decks: { ...(t.decks || {}), [id]: next } });
  openTournament(tid); if ($id('screen-league').classList.contains('active')) renderLeague();
}
function saveTournamentSet(tid) { updateTournament(tid, { set: $id('tdSet').value.trim() }); closeModal(); renderLeague(); toast('Torneo aggiornato'); }
function confirmDeleteTournament(tid) {
  const t = L.tournaments[tid];
  requireMaster(() => showModal('Eliminare il torneo?', `${fmtDate(t.date)} · ${t.set || 'Draft'}: esce da campionato, Elo e statistiche. Si può ripristinare da Dati e sync → Avanzate.`, () => { deleteTournament(tid); if (clearDeletedTournament('Torneo eliminato')) return; renderLeague(); toast('Torneo eliminato'); }));
}

// ── Dati e sync ──
function renderSyncBox() {
  const box = $id('syncBox'); if (!box || !box.classList) return;
  let h = '<div class="card-title">Dati e sync</div>';
  if (syncConfigured()) {
    const when = syncState.lastSync ? new Date(syncState.lastSync).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
    const status = syncState.running ? 'Sincronizzazione…' : syncState.error ? `⚠️ ${esc(syncState.error)}` : when ? `Sincronizzato alle ${when}` : 'In attesa';
    const canWrite = syncCanWrite(), liveOn = canWrite && syncCfg.live !== false;
    h += `<div class="kv"><span>Lega</span><b>${esc(syncCfg.name || (isDefaultLeague() ? 'La nostra lega' : syncCfg.league.slice(0, 8)))}</b></div>
      <div class="kv"><span>Accesso</span><b>${canWrite ? '✏️ Lettura e scrittura' : '👁️ Sola lettura'}</b></div>
      <div class="kv"><span>Stato</span><b>${status}</b></div>`;
    if (canWrite) {
      h += `<div class="kv"><span>Torneo in diretta</span><b>${liveOn ? (live.pubError ? `⚠️ ${esc(live.pubError)}` : T.started && T.id && liveSh().detached ? '📴 Torneo solo su questo telefono' : '🔴 Attivo') : 'Disattivato'}</b></div>
        ${masterOn() ? '<div class="kv"><span>Modalità master</span><b>🔑 Attiva</b></div>' : ''}
        <div class="btn-row"><button class="btn btn-primary btn-sm" onclick="syncNow(true)">Sincronizza</button><button class="btn btn-secondary btn-sm" onclick="setLivePublish(${!liveOn})">${liveOn ? 'Disattiva live' : 'Attiva live'}</button></div>`;
    } else {
      h += `<div class="text-xs text-dim" style="line-height:1.55;">Per registrare i tornei nella lega (e trasmetterli in diretta) serve il PIN. Per seguire basta così.${L.dirty.length ? ` ${L.dirty.length} modifiche restano solo su questo telefono finché non inserisci il PIN.` : ''}</div>
        <div class="btn-row"><button class="btn btn-primary btn-sm" onclick="openPinForm()">Inserisci PIN</button><button class="btn btn-secondary btn-sm" onclick="syncNow(true)">Aggiorna</button></div>`;
    }
    const nDel = deletedTournaments().length;
    h += `<details class="sync-adv"><summary>Avanzate</summary>
      <div class="btn-row wrap">${canWrite ? (masterOn() ? '<button class="btn btn-secondary btn-sm" onclick="exitMaster()">Esci da master</button>' : '<button class="btn btn-secondary btn-sm" onclick="openMasterForm()">🔑 PIN master</button>') : ''}
      <button class="btn btn-secondary btn-sm" onclick="openHistory()">🕘 Cronologia live</button>
      ${nDel ? `<button class="btn btn-secondary btn-sm" onclick="openDeletedTournaments()">🗑️ Eliminati (${nDel})</button>` : ''}</div>
      <div class="btn-row">
      ${canWrite ? `<button class="btn btn-secondary btn-sm" onclick="confirmRemovePin()">Togli PIN</button>` : ''}
      <button class="btn btn-secondary btn-sm" onclick="openSyncForm()">Altra lega</button>
      <button class="btn btn-secondary btn-sm" onclick="confirmDisconnect()">Scollega</button></div>
      ${!isDefaultLeague() ? `<div class="btn-row">${defaultLeague() ? `<button class="btn btn-secondary btn-sm" onclick="switchToDefaultLeague()">Lega predefinita</button>` : ''}<button class="btn btn-secondary btn-sm" onclick="copyText(syncInviteLink(),'Link invito copiato')">Link invito</button></div>` : ''}
    </details>`;
  } else {
    h += `<div class="text-sm text-dim" style="line-height:1.55;">Sincronizzazione spenta: i dati della lega stanno solo su questo telefono.</div>
      <button class="btn btn-secondary btn-sm mt" style="width:100%;" onclick="${defaultLeague() ? 'switchToDefaultLeague()' : 'openSyncForm()'}">${defaultLeague() ? 'Ricollega alla lega' : 'Collega Supabase'}</button>`;
  }
  h += `<div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="exportLeague()">Esporta backup</button><button class="btn btn-secondary btn-sm" onclick="$id('importFile').click()">Importa</button></div>`;
  box.innerHTML = h;
}
function openPinForm() {
  showModalCustom('Inserisci il PIN', 'Serve solo a chi registra i tornei: lo inserisci una volta su questo telefono.',
    `<input type="password" id="pinInp" autocomplete="off" aria-label="PIN della lega" onkeydown="if(event.key==='Enter')savePinForm()">
    <div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="closeModal()">Annulla</button><button class="btn btn-primary btn-sm" id="pinSaveBtn" onclick="savePinForm()">Conferma</button></div>`);
}
async function savePinForm() {
  const pin = $id('pinInp').value, btn = $id('pinSaveBtn');
  if (!pin) return;
  btn.disabled = true; btn.textContent = 'Verifica…';
  try {
    await verifyPin(pin);
    syncCfg.pin = pin; saveSyncCfg(); closeModal(); renderSyncBox();
    toast('PIN corretto: ora puoi registrare i tornei');
    await syncNow(false); renderSyncBox();
    liveResume();
  } catch (e) {
    toast(e.message || 'Verifica non riuscita');
    btn.disabled = false; btn.textContent = 'Conferma';
  }
}
function confirmRemovePin() { showModal('Togliere il PIN?', 'Questo telefono resta collegato in sola lettura.', () => { if (livePublishEnabled()) liveStop(); syncCfg.pin = ''; syncCfg.adminPin = ''; saveSyncCfg(); renderSyncBox(); }); }
function switchToDefaultLeague() { stopLive(); reconnectDefault(); startLive(); renderSyncBox(); syncNow(true); }
function openSyncForm() {
  const c = syncCfg && !isDefaultLeague() ? syncCfg : {};
  showModalCustom('Collega un\'altra lega', 'URL e chiave pubblica sono in Project Settings → API del progetto Supabase; id lega e PIN li crei con supabase/schema.sql.',
    `<label class="field-label" for="sbUrl">Project URL</label><input type="url" id="sbUrl" value="${esc(c.url || '')}" placeholder="https://xxxx.supabase.co" autocomplete="off">
    <label class="field-label mt" for="sbKey">Chiave pubblica (anon / publishable)</label><input type="text" id="sbKey" value="${esc(c.key || '')}" autocomplete="off">
    <label class="field-label mt" for="sbLeague">Id lega</label><input type="text" id="sbLeague" value="${esc(c.league || '')}" autocomplete="off">
    <label class="field-label mt" for="sbName">Nome lega (facoltativo)</label><input type="text" id="sbName" value="${esc(c.name || '')}" maxlength="40">
    <label class="field-label mt" for="sbPin">PIN (vuoto = sola lettura)</label><input type="password" id="sbPin" value="" autocomplete="off">
    <div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="closeModal()">Annulla</button><button class="btn btn-primary btn-sm" onclick="saveSyncForm()">Collega</button></div>`);
}
function saveSyncForm() {
  const url = $id('sbUrl').value.trim(), key = $id('sbKey').value.trim(), league = $id('sbLeague').value.trim();
  if (!/^https:\/\/.+/.test(url) || !key || !/^[0-9a-f-]{36}$/i.test(league)) return toast('Controlla URL, chiave e id lega');
  stopLive();
  configureSync({ url, key, league, pin: $id('sbPin').value, name: $id('sbName').value.trim() });
  startLive(); closeModal(); renderSyncBox(); syncNow(true);
}
function confirmDisconnect() { showModal('Scollegare la sincronizzazione?', 'I dati restano su questo telefono; smette solo la sincronizzazione (anche il torneo in diretta).', () => { disconnectSync(); renderSyncBox(); }); }

function exportLeague() {
  const data = { format: 'mtg-draft-league', version: 1, exportedAt: new Date().toISOString(), players: L.players, tournaments: L.tournaments };
  const json = JSON.stringify(data, null, 1), fname = `mtg-lega-${isoDate()}.json`;
  try {
    const file = new File([json], fname, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Backup lega MTG' }).catch(() => {}); return; }
  } catch (e) {}
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importLeagueText(text) {
  const d = JSON.parse(text);
  if (!d || d.format !== 'mtg-draft-league') throw new Error('Non è un backup della lega');
  const docs = [...Object.values(d.players || {}).map(data => ({ kind: 'player', data })), ...Object.values(d.tournaments || {}).map(data => ({ kind: 'tournament', data }))];
  return mergeLeagueDocs(docs, true);
}
function importLeagueFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  f.text().then(txt => { const n = importLeagueText(txt); toast(n ? `Importati ${n} elementi` : 'Niente di nuovo da importare'); renderLeague(); })
    .catch(e => toast(e.message || 'File non valido')).finally(() => { input.value = ''; });
}

// ── Agganci nel torneo ──
// Setup: giocatori abituali da toccare invece di scrivere i nomi
function renderRosterChips() {
  const el = $id('rosterChips'); if (!el) return;
  if (T.started) { el.innerHTML = ''; return; }
  const inT = new Set(T.players.map(p => tournamentLid(p)).filter(Boolean));
  const stats = leagueStats().players;
  const list = leaguePlayers().filter(p => !inT.has(p.id))
    .sort((a, b) => ((stats.get(b.id) || {}).lastDate || '').localeCompare((stats.get(a.id) || {}).lastDate || '') || a.name.localeCompare(b.name, 'it'));
  el.innerHTML = list.length ? `<div class="text-xs text-dim mt mb">Giocatori abituali</div><div class="chips">${list.map(p => `<button class="chip" onclick="addRosterPlayer('${p.id}')">${esc(p.emoji || '🙂')} ${esc(p.name)}</button>`).join('')}</div>` : '';
}
function addRosterPlayer(lid) {
  const lp = resolvePlayer(lid); if (!lp) return;
  if (T.players.length >= 16) return toast('Massimo 16 giocatori');
  if (T.players.some(p => p.name.toLowerCase() === lp.name.toLowerCase())) return toast('Nome già presente');
  T.players.push({ id: ++playerIdCounter, name: lp.name, leagueId: lp.id, dropped: false, droppedAtRound: null });
  syncDraftOrder(); renderPlayerList(); save();
}
// Annuncio pairing: precedenti e pronostico Elo
function rivalryHtml(p1, p2) {
  const a = tournamentLid(p1), b = tournamentLid(p2);
  if (!a || !b) return '';
  const r = headToHead(a, b), n = r.w + r.l + r.d, sa = playerStats(a), sb = playerStats(b);
  let out = n ? `Precedenti ${r.w}–${r.l}${r.d ? '–' + r.d : ''}` : 'Primo scontro';
  if (sa.tournaments && sb.tournaments) { const e = eloExpected(sa.elo, sb.elo); out += ` · pronostico ${Math.round(e * 100)}%–${Math.round((1 - e) * 100)}%`; }
  return `<div class="announce-rivalry">${out}</div>`;
}
// Vittoria dello sfavorito (pronostico Elo sotto il 30%)
function checkUpset(m) {
  if (m.p1wins == null || m.p1wins === m.p2wins || !m.p2) return false;
  const w = P(m.p1wins > m.p2wins ? m.p1 : m.p2), l = P(m.p1wins > m.p2wins ? m.p2 : m.p1);
  const a = tournamentLid(w), b = tournamentLid(l);
  if (!a || !b || !playerStats(a).tournaments || !playerStats(b).tournaments) return false;
  return eloExpected(playerStats(a).elo, playerStats(b).elo) < 0.3;
}
// Colori del mazzo nel torneo corrente (dalla classifica); se il torneo è già archiviato aggiorna anche l'archivio
function deckPickerHtml(pid) {
  const cur = (T.decks && T.decks[pid]) || '';
  return `<div class="deck-picker"><span class="text-xs text-dim">Mazzo</span>${COLORS.map(c => `<button class="pip pip-${c}${cur.includes(c) ? '' : ' off'}" onclick="event.stopPropagation();toggleDeckColor(${pid},'${c}')" aria-pressed="${cur.includes(c)}" aria-label="${COLOR_NAMES[c]}">${c}</button>`).join('')}</div>`;
}
function toggleDeckColor(pid, c) {
  const cur = (T.decks && T.decks[pid]) || '';
  doOp({ t: 'deck', pid, colors: COLORS.filter(x => (x === c ? !cur.includes(x) : cur.includes(x))).join('') });
  if (T.archivedId && L.tournaments[T.archivedId]) {
    const p = P(pid), lid = p && p.leagueId, t = L.tournaments[T.archivedId];
    if (lid) updateTournament(T.archivedId, { decks: { ...(t.decks || {}), [lid]: T.decks[pid] } });
  }
  save(); renderStandings();
}
