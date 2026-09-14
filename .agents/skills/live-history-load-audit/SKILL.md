---
name: live-history-load-audit
description: Validate Pomegr's current live-session load priority and isolation from complete-history work. Use for uncommitted changes, branches, main, or PRs when checking observation scheduling, session history, session-domain APIs, SSE/polling, or cache serving; not for diagnosing a particular recorded-session anomaly.
---

# Live and History Load Audit

Validate that the current workspace keeps live session evidence responsive while history is acquired and served independently. The subject may be uncommitted work, one or more commits, main, or a PR. Keep the audit read-only unless the user separately asks for fixes.

## Establish the subject

- Read `docs/AGENT-WORKFLOW.md` and the scheduling, paged-history, serving, and frontend-refresh sections of `docs/OBSERVATION_CACHE.md`.
- Inspect the current branch, commit, and working-tree status without changing them. Preserve unrelated working-tree changes; do not switch branches, reset, or edit during an audit.
- Use a diff only when the user identifies a comparison or asks about regression. For uncommitted work, inspect the working-tree diff; for commits or a PR, inspect the stated range. Otherwise validate the current implementation without inventing a baseline.
- When a comparison exists, separate behavior changed in that range from pre-existing safeguards. A passing baseline test is useful evidence but does not prove that the compared changes introduced the safeguard.

## Required invariants

Check these in code and tests:

1. First publication for live or needs-input sessions and explicit selection use urgent provider-observation priority. Ordinary source updates cannot occupy all interactive capacity, and eager historical hydration stays in the background lane.
2. Complete history replay uses its own bounded scheduler. Selected history may use foreground priority *inside that history scheduler* for responsiveness; maintenance history stays background. Neither lane consumes provider live-hydration slots.
3. State, domain, and history GETs serve committed caches. A GET may schedule only the explicitly documented asynchronous repair or promotion and must never synchronously read or parse provider transcripts.
4. The browser renders committed live state or its recent request preview before full history. It retains visible evidence during refresh, avoids periodic polling for ready historical views, and uses one shared SSE connection with the documented fallback cadence.
5. Report accurately that scheduler slots are logical asynchronous capacity, not dedicated OS threads. They protect queue ordering but cannot guarantee a latency bound when synchronous work blocks the event loop.

Inspect at least:

- `monitor/providers/normalized-polling-observer.mjs`
- `monitor/session-history-refresh-scheduler.mjs`
- `monitor/session-history-runtime.mjs`
- `monitor/observation-runtime.mjs`
- `monitor/request-handler.mjs`
- `app/Dashboard.tsx`
- `app/live-events.ts`
- `app/components/dashboard/useActivityHistory.ts`
- `app/components/dashboard/requests-actions/useSessionRequestSelection.ts`

## Focused verification

Run the deterministic scheduling and serving tests:

```powershell
node --test tests/normalized-polling-observer.test.mjs tests/session-history-refresh-scheduler.test.mjs tests/selected-history-priority.test.mjs tests/selected-session-revalidation.test.mjs tests/provider-observation.test.mjs tests/progressive-history-runtime.test.mjs tests/observation-serving.test.mjs tests/session-domain-runtime.test.mjs tests/session-domain-transport.test.mjs
```

Run the browser transport and history-behavior tests:

```powershell
npx vitest run tests/ui/dashboard-session-navigation.test.tsx tests/ui/history-publications.test.tsx tests/ui/live-events.test.ts tests/ui/activity-history.test.tsx tests/ui/request-page-cache.test.tsx tests/ui/requests-actions.test.tsx
```

If the current workspace build is already available at the loopback web server, run the bundled read-only smoke measurement. Do not start or restart Pomegr merely for an audit without user authorization.

```powershell
node .agents/skills/live-history-load-audit/scripts/measure-load.mjs
```

Treat the smoke output as bounded local evidence, not a benchmark against the base branch. A non-live selected row cannot validate live responsiveness. Outliers must be reported, not averaged away.

## Report

Lead with one of: safe for this risk, concern found, or insufficient evidence. Then state:

- whether live and history work use separate capacity and which priority applies inside each pool;
- the audited workspace state and, only when applicable, whether the compared changes altered those mechanisms;
- focused test results and relevant CI status when the audited subject has CI;
- cold, warm, and contention timings when measured, including outliers;
- the remaining evidence gap.

Without a comparison, say whether the current state satisfies the scheduling invariants; do not frame the result as a regression judgment. Do not claim “no performance regression” without comparable measurements or an enforced latency budget. Prefer “no scheduling regression found” when a comparison establishes ordering and isolation only. Explicitly identify the absence of a hard wall-clock regression test when applicable.
