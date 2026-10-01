# Session allowance movement and account tier

> Status: active; design approved on the canvas on 2026-09-21, revised on 2026-09-30 (see [Revision of 2026-09-30](#revision-of-2026-09-30)); no code written yet.
> Created: 2026-09-21.
> Scope: show how many percentage points of each provider account window moved while one session was sending requests, next to the account tier observed at the time, on the session **Overview**, the session **Details** tab, and the **Usage limits** page. Includes the contract changes that allow it, a monitor-store table so finished sessions and past windows keep their reading, a bounded tier enum for Claude Code and Codex, a request-token breakdown by agent and model inside one session, and, only if task 0b calls for it, an estimated split of shared intervals. Excludes any conversion of points into money or a cross-tier equivalent.
> Continuation owner: the agent that picks up this plan in a fresh session; the user reviews the result against the artboards.
> Authority: working checklist. `AGENTS.md`, `DESIGN.md`, [Metrics](../architecture/metrics.md), and [Observation cache](../architecture/observation-cache.md) stay authoritative; tasks 1 and 9 change them.
> Next task or decision: task 0 (find the Claude tier source). Follow the [task order](#task-order); each task ends with a command that must pass before the next begins.
> Completion criteria: every checkbox below is ticked with its verification recorded under the continuation checkpoint, `npm run build` and `npm test` pass, `/api/state` and the session domains serialize no forbidden value, and the running app matches the artboards apart from the written differences.
> Permanent destinations: `AGENTS.md` (privacy invariants, metric conventions, and the historical-view rule), [Metrics](../architecture/metrics.md) (**Plan usage**, **Request snapshots**, and a new **Session allowance movement** section), [Observation cache](../architecture/observation-cache.md) (table ownership, bounds, serving), `DESIGN.md` and `/design-system` (the stacked allowance bar sample).
> Lifetime: temporary; delete this file and `docs/internal/plans/session-allowance/` in the change that completes the last task, after applying the closure steps in the style guide.

## Read this first

You do not need access to the design canvas. Everything is in the repository.

| What | Where |
| --- | --- |
| Artboard 1, Overview with the **Allowance** card | `docs/internal/plans/session-allowance/prototype/OverviewAllowance.dc.html` |
| Artboard 2, Details tab with **Allowance movement** | `docs/internal/plans/session-allowance/prototype/DetailsAllowance.dc.html` |
| Artboard 3, Usage limits page | `docs/internal/plans/session-allowance/prototype/UsageLimitsSessions.dc.html` |
| Artboard 4, the six states of the Overview card | `docs/internal/plans/session-allowance/prototype/AllowanceStates.dc.html` |
| Rules the drawings cannot show | [prototype README](session-allowance/prototype/README.md) |

To look at an artboard, from the repository root:

```powershell
npx --yes http-server docs/internal/plans/session-allowance/prototype -p 8099
```

The artboards are reference drawings with hard-coded colors and inline styles. Do not copy their markup or colors. Use the existing classes and the tokens in `app/styles/tokens.css`. The blue outline marks what is new and must not ship.

Rules that apply to every task:

- Follow `AGENTS.md` and `DESIGN.md`. No literal colors, no new font sizes, no new radii in `app/styles/`. Every button uses one of the six button roles.
- The monitor computes everything. React components render normalized fields only.
- GETs serve committed values. No GET may acquire provider data, read a credential file, or fold movements.
- Use the [agent workflow](../development/agent-workflow.md) routing table to place new modules, and keep `npm run check:boundaries` passing.
- This plan names files and symbols, not line numbers. Find a symbol by name; if one is gone, search for its behavior before assuming the plan is wrong.
- Do not run `npm run build` and `npm test` at the same time.
- Commit only if the user asks.

### The question being answered

The user watches the account percentage before and after a session and subtracts by head. That works only while nothing else uses the account. Pomegr already has the pieces to do the subtraction and to say when it is not trustworthy. A second question follows it: what inside the session used the allowance. Points cannot answer that, so a separate measure does (task 7b).

### What exists today

Verified against the code on 2026-09-30.

- `server/analytics/limit-activity.mjs` exports `createHomeLimitActivityTracker`. It keeps up to 64 samples `{ observedAt, percent, resetsAt }` per limit in memory, tracks the window start, and `build()` turns adjacent rising samples into movements with `changePoints` and a `correlation` of `single`, `shared`, or `unobserved`, by checking which sessions recorded a request inside the interval.
- The tracker is created in `server/server.mjs` (`homeLimitActivityTracker`). The Home snapshot build there calls `observe()` and then `build()`. The result is served only as `limitActivities` on `/api/home` (`HomeLimitActivity` in `shared/monitor-contract.ts`). No component renders it; [Plan usage](../architecture/metrics.md#plan-usage) records that the Home presentation was removed.
- Samples arrive from the five-minute account poll (`server/normalize/usage-limits.mjs`) and, for Claude Code, from the status-line feed (`server/providers/claude/usage-feed.mjs`), which fires each turn.
- Nothing is persisted per session, and nothing survives a monitor restart.
- No tier or plan field exists in `shared/monitor-contract.ts`. Codex returns `planType` with each rate-limit bucket and `normalizeCodexRateLimits` (`server/providers/codex/usage-limits.mjs`) drops it; `tests/server/providers/codex/usage-limits.test.mjs` asserts that it never leaks. Claude Code reads only `claudeAiOauth.accessToken` from the credential file (`server/providers/claude/usage-limits.mjs`).
- The session cost estimate is the presentation pattern to imitate, not the storage pattern: historical sessions show it labeled **Recorded** (`app/components/dashboard/SessionDetailsPanel.tsx`). Its one-file-per-session store (`server/normalize/session-cost.mjs`) is not the model for this work.
- The monitor SQLite store is the storage home. `server/persistence/monitor-store.mjs` owns the schema (`createSchema`, `MONITOR_STORE_SCHEMA_VERSION`). `server/persistence/monitor-store-runtime.mjs` runs a cycle after checkpoint writes and calls each contributor registered through `registerContributor` (`name`, `onCheckpoint`, `rebuildComplete`). `createResourceHistoryContributor` (`server/resources/resource-history.mjs`) and `createFileChangeIndexContributor` (`server/repository/file-change-index.mjs`) are the existing contributors, attached in `server/runtime/observation-runtime.mjs`.
- Session pages read per-session derived data through the session domains, not through provider adapters: `createSessionDomainStore` in `server/runtime/observation-runtime.mjs` takes side channels such as `retainedResourcesForSession` and `fileHistoryForSession`, backed by `createResourceDomainSource` (`server/resources/resource-domain.mjs`) and `createFileHistorySource` (`server/repository/file-history-domain.mjs`).

### Definitions used by every task

A **point** is one percentage point of one provider account window. For one session and one window, each settled movement lands in exactly one bucket:

| Bucket | Rule | Label |
| --- | --- | --- |
| `alonePoints` | The movement's pre-truncation correlation is `single` and the session is that single session | **This session alone** |
| `sharedPoints` | The correlation is `shared` and the session is one of the sessions | **Shared intervals**, never split between sessions as a recorded value |
| `noLocalRequestPoints` | The correlation is `unobserved` and the interval lies inside the session's span, from its first to its latest recorded request | **No local request** |

A movement is **settled** when a later sample exists for the same limit. Folding only settled movements gives transcript indexing time to record the requests inside the interval, so a late request cannot flip a bucket after it was stored.

> **Caution:** `build()` computes `correlation` before it trims sessions to the 240-observation public cap and computes it again afterward. A trimmed `shared` movement can read as `single`. The allowance fold must use the correlation computed before trimming. Task 2 exposes it.

Three more rules:

- A window is identified by limit ID, exact window start, and tier. A reset, or a tier change, starts a new window entry. Points from different windows are never added together.
- If the window start is not exact (`windowStartsAtExact` is false) or coverage began after the window start, the entry carries `partialCoverage: true`.
- The tier is the account tier observed while sampling. No transcript records a tier, so it is never called the session's tier. When the sampled account may differ from the account the session used (a custom Claude profile from desktop provider-folder settings, or any session whose provider source differs from the sampled one), the tier is `unknown`.

Points are not comparable across tiers and are never normalized. Providers do not publish allowance sizes reliably, so any conversion would be an invented measurement.

## Revision of 2026-09-30

The product owner reviewed the plan on 2026-09-30 and asked for four changes. Each is reflected in the tasks below.

1. **Current paths.** The plan named the former `monitor/` layout and flat `docs/` files. It now names the `server/` modules and the documentation homes under `docs/internal/`.
2. **SQLite, not JSON files.** Per-session JSON records are dropped. Allowance data lives in the monitor SQLite store, which also makes past windows available.
3. **Measure before building the interface.** Sessions that run in parallel put their movement in the shared bucket, where a session's card says little. Task 0b measures how large that bucket is on real usage before any interface task starts, and decides whether the estimated split in task 3b is built.
4. **A layer inside the session.** The owner stated on 2026-09-30 that the rules against cumulative token figures were an early scoping choice, not a permanent limit. Task 7b adds request tokens by agent and model for one session, as its own labeled measure. The contract wording that allows it is part of task 1 and needs the owner's approval before any code depends on it.

Two of these additions have no artboard: the past-windows view (task 8b) and the inside-this-session breakdown (task 7b). Do not build either interface until the user approves a drawing or a written layout.

## Work and verification

### Task order

Tasks run in number order with one exception. Task 0b needs the method from task 2 and at least five working days of measurement, so it starts when task 2 lands and runs while tasks 3, 4, and 5 proceed. It must finish before task 6, because its result decides task 3b and what the interface shows. Task 1 is done once up front; if task 0b selects task 3b, that task adds its own contract sentence.

### Task 0 — Find the Claude tier source

- [ ] Check the current Claude Code status-line input documentation for an account tier or subscription field. If one exists, it is the source: it arrives with `rate_limits` in the same invocation, so it needs no credential read.
- [ ] Otherwise the source is the credential file. Ask the user to run this from a terminal and report only the key names it prints. It prints names, never values:

```powershell
node -e "const o=JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude/.credentials.json','utf8')).claudeAiOauth;console.log(Object.keys(o))"
```

- [ ] Record under the continuation checkpoint which source was chosen and the exact key names. Never paste, log, or commit a value from that file. If neither source has a tier, ship Claude with `unknown` and keep Codex.

Acceptance: the checkpoint names one source, or states that none exists.

### Task 0b — Measure the shared share and the token coverage

This task produces numbers, not shipped code. Keep its script under the ignored `work/session-allowance/` and remove it when the task closes.

- [ ] After task 2 lands, record settled movements on the user's own machine for at least five working days. For each provider window, total the points per bucket: alone, shared, no local request.
- [ ] Record under the continuation checkpoint the share of settled points that landed in the shared bucket, per provider and window length, with the number of windows observed.
- [ ] Decide task 3b from that number. Proposal, for the user to confirm: build the estimated split when shared intervals hold more than a quarter of the settled points in the five-hour window. Below that, skip task 3b and say so in the checkpoint.
- [ ] For task 7b, confirm which retained source covers every request of a long session with its agent, model, and request-local token parts. The request-snapshot feed keeps only the newest 100 requests per agent, so it is not enough alone; check the committed session history under `server/sessions/history/`. Record the source and its coverage limit, or record that no complete source exists.

Acceptance: the checkpoint holds the measured shares, the decision on task 3b, and the token source for task 7b.

### Task 1 — Change the contracts first

Edit `AGENTS.md` under **Security and privacy invariants**:

- [ ] Add a bullet for session allowance records. They may persist and expose only: normalized session ID, provider, fixed limit ID, window label, exact window start and reset timestamps, the bounded tier enum, non-negative `alonePoints`, `sharedPoints`, and `noLocalRequestPoints`, the last observed window percentage, first and last observation timestamps, and a partial-coverage flag. Never persist sample series, request IDs, credential paths, account IDs, or raw responses. Always present the values as observed movement matched by time, never as a provider measurement, billing, or a per-agent or per-request figure.
- [ ] Add a bullet for the account tier. Claude Code and Codex may each expose one bounded enum derived monitor-side; an unrecognized value maps to `unknown`; the raw provider string never leaves the monitor. For Claude Code name the source chosen in task 0. If it is the credential file, state that only that one field is read beside the access token, that it is never persisted with credential contents, and that it follows the same credential-source fingerprint rule as the account-usage cache.
- [ ] Reword the bullet that begins "Historical views must never expose current plan limits". Historical views still never expose current plan limits or the current tier. They may show the session's recorded allowance record, including the recorded tier and the recorded last window percentage, labeled **Recorded**. The Usage limits page may list past windows from recorded allowance rows, labeled as recorded.

Edit `AGENTS.md` under **Metric conventions**, with the owner's approval of the exact wording:

- [ ] State the one new exception for task 7b: for one session, the monitor may sum request-local token parts by normalized agent and by recorded model, and present each as a labeled request-token total for that session. It stays separate from context, is never converted to money or plan consumption, and never crosses sessions. Cite the owner's statement of 2026-09-30.
- [ ] Leave the estimated split out for now. Task 3b adds its own exception if task 0b selects it.

Edit [Metrics](../architecture/metrics.md):

- [ ] Under [Plan usage](../architecture/metrics.md#plan-usage) note that the retained movements now feed the session allowance record, correct the sentence about the removed Home presentation if the Usage limits page now renders part of the derivation, and replace the sentences that say Pomegr never sums request tokens and that observation history is live diagnostic state only with the bounded exceptions above.
- [ ] Under [Request snapshots](../architecture/metrics.md#request-snapshots) add the per-session agent and model totals as the one permitted sum, with its source and its coverage limit from task 0b.
- [ ] Add **Session allowance movement** with the definitions table above, the settled rule, the window identity rule, the tier caveat, and the statement that points are not comparable across tiers.

Edit [Observation cache](../architecture/observation-cache.md) near **Local Claude usage observations and desktop recovery**: table ownership (monitor store), the bounds and retention from task 3, the fold cadence, what a store rebuild loses, and that GETs only read committed rows.

Acceptance: `git diff --check` is clean and `npm run verify:fast` passes.

### Task 2 — Expose pre-truncation movements to the fold

- [ ] In `server/analytics/limit-activity.mjs`, keep `build()` output unchanged for `/api/home`. Add a second method on the tracker, for example `settledMovements({ sessions, generatedAt, policiesByProvider })`, that returns, per limit, the window identity (`provider`, `source`, `limitId`, `window`, `windowStartsAt`, `windowStartsAtExact`, `resetsAt`, latest `percent`, first sample time) and every movement with its correlation and session IDs from before trimming. Exclude the newest movement of each limit unless a later sample exists.
- [ ] Share the interval-matching code with `build()`; do not duplicate it.
- [ ] Confirm when `observe()` runs. It is called from the Home snapshot build in `server/server.mjs`; if that build runs only on demand, samples are missed while nobody opens Home. Record the cadence, and move the feed to background observation work if it depends on a request.
- [ ] Extend `tests/server/analytics/limit-activity.test.mjs`: a `shared` movement stays `shared` when the public cap trims one of its sessions; the newest unsettled movement is withheld; a percentage drop starts a new window identity.

Acceptance:

```powershell
node --test tests/server/analytics/limit-activity.test.mjs
```

### Task 3 — Fold into the monitor store

- [ ] Add `server/analytics/session-allowance.mjs` with the fold, a monitor-store contributor, and the read queries. Imitate `createResourceHistoryContributor` for the contributor shape and `createResourceHistoryQueries` for the queries.
- [ ] Add two tables in `createSchema` (`server/persistence/monitor-store.mjs`). `CREATE TABLE IF NOT EXISTS` backfills them into an existing database, so do not bump `MONITOR_STORE_SCHEMA_VERSION`: a version mismatch deletes and rebuilds the whole store.

| Table | Key | Columns |
| --- | --- | --- |
| `allowance_windows` | `provider`, `limit_id`, `window_starts_at`, `tier` | `window_label`, `resets_at`, `last_percent`, `shared_points`, `shared_session_count`, `no_local_request_points`, `first_observed_at`, `last_observed_at`, `folded_through`, `partial_coverage` |
| `session_allowance` | `session_id`, `provider`, `limit_id`, `window_starts_at`, `tier` | `alone_points`, `shared_points`, `no_local_request_points`, `request_count`, `first_observed_at`, `last_observed_at` |

- [ ] Fold idempotently inside one transaction (`store.transaction`). `folded_through` on the window row is the `to` timestamp of the last folded movement; fold only movements whose `from` is at or after it. A monitor restart must not double count and must not lose the stored points.
- [ ] Cadence: the contributor's `onCheckpoint` folds on every store cycle. A session's last movement settles on a later sample, when no checkpoint may be written, so request a cycle when the tracker accepts a new sample (the runtime already runs a cycle without a snapshot through `afterCheckpointWrite(null)`). Never fold in a request handler.
- [ ] Bounds: at most 64 window rows per session, newest kept. Extend `runRetention` (`server/persistence/store-retention.mjs`) to delete both tables' rows whose `resets_at` is older than the `retentionDays` cutoff; keep-all keeps them. Update that module's header comment, which lists the only tables it deletes from.
- [ ] Rebuild: allowance rows cannot be rebuilt from checkpoints or transcripts, because the samples exist only in memory at the time. `rebuildComplete()` returns true at once, and a rebuilt store starts empty. Sessions whose rows were lost read `unavailable`; never backfill them from current account values.
- [ ] Add `tests/server/analytics/session-allowance.test.mjs`: bucket rules, idempotent refold, restart continuity, reset mid-session producing two rows, tier change producing two rows, the per-session bound, age retention under each `retentionDays` choice, an empty table after a rebuild, and a sentinel check that no request ID, path, or credential string is written.

Acceptance:

```powershell
node --test tests/server/analytics/session-allowance.test.mjs tests/server/persistence/monitor-store.test.mjs tests/server/persistence/store-retention.test.mjs
```

### Task 3b — Estimated split of shared intervals (only if task 0b selected it)

- [ ] With the owner's approval of the wording, add the exception to `AGENTS.md` **Metric conventions** and to [Plan usage](../architecture/metrics.md#plan-usage): a shared interval's points may additionally be presented as an **estimated split** in proportion to each session's request tokens inside the interval, always labeled as an estimate and never added to the recorded alone points.
- [ ] For each shared movement, divide its points between its sessions in proportion to each session's request-local fresh tokens (uncached input, cache write, output) recorded inside the interval. Store the result in a separate `estimated_shared_points` column on `session_allowance`; never add it to `alone_points`.
- [ ] A movement with no token evidence for one of its sessions is not split.
- [ ] State the limit beside every use: providers weigh models differently and do not publish the weights, so a token share is not the share the provider charged.
- [ ] Tests: proportional split, the unsplit case, and that the recorded buckets are unchanged by the estimate.

Acceptance:

```powershell
node --test tests/server/analytics/session-allowance.test.mjs
```

### Task 4 — Normalize the tier

- [ ] Add an `AccountTier` enum to `shared/monitor-contract.ts`. Claude Code: `pro`, `max_5x`, `max_20x`, `team`, `enterprise`, `unknown`. Codex: `plus`, `pro`, `team`, `enterprise`, `unknown`. Confirm the recognized raw values in task 0 and from the Codex app-server response; map anything else to `unknown`.
- [ ] Codex: read `planType` in `server/providers/codex/usage-limits.mjs` from the selected bucket, falling back to any bucket that reports one, and return the enum beside the limits. Change `tests/server/providers/codex/usage-limits.test.mjs`: the fixture value `PLAN_MUST_NOT_LEAK` must now normalize to `unknown` and the sentinel must still be absent from the serialized result; add one fixture with a recognized plan. Every other sentinel stays.
- [ ] Claude Code: read the field chosen in task 0. If it is the credential file, read it in the same place as the access token (`server/providers/claude/usage-limits.mjs`) and return only the enum. Return `unknown` for a custom Claude profile.
- [ ] Add `tier` to `HomeProviderUsageLimits` (`shared/monitor-contract.ts`), not to each limit. For historical reads it is omitted, the same way usage limits are emptied for historical views.
- [ ] Pass the current tier into the fold so each window row stores the tier observed at fold time.

Acceptance:

```powershell
node --test tests/server/providers/codex/usage-limits.test.mjs tests/server/normalize/usage-limits.test.mjs tests/server/providers/claude/usage-api-cache.test.mjs
```

### Task 5 — Serve it

- [ ] Serve the session's allowance through the session domains, not through a provider adapter: add a committed source in the style of `createResourceDomainSource`, pass it to `createSessionDomainStore` as a side channel beside `retainedResourcesForSession`, and recommit the session's domains when its rows change. The **session-summary** domain carries what the Overview card needs and the **details** domain carries the full list. It is served for live and historical sessions.
- [ ] Shape: `{ status: "ready" | "collecting" | "unavailable", windows: [...] }` where each window carries the session's row joined with its window row, without `folded_through`.
- [ ] `collecting` means the session is live and no settled movement overlaps it yet. `unavailable` means no row and the session is historical, or usage limits are unavailable for the provider.
- [ ] For the Usage limits page, extend the response behind `useUsageLimits()` (`app/usage-limits-client.ts`) with, per provider and per displayed window: a bounded list of at most 24 `{ sessionId, title, project, isLive, requestCount, alonePoints }`, plus `sharedPoints`, `sharedSessionCount`, `noLocalRequestPoints`, and the window total. Read it from the two tables for the current window.
- [ ] Extend `tests/server/api-serialization.test.mjs`: the new fields appear, and no sample series, request ID, raw tier string, or credential sentinel does.

Acceptance:

```powershell
node --test tests/server/api-serialization.test.mjs
```

### Task 6 — Overview card (artboards 1 and 4)

- [ ] In `app/components/dashboard/SessionOverview.tsx`, add an **Allowance** panel to `.sessionOverviewBottom` after the cost panel (`.sessionCostOverview`). Show it when the allowance status is `ready` or `collecting`; when `unavailable`, render nothing, the same way the cost panel is absent without a cost.
- [ ] Show the tightest window only: the entry with the highest `lastPercent` among windows whose reset is in the future for a live session, or the newest entry for a historical session. Contents: heading **Allowance** as a panel heading link to the Details tab, the tier chip (`.commandChip`), one line `<window> · this session alone` with `<n> pts`, the stacked bar, and one note line.
- [ ] Implement the six states on artboard 4 with their exact copy. **Account used elsewhere** applies when `noLocalRequestPoints` is greater than `alonePoints`; it is the only state that uses the amber token. **Below one point** applies when all three buckets are zero and the status is `ready`. A finished session whose record has two entries for the same limit lists both lines and no bar.
- [ ] The stacked bar is a new shared control. Add it to `DESIGN.md` first, then to `PanelsSection()` in `app/components/design-system/DesignSystemView.tsx`, then to `tests/ui/pomegr-design-contract.test.tsx`. Segments use existing ink, muted, and raised tokens; the no-local-request segment uses a hatch built from tokens. Every bar is accompanied by text carrying the same numbers.
- [ ] Phone: `.sessionOverviewBottom` is `display: contents` in the `max-width: 760px` block of `app/styles/session.css`. Give the new panel `grid-column: 1` and the order directly after `.sessionCostOverview`.
- [ ] Tests in `tests/ui/dashboard-t04.test.tsx`: each state, the hidden state, the heading link target, and that a historical session never renders a current window percentage.

Acceptance:

```powershell
npm run test:ui
```

### Task 7 — Details panel (artboard 2)

- [ ] In `app/components/dashboard/SessionDetailsPanel.tsx`, add **Allowance movement** directly after the cost block. Context inventory keeps its place.
- [ ] Header: title, tier chip, and a quiet action **Usage limits** with a chevron (not a brand text link). Then one compact row per window entry, newest first, at most four, with a **Show N more** text link for the rest: label with `now <p>%` for live sessions or `recorded <p>%` for historical ones, `<n> pts alone` right-aligned, the stacked bar, and a muted line `<n> pts shared · <n> pts no local request`. Mark partial coverage in words on the row.
- [ ] If task 3b shipped, the muted line adds `≈ <n> pts estimated share`, with the word estimated always present.
- [ ] One caveat line under the rows, as drawn. For a historical session add **Recorded** the way the cost block does.
- [ ] No chart here.
- [ ] Tests beside `tests/ui/estimated-cost.test.tsx`: live and historical rendering, the four-row limit, tier `unknown` copy, and no `%` unit on a points value.

Acceptance:

```powershell
npm run test:ui
```

### Task 7b — Inside this session: request tokens by agent and model

No artboard exists. Get the user's approval of a drawing or a written layout before building the interface; the monitor work can proceed first.

- [ ] Monitor: from the source recorded in task 0b, derive for one session the sum of fresh tokens (uncached input, cache write, output) and, separately, of cache reads, grouped by normalized agent and by recorded model. Serve it on the **details** domain with its coverage flag. If the source does not cover the whole session, serve `partial` and say so; never extrapolate.
- [ ] Present it under **Allowance movement** as its own block with its own unit (tokens, never pts) and a caveat line: these are request tokens recorded for this session, not plan consumption and not a bill.
- [ ] Never show it beside a points value in a way that suggests a conversion, and never sum it across sessions.
- [ ] Tests: grouping, the partial flag, the model identifier validation already used for request models, and a serialization check that no provider message ID or raw usage record appears.

Acceptance:

```powershell
npm run test:node
npm run test:ui
```

### Task 8 — Usage limits page (artboard 3)

- [ ] In `app/components/command-center/CommandViews.tsx`, `UsageProvider`: add the tier chip after the provider name in the header, with the muted text `account tier observed <relative time>`. Hide the chip when the tier is absent; show **Tier unknown** when it is `unknown`.
- [ ] Under each displayed window add **Sessions in this window**: one row per session with its title, project and live state, request count, `<n> pts`, and a chevron icon action to that session; then the rows **Shared intervals · N sessions, not split** and **No local request · possibly another machine**; then **Window total**. When the rows do not add up to the window percentage because coverage is partial, add a muted row **Before first observation** with the remainder instead of hiding the gap.
- [ ] The left side of artboard 3 draws a window timeline. No such timeline ships today; do not build one in this plan. Keep the existing `.commandUsageWindow` card and place the table beside or under it.
- [ ] Replace the sentence in `.commandUsageCaution` (the page footer) that says Pomegr does not attribute usage or cost to sessions, agents, or repositories. New wording: the points are a time correlation between account samples and recorded requests, not a provider measurement, and are not comparable across tiers.
- [ ] Tests beside `tests/ui/usage-limits-view.test.tsx` for the table, the remainder row, the empty state, and the tier chip states.

Acceptance:

```powershell
npm run test:ui
```

### Task 8b — Past windows on the Usage limits page

No artboard exists. Get the user's approval of a drawing or a written layout first.

- [ ] Serve, per provider and limit, a bounded list of past windows from `allowance_windows` (newest first, at most 12), each with its recorded tier, recorded last percentage, bucket totals, and its top sessions by `alonePoints`.
- [ ] Label every past window **Recorded**. Never show a current percentage for a past window, and never add points across windows or tiers.
- [ ] Tests: ordering, the bound, a window whose sessions were removed by retention, and the recorded label.

Acceptance:

```powershell
npm run test:node
npm run test:ui
```

### Task 9 — Close

- [ ] Add a line for allowance to the session report if `get_session_report` and **Download report** list the cost estimate; keep the same caveat wording.
- [ ] Update the public pages that describe these surfaces: [usage limits](../../public/concepts/usage-limits.md) and its screenshot, following the screenshot ownership rules in the [maintenance workflow](../development/documentation.md).
- [ ] Re-read the contracts from task 1 against the shipped behavior and correct any drift.
- [ ] Run the full checks, one after the other:

```powershell
npm run build
npm test
npm run lint
```

- [ ] With the app running, confirm by hand: a live session shows points rising after the next sample; restarting the monitor keeps the stored points; a finished session shows **Recorded** and no current percentage; `/api/state` and the session domains contain no sample series, raw tier string, or credential value.
- [ ] Apply the closure procedure in the style guide and delete this plan and its prototype folder.

## Decisions already made

- Placement is next to the cost estimate on Overview and Details, because both are account-level consumption readings with their own caveat. It is not on the Signals tab, not in the KPI strip, and not in the sidebar limits widget, which stays shell chrome without session data.
- The unit is **pts**. `11%` would read as a share of the session.
- The session list gets no allowance column: points from different windows and tiers do not sort meaningfully.
- Points stay at session level. They are never split per agent or per request. Revised 2026-09-30: the question of what inside a session used the allowance is answered by a separate request-token measure (task 7b), never by dividing points.
- Recorded shared points are never divided between sessions. Revised 2026-09-30: an estimated split may be shown beside them, labeled as an estimate, only if task 0b selects it.
- Storage is the monitor SQLite store. Decided 2026-09-30; the per-session JSON file design is withdrawn.

## Continuation checkpoint

2026-09-21: design approved on the canvas; artboards exported to `docs/internal/plans/session-allowance/prototype/`; no code written. Open items: the Claude tier source (task 0) and the recognized raw tier values for both providers.

2026-09-30: plan revised after the owner's review; see [Revision of 2026-09-30](#revision-of-2026-09-30). Still no code written. Open items: the two from 2026-09-21; the `observe()` cadence (task 2); the measured shared share and the decision on task 3b (task 0b); the complete per-request token source (task 0b); the owner's approval of the metric-convention wording (task 1); and layouts for tasks 7b and 8b. Next action: task 0.
