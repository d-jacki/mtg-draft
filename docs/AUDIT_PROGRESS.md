\# Tournament Manager — Audit \& Fix Progress



\## Status snapshot (last updated: 2026-05-16)



\- Phase 1: HIGH-severity fixes → PR #1 (awaiting merge)

\- Phase 2: A11y bundle → PR #2 (approved, stacked on PR #1,

&#x20; needs retarget to master after #1 merges)

\- Phase 3: Score input completeness → NOT STARTED, decision

&#x20; made (Option A — draws=1)



\## Decisions taken



\- \*\*ID encoding\*\*: Option A (draws=1). Rationale: aligns

&#x20; with Eventlink/Companion (live WotC software), keeps GW%

&#x20; denominator honest, consistent with MTR "unplayed games

&#x20; = 0 points".

\- \*\*Local file mtg-tournament.html\*\*: renamed to

&#x20; mtg-tournament.html.bak. PWA (pwa/index.html) is the

&#x20; source of truth.

\- \*\*Scenario 5 (circular H2H) correction\*\*: original audit

&#x20; expected MTR tiebreakers to separate A>B>C>A. They

&#x20; cannot — by symmetry MP/OMW%/GW%/OGW% are identical.

&#x20; Stable insertion-order tiebreak is the correct strict-MTR

&#x20; outcome. Implemented as such.



\## Phase 1 commits (PR #1)



1\. da31933 — Swiss drop auto-forfeits open current-round

&#x20;  match (2-0 against the dropped player)

2\. 0e40cc5 — Timer wall-clock fix: TM.startedAt =

&#x20;  Date.now() - TM.seconds\*1000; tick reads from Date.now;

&#x20;  latched expiry notifications (firedExpired,

&#x20;  firedOvertime)

3\. c9836a5 — RR uses MTR tiebreakers (MP → OMW% → GW% →

&#x20;  OGW%); dropped getRRRecord, rrH2H, getRRStandings;

&#x20;  sw.js cache v8 → v9



\## Phase 2 commits (PR #2)



1\. ba28959 — viewport user-scalable=no removed; --text-dim

&#x20;  #9c9388 → #756a5f (4.68:1 AA); 44×44 touch targets;

&#x20;  labels/aria-label; scrollTo(0,0) on tab switch;

&#x20;  touch-action: manipulation

2\. 91d4158 — modal role="dialog", aria-modal,

&#x20;  aria-labelledby/aria-describedby; focus-trap; Escape

&#x20;  close; focus capture/restore; sw.js cache v9 → v10

3\. 7b71c32 — before/after screenshots in docs/screenshots/



\## Phase 3 — TODO



Branch: feat/complete-score-inputs (not yet created)



Add six new time-out result buttons:

\- 1-0    (won g1, no game 2)

\- 0-1    (lost g1, no game 2)

\- 1-1    (one win each, no game 3, match draw)

\- 1-0-1  (won g1, g2 timed draw)

\- 0-1-1  (lost g1, g2 timed draw)

\- 0-0-1  (single drawn game, match draw)



Plus:

\- "More results…" affordance (link/chevron) to avoid

&#x20; crowding default mobile UI

\- ID button writes (0, 0, 1) instead of (0, 0, 3)

\- Each option must write (wins, losses, draws) triples

&#x20; that sum to actual games played (1, 2, or 3) — never

&#x20; pad with phantom draws



Verification: run audit scenario 3 (R1 win 2-0, R2 ID,

R3 loss 0-2) and confirm GW% ≈ 77.8% (not 60%).



\## Out of scope — to open as GitHub issues



LOW/MED items not blocking, to track separately:

\- Lower n<4 threshold (needs degenerate small-N

&#x20; discussion first)

\- Last-round standings-sort branch (decide intentionally

&#x20; or remove)

\- R1 cross-table pairing (document or add "Randomize R1"

&#x20; toggle)

\- Editing past Swiss rounds (judge-override gated modal)

\- sw.js cache: restrict to same-origin, consider SWR

\- pushState / back button handling

\- maxlength="40" on player name + text-overflow ellipsis

\- Guard throw on generateAllRRRounds for even N

\- Dead fallback path in pairPool (document or remove)



\## Full audit findings



See conversation history with Claude (Anthropic chat) on

2026-05-16, or rerun the audit prompt against the current

HEAD if needed.



\## How to resume



1\. Check merge status of PR #1 and PR #2

2\. If both merged, paste the "Resume prompt" below into a

&#x20;  fresh Claude Code session at the repo root

3\. If only PR #1 merged, retarget PR #2 to master first



\## Resume prompt for Claude Code



> Read docs/AUDIT\_PROGRESS.md. Confirm current state by

> checking git log on master and the status of any open

> PRs. Then begin Phase 3 as specified in the TODO

> section: Option A for ID encoding (draws=1), six new

> time-out result buttons with "More results…"

> affordance. Follow the same workflow as Phases 1 and 2:

> branch feat/complete-score-inputs, focused commits, PR

> with manual scenario 3 verification result in the body.

> Do not modify out-of-scope items — open GitHub issues

> for them instead. Stop and wait for review after the PR

> is opened.

