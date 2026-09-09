# Session Activity panel redesign

> Status: implemented and verified; awaiting user review before plan retirement.
> Codex follow-up (2026-09-09): the adapter now correlates calls and replies for
> the same history UI. Real rollout structure establishes a closing usage marker
> followed by a matching token-count receipt; fixture-only ordering is not
> authority. Live and historical request IDs now agree. Completed-message mirrors
> deduplicate, and history-only ownership markers no longer block strict ordinary
> hydration. Tests cover full 350-request history, actor isolation, malformed or
> missing usage, ambiguous groups, duplicate records, privacy, and publication.
> Preserve null for unsupported or incomplete associations. Verified in the running
> Codex dashboard: #800 loads its reply page, #801 highlights its tool-call row,
> and request-only filtering shows that single linked event. Final npm test passed
> (1,105 Node tests, 655 UI tests, one Node skip, plugin checks and build), and
> verify:fast passed. Retain the plan and mockups for user review.
> Implementation checkpoint (2026-09-09): complete provider replay, disk-indexed
> committed history API, durable numbering, request-window navigation, eight-row
> Activity paging, adjacent-page prefetch, filtering, and live anchors are built.
> Runtime contracts are updated in DESIGN.md, docs/METRICS.md, and
> docs/OBSERVATION_CACHE.md. Full npm test passed (1,100 Node tests, 653 UI tests,
> one Node skip), and verify:fast passed before the final live corrections.
> Live verification found complete Claude replay reused a warmed bounded cache;
> the correction bypasses that cache, preserves private actor ownership until
> normalization, and rejects replay when source fingerprints change. The >2 MiB
> warm-cache regression and generation-pruning tests pass (8 focused tests).
> Final verification: the reported session serves 182 requests and 260 activity
> events. All 52 assistant replies now have recorded links. Request #73 reveals
> and highlights its reply; the 12:14:02 p.m. reply now shows #136, beside the
> 12:14:46 p.m. reply's unchanged #28. At 390 px, selecting #136 opens Activity
> page 24 and highlights both linked rows with no horizontal overflow. Clicking
> that reply while its request is outside the chart loads and selects its window.
> Request-only filtering was verified on desktop. Slow navigation now completes
> before polling, and hydration retries preserve the requested target. Regression
> coverage includes both retry races and cross-page navigation with label gaps.
> Final npm test passed: 1,101 Node tests, 655 UI tests, one Node skip; plugin
> checks and build passed. verify:fast passed. The independent development
> terminal is PID 30448, parent Explorer, outside a Windows job; both listeners
> descend from it and both state endpoints return 200. Preserve the unrelated
> monitor/providers/claude-usage-limits.mjs changes. No commit has been made.
> Remaining: user review only; retain this plan and mockups until explicit approval.
> Review hold: restored on 2026-09-09 at the user's request. Keep this plan until
> the user explicitly approves deletion, overriding the retirement instruction below.
> Approved follow-up: eight visible activity rows, current/previous/next page
> prefetch, complete normalized history with paged serving, stable request numbers,
> cross-page request/activity selection, request-only filtering, and live anchors.
> This supersedes the 200-event/100-request display restrictions below. Normal
> summary/cache metrics retain their existing bounds; the history surface is separate.
> Implementation owners: provider history replay, committed history persistence
> and API, request-window selection, and Activity pagination. Review must verify
> old reply links beyond both previous cutoffs, privacy, restart numbering,
> cache-only GETs, stale-response handling, desktop and phone behavior.
> Review finding: the initial parser kept tool IDs only from the final fragment
> of a streamed Claude request. This dropped 26 subagent tool-call links in the
> reported session. The correction merges distinct recorded IDs across fragments
> and keeps request-local usage as the latest snapshot. Re-reading that session
> with the correction links all 128 retained tool calls. Both running API endpoints
> now serve 128 linked tool-call rows after restart. Build, full tests, and
> `verify:fast` passed; streamed-fragment regression tests cover live and historical
> projection. In the running dashboard, selecting request #29 highlights all four
> Read rows on page 7, including the three previously lost links.
> User correction: selecting a request must automatically reveal its Activity
> page. Reselecting the same bar must return there after manual paging; a hidden
> agent scope must reveal All agents. Background updates preserve page anchors.
> Verified in the running dashboard: clicking request #29 opens page 7 and
> highlights all four Read rows without a page-link click. Reclick after paging
> away and selection from Primary-only scope also return to those rows.
> `npm test` (including build; 645 UI tests) and `verify:fast` passed after this
> change. Focused navigation coverage also includes phone layout and live anchors.
> User correction: request #73 is a reply-only request and must show #73 on its
> Assistant replied row. The original tool-call-only rule below was too narrow.
> Assistant replies now link by exact recorded request identity within their
> owning agent. User input, system notifications, and unmatched events remain
> unlinked; timestamp proximity never establishes a request association.
> Verified after rehydration: both running API endpoints link request #73 to its
> Assistant replied event. Clicking its chart bar automatically opens Activity
> page 4, displays #73 on the reply row, and highlights it. The session now has
> 33 linked replies; 19 older replies have no request in the served snapshot feed.
> Full tests passed (646 UI tests); focused tests cover reply-only requests,
> fragments with different timestamps, subagent ownership, missing usage,
> identity validation, and private-index stripping.
> Final build and `verify:fast` also passed. Review the running #73 selection
> together before approving deletion; the restored mockups remain in place.
> Next step: review the restored plan and behavior with the user; delete the plan
> and mockups only after explicit approval.
> Owner: session dashboard (monitor projection + `app/components/dashboard`).
> Mockups: static HTML exports in [`session-activity-panel/`](session-activity-panel/),
> open them in a browser (dark theme, sample data, Google Fonts for Inter and
> Geist Mono):
> - [`evidence-region-desktop.html`](session-activity-panel/evidence-region-desktop.html)
>   — the authoritative desktop composition: Requests & actions with request
>   `#142` selected, then Activity with its rows highlighted.
> - [`evidence-region-phone.html`](session-activity-panel/evidence-region-phone.html)
>   — the same at 390 px, breakdown folded.
> - [`activity-desktop.html`](session-activity-panel/activity-desktop.html) and
>   [`activity-phone.html`](session-activity-panel/activity-phone.html) — the
>   Activity panel alone, unselected state, breakdown rail expanded.
>
> Source canvas (owner access only): Claude Design “Session Activity Panel”,
> https://claude.ai/code/artifact/1be067bb-ab37-4c98-aec7-bb72e504578c.
> Where the exports and this text disagree, this text wins; the exports use
> literal hex values that map to the tokens named below.
> Delete this plan in the change that ships it, after moving enduring rules into
> `docs/METRICS.md`, `docs/OBSERVATION_CACHE.md`, and `DESIGN.md`.

## Reading the exports

The mockups are hand-written HTML with inline styles and literal dark-theme
values. Map them to tokens; never copy the hex into `app/styles/`.

| Export value | Token |
| --- | --- |
| `#111315` canvas, `#191c20` panel, `#23272d` raised, `#1d2126` hover | `--color-canvas`, `--color-panel`, `--color-raised`, `color-mix(var(--command-ink) 6%)` hover |
| `#edf0f3` text, `#a8afb9` muted, `#333941` line, `#697482` control | `--color-text`, `--color-muted`, `--color-line`, `--color-control` |
| `#e58b80` brand, `#91c5a4` green, `#e3b575` amber, `#bbb3d3` lavender | `--color-brand-text`, `--color-green`, `--color-amber`, `--color-context` |
| `#f09a9f` red, `#39272b` red-soft | `--color-error`, `--color-error-soft` |
| Inter / Geist Mono | `--font-ui` / `--font-data` |
| 11 / 12 / 13 / 16 px | `--text-caption` / `--text-xs` / `--text-sm` / `--text-heading` |
| 4 px / 6 px radii | `--control-radius` / `--panel-radius` |
| Inline buttons styled as secondary, segmented, quiet, text link | `.commandSecondaryAction`, `.commandSegmented`, `.commandQuietAction`, `.commandTextLink` |
| Inline chips | `.agentChip` |
| Inline SVG icons | `WorkKindIcon` |

The Requests & actions chart in the evidence exports is a sketch with
generated bars; keep the real `RequestBarsChart`. Only the request detail chip
line and the merged caveat change there.

## Goal

Replace the “Recent activity” list (12 rows, no paging, buried in the Session
details disclosure) with an Activity panel that:

1. Breaks tool calls down by work kind for the whole session.
2. Pages through the full retained feed instead of capping at 12.
3. Shows each action's wall-time duration.
4. Links every tool-call row to the model request that issued it, sharing one
   selection with Requests & actions.
5. Stays readable on phones.

Everything is read-only evidence. No token cost per action, no filter mode, no
new heuristics.

## What exists today (do not duplicate)

| Surface | File | Reuse |
| --- | --- | --- |
| Activity list | `app/components/dashboard/ActivityPanel.tsx`, CSS in `app/styles/evidence.css` (`.activityTable`, `.activityRow`) | Replace in place. |
| Activity projection | `monitor/session-projection.mjs` → `recentActivityEvents(allEvents)` in `monitor/activity-events.mjs` (browser gets newest 30) | Raise bound, add fields. |
| Work-kind list | `app/components/agents/AgentsModelPanels.tsx` “Observed work” (`.workRow`, `.workBar` in `AgentsView.module.css`), labels in `app/components/agents/agent-presentation.ts` (`WORK_LABELS`) | Same row anatomy and labels for the new breakdown rail. |
| Work-kind icons | `app/components/WorkKindIcon.tsx` | Reuse as is. |
| Request ↔ tool-call link | `monitor/providers/claude-context.mjs` (`structuredToolUseIds`, `issuedWork` with `recorded_link`), `monitor/request-snapshots.mjs` | Source of the request ID for each activity event. |
| Request selection | `app/components/dashboard/requests-actions/useRequestSelection.ts` (follow-latest, pinning, windowing) | Lift to Dashboard; keep rules unchanged. |
| Pagination controls | `.commandSecondaryAction` Previous / page numbers (`aria-current="page"`) / Next, documented in `DESIGN.md` | Reuse verbatim. |
| Disclosure rows | `app/components/dashboard/DashboardDisclosurePanel.tsx` | Phone breakdown fold. |

## Contract changes (`shared/monitor-contract.ts`)

```ts
export type Activity = {
  id: string;
  timestamp: string;
  actor: string;
  tool: string;
  workKind: WorkKind;
  detail: string;
  status: "failed" | null;
  /** Wall time from the tool call to its recorded result, ms. null while running or when no result was recorded. */
  durationMs: number | null;
  /** Opaque request-snapshot id linked to this tool call or assistant reply; null for user input and unmatched events. */
  requestId: string | null;
};

export type ActivityFeed = {
  items: Activity[];            // newest first, bounded
  total: number;                // count of retained events for the session, for “N events”
  toolCalls: number;            // events that are tool calls (excludes messages/input/failed-shell duplicates)
  byKind: Array<{ kind: WorkKind; count: number; medianDurationMs: number | null }>;
  messages: number;             // message + user-input events
  failed: number;               // failed shell events
};
```

`MonitorState.activity` becomes `ActivityFeed`. Keep `Activity[]` shape inside
`items` so existing consumers (session report, tests) change minimally.

Privacy: `durationMs` and `requestId` carry no content. `requestId` must be the
same opaque `RequestSnapshot.id` already served to the browser; never a provider
message id. `byKind` uses only the bounded `WorkKind` enum.

## Monitor work

1. **Duration.** In the Claude adapter, pair each `tool_use` block id with the
   later `tool_result` record carrying the same `tool_use_id`; duration is the
   difference of the two record timestamps. Codex pairs `function_call` /
   `custom_tool_call` with their `*_output` records by `call_id`
   (`monitor/providers/codex-activity-events.mjs`). Shell execution tasks already
   have `startedAt`/`finishedAt`; use them for failed-shell events. No result
   yet → `null`. Cap at a sane maximum (24 h) and never negative.
2. **Request link.** `claude-context.mjs` already resolves which request issued
   which `tool_use` ids. Emit that mapping (`toolUseId → snapshotId`) alongside
   the snapshot feed, and stamp `requestId` on activity events in
   `session-projection.mjs`. Codex: same mapping from the turn that issued the
   call, if the snapshot builder exposes it; otherwise `null` and the feature
   degrades per provider.
   Claude assistant replies also link through their exact recorded request
   identity within the owning agent, including requests that issue no tools.
   Strip private correlation indexes before evidence and checkpoints; only
   served opaque snapshot IDs reach Activity. Missing usage or identity leaves
   the reply unlinked. Never match by timestamp proximity.
3. **Aggregates.** Compute `byKind`, `toolCalls`, `messages`, `failed`, `total`
   over the full retained event set (not the served window). Median duration per
   kind over resolved durations only.
4. **Bound.** Raise the served window in `recentActivityEvents` from 30 to 200
   (10 pages of 20). The upstream retention stays as documented (Claude 256,
   Codex 4,096 merged). Record the new bound in `docs/OBSERVATION_CACHE.md`.
5. **Checkpoints.** New fields are contract-valid normalized evidence and may be
   persisted; verify `tests/session-observation-checkpoints.test.mjs` round-trips
   them.

## Dashboard work

### Page order

In `app/Dashboard.tsx`, render the Activity panel directly after
`RequestsActionsPanel` (and its Cache evidence disclosure), before
`SessionSummaryCards`. Remove `ActivityPanel` from `SessionDetailsPanel`.
Session details keeps flow score, plugin, cost, usage limits, machinery.

### Shared selection

Lift `useRequestSelection` state (selected id, window start, scope) into a
small hook owned by Dashboard and pass it to both panels. Rules stay exactly as
implemented today:

- Live sessions follow the newest request while the newest is selected and the
  window sits at the end. Any explicit selection pins.
- Historical sessions never follow.

Activity adds two ways to select: clicking a linked activity row, or its request
number. Both call `select(row, true)` so the chart re-windows when the bar is
outside the visible 60 (20 on phone). Paging the feed never changes selection.
Selecting or reselecting a request automatically reveals a page containing its
linked rows. Keep the current page if it already contains a match. If Activity's
agent scope hides the linked rows, switch it to All agents. Background updates
do not trigger this navigation. Keep the off-page link for manual paging away.

### Activity panel (desktop, follows “Evidence region · desktop” artboard)

- **Header.** `Activity` (section type) plus a muted metadata line:
  `312 events · 296 tool calls · 7 kinds · request #142 highlighted`. Only the
  request number is brand-text. When the selected request's rows are not on the
  current page: `· on page 7` with the page number as `.commandTextLink`.
  Trailing controls: `.commandSegmented` All agents / Primary / Subagents, and
  the existing Refresh `.commandQuietAction`.
- **Layout.** Two columns: a 360 px breakdown rail with a right rule, and the
  feed.
- **Breakdown rail.** Eyebrow `ACTIONS BY KIND` with `count · share · median duration`
  on the right. One row per kind, descending: `WorkKindIcon`, label from
  `WORK_LABELS`, 5 px track bar (raised tone, control-line fill, scaled to the
  largest kind), count (data font), share (caption, muted), median duration
  (caption, muted). Rows are quiet buttons only if kind filtering ships; the
  approved mockup shows no filter, so render them as plain rows. Show the top 7,
  then `Show N more kinds` as `.commandTextLink`. Below a rule: `Messages & input`
  and `Failed shell runs` counts (failed in error red). Caption note: “Counts
  describe recorded tool calls, not effort or quality. Duration is wall time from
  call to result, including approval waits.”
- **Feed.** Columns `TIME | AGENT | ACTION | TARGET | DURATION | REQUEST`,
  grid `96px 1fr 1fr 1.5fr 72px 56px`, 20 px column gap, 43 px rows, existing
  head styling. Time, target, duration, request in the data font. Duration and
  request right-aligned. Duration shows `—` in control-line color while `null`.
  Request shows `#<ordinal>` (the snapshot's ordinal in the retained feed, same
  numbering as Requests & actions) as `.commandTextLink` in muted color, brand
  color only for the selected request; `—` for events without a request.
  Linked tool-call and assistant-reply rows are focusable buttons (`aria-pressed`
  on the selected request's rows); unlinked rows are not interactive. Action label keeps
  `white-space: nowrap; text-overflow: ellipsis`.
- **Highlight.** Rows of the selected request take the raised panel tone only.
  Failed rows keep `--red-soft`. No ring, no left stripe, no dimming of other rows.
- **Pagination.** 20 per page. Footer: `Showing 1–20 of 312` on the left,
  Previous / 1 2 3 … 16 / Next as `.commandSecondaryAction` on the right. Live
  sessions: page 1 receives new events at the top; on any later page anchor to
  the first visible row's id so rows do not shift under the cursor (same idea as
  the chart window anchor in `useRequestSelection`).

### Activity panel (phone ≤ 640 px, follows “Evidence region · phone”)

- Header stacks title and metadata; Refresh is a 44 px quiet action.
- Breakdown folds into one 44 px disclosure row: `Actions by kind · Web 40% ·
  Reading 26% · Shell 16%` with a chevron, closed by default, state persisted per
  session via `DashboardDisclosurePanel`.
- Rows are two lines, 56 px minimum, 20 px icon column: line 1 icon + tool
  (13 px/600) + right-aligned `12:09:56 p.m. · 4.2s #142`; line 2 status dot +
  agent (min-width 96 px, ellipsis) `·` target (data font, ellipsis). Failed rows
  red-soft. Whole row is the button.
- Pagination: Previous / Next split the row at 44 px, then `Page 1 of 16 · 312 events`.
- Remove the current ≤ 640 px rules that hide the head and target column.

### Requests & actions changes

- Request detail: replace the two-column “Results available before / Actions
  issued by request” block with one chip line: eyebrow `BEFORE` + chips, a 1 px
  vertical rule, eyebrow `ISSUED` + chips. No “Show in Activity” link.
- Merge the two caveats into the single panel foot line: “Request numbers are
  positions in the retained feed (latest 100 per agent), not provider ids.
  Before and Issued come from transcript adjacency and recorded links; they do
  not establish token cost per operation.”
- Selection comes from the lifted hook; Largest requests and Cache evidence keep
  calling the same `select`/`locate`.

## Design contract (`DESIGN.md`, `app/styles`)

- Add a short “Activity” paragraph under Session Evidence: panel placement, the
  six columns, raised-tone selected rows, 20-row paging, phone two-line rows and
  breakdown disclosure. Note that request numbers are text links and the selected
  request's number is the only brand accent.
- No new tokens, colors, radii, or font sizes. Breakdown captions use
  `--text-caption`. Run the Impeccable hook; `tests/ui/pomegr-design-contract.test.tsx`
  must pass unchanged.
- Add the breakdown row and a highlighted feed row as samples in
  `app/components/design-system/DesignSystemView.tsx` if either becomes a shared
  control; otherwise keep them panel-local.

## Docs

- `docs/METRICS.md`: Activity section gains duration (wall time, includes
  approval waits, `null` while running), by-kind counts and median durations
  (recorded tool calls only), and the request link (recorded link, never an
  estimate of cost). State explicitly that no token value is attributed per
  action.
- `docs/OBSERVATION_CACHE.md`: served activity window 200, new persisted fields,
  readiness unchanged (`activityEvidence`).
- `AGENTS.md` privacy list: extend the plan-task/execution-task style bullet with
  activity duration and opaque request id as the only new exposed fields.

## Tests

- `tests/activity-events.test.mjs`, `tests/session-activity.test.mjs`: duration
  pairing (Claude `tool_result`, Codex `*_output`, failed shell), `null` for
  running and unmatched, request id stamping, aggregates, 200 bound.
- `tests/request-snapshots.test.mjs` / `tests/claude-context.test.mjs`: the
  `toolUseId → snapshotId` mapping matches `issuedWork` counts.
- `tests/api-serialization.test.mjs`: `/api/state` still serializes no prompt,
  response, command, or provider ids; `requestId` equals a served snapshot id.
- `tests/session-observation-checkpoints.test.mjs`: new fields round-trip.
- `tests/ui/requests-actions.test.tsx`: selection lifted, follow-latest and
  pinning unchanged, chip line and merged caveat.
- New `tests/ui/activity-panel.test.tsx`: paging, live anchor on page > 1,
  highlight follows selection, row click selects and re-windows, off-page notice
  link, phone layout (two-line rows, disclosure, 44 px targets), `—` states.
- `tests/session-report.test.mjs`: report output unchanged or updated
  deliberately (it omits per-request correlation by design).

## Acceptance

1. Session view shows Requests & actions, then Activity, then summary cards, then
   the roster. Session details no longer contains an activity list.
2. Selecting a bar highlights its rows; clicking a row selects its bar; paging
   never changes selection; live follow-latest highlights the current turn.
3. Feed pages the full served window (200) at 20 per page; phone rows are fully
   readable at 390 px with no horizontal scroll.
4. Breakdown counts equal the KPI strip “Tool calls” total; messages and failed
   shells are excluded from kind counts.
5. `/api/state` exposes only the fields listed in the contract section.
6. `npm run build`, `npm test`, `npm run lint` pass; design-contract test passes.

## Open decisions (default in parentheses)

- Kind rows as filters (no, mockup shows none; header segmented control scopes
  agents only).
- Desktop page size (20).
- Codex request link when the snapshot builder lacks the mapping (`null`, no
  fallback inference).
