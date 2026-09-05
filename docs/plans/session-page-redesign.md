# Session page redesign plan

## Objective

Rebuild the individual session page (`app/Dashboard.tsx` and the panels under
`app/components/dashboard/`) so a heavy session (49 agents, 3 workflows, 1,200+ model
requests) reads at a glance without losing any diagnostic evidence, and so the page never
grows a page-length scrollbar from the agent roster.

The target design is the canvas published on 2026-09-04 and copied verbatim into
`docs/plans/session-page-redesign/`:

| Mockup file | What it shows |
| --- | --- |
| `mockup-main.html` | The whole session page at 1440 px width, dark theme. Every panel, in final order. |
| `mockup-agentgrid.html` | The "Grid" agent-activity mode: every agent as a 64 px tile, one lane per workflow. |
| `mockup-focusedtree.html` | The tree as a drill-down focused on one agent, with off-path siblings clustered. |

Open each mockup in a browser. They are static HTML, no build needed. Measurements,
colors, copy, and column order in this plan come from those files; when the plan and the
mockup disagree, the mockup wins for visuals and this plan wins for data semantics.

Data in the mockups is illustrative and partly synthetic (the request bars, the workflow
names, the "Largest requests" values). Never copy mockup numbers into fixtures as if they
were provider truth.

## How to use this plan

Start a new session with a request such as:

> Implement `POMEGR-SP-03` from `docs/plans/session-page-redesign.md`. Preserve unrelated
> working-tree changes and stop when that task's acceptance criteria are met.

Before starting any task:

1. Read `AGENTS.md`, this plan, the mockup file(s) the task names, and the source files
   the task names.
2. Run `git status --short` and preserve unrelated changes.
3. Confirm the task's listed dependencies are complete (see the Progress log).
4. Keep raw prompts, responses, commands, tool output, provider IDs, transcript paths, and
   credentials out of browser state, fixtures, and tests. The api-serialization test
   enforces this with sentinel strings; extend it, never weaken it.
5. Run the task's Verification commands. Run `npm run verify:fast` before handing off.
6. Update the Progress log table only when the acceptance criteria are met.

## Locked design decisions

These were decided with the product owner during the design session. Do not reopen them
inside an implementation task.

1. **Panel order on the session page**, top to bottom:
   breadcrumb → hero (title, identity line, provider summary) with a status card on the
   right → KPI strip (5 numbers) → **Requests & actions** (hero chart) → three equal cards
   (Agent estimate, Workflows, Efficiency signals) → **Agent activity** (roster + inspector)
   → collapsed one-line disclosure rows (Repository, Session details) → live-only Resource
   usage stays where it is today (after Agent activity, before the disclosure rows).
2. **Context history panel and Request snapshots panel are removed.** One panel,
   Requests & actions, replaces both. The bar outline (prompt size) carries the context
   level; compaction boundaries render as dashed ticks on that chart.
3. **Chart default mode is "Fresh tokens"**: stacked uncached input + cache write + output.
   Cache read is drawn only as the bar outline (prompt size = uncached + cache write +
   cache read). "Full breakdown" mode stacks all four.
4. **Largest requests** ranks by **uncached input** by default, is **session-wide within
   the selected agent scope** (not limited to the visible window), and clicking a row moves
   the chart window to that request. Row title is the agent name, never an operation name.
5. **Action correlation** for a request exposes only bounded `WorkKind` counts:
   "Results available before" (tool results recorded between the previous model request
   and this one, same agent) and "Actions issued by request" (tool_use blocks inside this
   request's assistant record). Each list is labeled with its association kind. Nothing is
   summed across requests, and no cost per operation is ever shown or implied.
6. **Agent activity has two tabs: List and Grid.** Tree is no longer a tab. Tree opens as a
   focused drill-down from the inspector's "Open in tree" link or from a group header, and
   returns to the roster with a back link.
7. **Roster is grouped**: pinned Primary row, then "Direct subagents" (agents with
   `parentId === "primary"` and `workflowId === null`), then one group per workflow in
   `workflows[]` order. Groups are collapsed by default except the group containing the
   selected agent. The roster region has a fixed height (560 px on desktop) and scrolls
   inside itself with sticky group headers.
8. **Inspector** on the right of the roster shows everything that used to crowd each row:
   role, model, effort, final context, wall time, tool calls, shell task count, cache
   lifetime, last turn, signals, lineage strip, shell task list, copy-transcript action.
9. **Tokens and typography stay as defined in `app/styles/tokens.css`.** Nothing new is
   invented: Inter for UI, Geist Mono for every number, 4 px control radius, 6 px panel
   radius, lavender `--color-context` for context, green for active/progress, amber for
   attention, coral brand color only for the mark, provider name, links, and selection.
10. **Metric contract holds.** No cumulative token totals, no rates, no spend. Request
    numbers are request-local. The KPI "All-agent context" is the existing
    `metrics.tokens.allAgents` (sum of latest snapshots).

## Mockup-to-token mapping

The mockups hard-code dark-theme hex values. Implement with tokens so light theme works.

| Mockup hex | Token to use |
| --- | --- |
| `#111315` page ground | `--command-ground` |
| `#191c20` panel | `--command-panel` |
| `#23272d` raised / row separator | `--command-panel-2` |
| `#1b1e23` group header ground | `color-mix(in srgb, var(--command-panel) 50%, var(--command-panel-2))` |
| `#333941` line | `--command-line` |
| `#697482` control / idle ring / finished dot | `--command-line-strong` |
| `#7d8590` faint text | `--command-faint` |
| `#a8afb9` muted text | `--command-muted` |
| `#edf0f3` ink | `--command-ink` |
| `#e58b80` coral | `--command-brand-text` |
| `#bbb3d3` lavender (context, uncached input) | `--color-context` |
| `#91c5a4` green (active, cache write, progress) | `--command-green` |
| `#e3b575` amber (attention, output, compaction) | `--command-amber` |
| `#f09a9f` red (stopped, exit ≠ 0) | `--red` |
| `#4a525c` bar outline stroke | `color-mix(in srgb, var(--command-line-strong) 70%, var(--command-line))` |

Type ramp used by the mockups (all already in tokens or `session.css`):
26 px/600 title with -0.025em tracking; 30 px/500 KPI numbers with -0.02em; 16 px/600 card
titles; 13 px body; 12 px meta; 11 px uppercase labels with 0.06em tracking (new class,
see SP-01). Numbers use `var(--font-data)` and `font-variant-numeric: tabular-nums`.

## Milestones

| Task | Title | Depends on |
| --- | --- | --- |
| POMEGR-SP-01 | Page skeleton, hero status card, KPI strip, three summary cards | none |
| POMEGR-SP-02 | Collapse Repository and Session details to one-line disclosure rows | SP-01 |
| POMEGR-SP-03 | Monitor: request action correlation (Claude adapter) | none |
| POMEGR-SP-04 | Contract, serialization guard, and docs for request actions | SP-03 |
| POMEGR-SP-05 | Requests & actions panel (chart, minimap, selection, detail, largest list) | SP-01, SP-04 |
| POMEGR-SP-06 | Remove Context history and Request snapshots panels and the display preference | SP-05 |
| POMEGR-SP-07 | Agent activity roster: groups, rollups, bounded region, distribution strip, filter bar | SP-01 |
| POMEGR-SP-08 | Agent inspector with lineage strip | SP-07 |
| POMEGR-SP-09 | Grid view mode | SP-07 |
| POMEGR-SP-10 | Tree as focused drill-down | SP-08 |
| POMEGR-SP-11 | Responsive, accessibility, dead CSS removal, final verification | all |

SP-03/SP-04 (monitor) and SP-01/SP-02/SP-07 (UI) are independent and can run in parallel
sessions. SP-05 needs both branches.

---

## POMEGR-SP-01 — Page skeleton, hero status card, KPI strip, three summary cards

### Goal

Give the page its new top: hero with a status card, a five-number KPI strip, and the row of
three equal cards. Remove `SummaryMetrics` from the page (its numbers move into the strip).

Reference: `mockup-main.html`, from the breadcrumb down to and including the three cards.

### Work

1. **Shared label class.** Add to `app/styles/session.css` (scoped under
   `.commandSessionView`):
   `.sessionEyebrow { color: var(--command-faint); font: 500 11px/1.4 var(--font-ui); letter-spacing: .06em; text-transform: uppercase; }`.
   Every uppercase label in the mockups uses this class.
2. **Hero** (`app/components/dashboard/SessionHero.tsx`). Keep the `<h1>` and
   `.sessionIdentity` line. Changes:
   - Identity line order: project · provider badge · session id (existing `code`) ·
     "Historical snapshot" / "Live session" chip. Use the existing `.commandBadge` styles
     from `workspace.css` for the chip; do not create a new chip component.
   - Summary paragraph max width 78ch; text unchanged.
   - Provider summary row stays (`heroSummarySource` + signal chip).
   - Replace `.sessionMeta` (the two "RECORDED WALL TIME / LAST APPROVAL MODE" groups)
     with a **status card**: `min-width: 260px; padding: 12px 14px; border: 1px solid
     var(--command-line); border-radius: var(--panel-radius); background:
     var(--command-panel)`; grid `8px minmax(0,1fr)`; row 1 = status dot + bold 13 px
     title, row 2 = 12 px muted line. Title copy:
     - live and active: "Live session · active"; dot `--command-green`.
     - live and idle/waiting: "Live session · idle"; dot `--command-line-strong`.
     - needs input: "Live session · needs your input"; dot `--command-amber`.
     - historical: "Recorded session · ended"; dot `--command-line-strong`.
     Second line: `{ended or updated time, shortTime} · {approval mode label} ·
     {SessionWallTimeText} wall time`. Approval mode label comes from the existing
     `SessionHero` logic; reuse, do not duplicate.
   - "Download report" stays as a ghost button under the card (right-aligned column,
     `gap: 12px`). It already exists in `SessionCommandBar`; move the button into the
     hero's right column and delete it from the command bar only if nothing else remains
     in the bar. If the bar keeps other controls, leave the button there and omit it from
     the hero.
3. **KPI strip.** New component `app/components/dashboard/SessionKpiStrip.tsx`:
   `export function SessionKpiStrip({ state, historical }: { state: MonitorState; historical: boolean })`.
   `<section className="sessionKpiStrip" aria-label="Session totals">` with five
   `<div className="sessionKpi">`, `grid-template-columns: repeat(5, minmax(0, 1fr))`,
   each cell `padding: 4px 24px 4px 0`, cells after the first get `padding-left: 24px;
   border-left: 1px solid var(--command-line)`. Cell anatomy: `.sessionEyebrow` label,
   `<strong>` number (30 px/500, `--font-data`), `<small>` 12 px muted caveat.

   | # | Label | Number | Caveat line | Source |
   | --- | --- | --- | --- | --- |
   | 1 | Agents observed | `metrics.agents` | `{active} active · {idle} idle · {finished} finished` where active = status `active`, idle = `idle`+`waiting`+`warm`, finished = `finished`+`stopped`; render "active" segment in `--command-green` when > 0 | `agents[]` |
   | 2 | All-agent context | `compactNumber(metrics.tokens.allAgents)` | "Sum of latest snapshots · not spend" | `metrics.tokens.allAgents` |
   | 3 | Recorded wall time (historical) / Wall time (live) | `SessionWallTimeText` | "Includes idle gaps" | `session.durationMs`, `startedAt` |
   | 4 | Tool calls | `metrics.toolCalls` formatted with thousands separator | `{workflows.length} workflows · {metrics.repeatedCalls} repeated` (omit workflows part when 0) | `metrics.toolCalls`, `workflows`, `metrics.repeatedCalls` |
   | 5 | Agent estimate | `{progress.percent}%` in `--command-green`; "—" when `session.progress` is null | `{phase} · {remaining range} · {confidence} confidence`; when null: "No estimate recorded" | `session.progress` (same fields `SessionProgressPanel` reads) |

   Never show the flow score in the strip. The score stays inside Session details.
4. **Three summary cards.** New component
   `app/components/dashboard/SessionSummaryCards.tsx` rendering
   `<section className="sessionSummaryCards">` with `grid-template-columns: repeat(3,
   minmax(0, 1fr)); gap: 16px`:
   - **Agent estimate card**: wraps the existing `SessionProgressPanel` content. Refactor
     `SessionProgressPanel` so its instrument (`SessionProgressInstrument`) can render
     inside a card without the large header: eyebrow "Agent estimate · progress", phase
     chip on the right, `78%` at 26 px/500 + "agent-reported", 6 px progress bar, then a
     key/value grid (`.sessionKv`, `grid-template-columns: 1fr auto; gap: 6px 16px; font-size: 12px`)
     with Remaining / Confidence / Recorded, then the 11 px note "Snapshot from the
     session transcript, not a Pomegr judgment." Keep the stale/paused behaviors and
     copy that `SessionProgressPanel` already implements.
   - **Workflows card**: eyebrow "Workflows", status chip (Completed / Running / Unknown,
     derived: running if any workflow `status === "running"`, else completed if all
     `completed`, else unknown), big number = `workflows.length`, muted line
     `{agents in workflows} agents · {sum of durationMs formatted} wall · {compactNumber(sum of latest context of those agents)} context`,
     then a `.sessionKv` list of up to 3 workflows (`name` → `{agentIds.length} agents · {formatDuration(durationMs)}`),
     then a link "Open workflow detail" that scrolls to the Agent activity panel and
     expands that workflow group (SP-07 wires the handler; until then render the link
     with `href="#agent-activity"`). When `workflows.length === 0` render the card with
     eyebrow, "0", and the copy "No workflows recorded for this session."
     This card replaces `WorkflowActivityPanel` on the page. Keep the file; SP-07 reuses
     its phase progress list inside group headers. Remove its render from
     `Dashboard.tsx`.
   - **Efficiency signals card**: wrap the existing `InsightsPanel` list. Header row =
     eyebrow "Efficiency signals" + count chip (`{n} attention` in amber border when any
     `level === "warning"`, else `{n} signals`, else "No signals"). Body = existing
     `.insight` rows, max 2 visible, then "Show all {n}" link that expands in place.
     `Insight` has no agent field (`{ id, level, title, detail }`). To link an insight to
     an agent, add an optional `agentId: string | null` to `Insight` and to `LoopPattern`
     in `shared/monitor-contract.ts`, populate them in `monitor/efficiency-signals.mjs`
     where the ids are built (`prompt-cache-miss-${event.agentId}`,
     `automatic-compaction-${agent.id}`, `loop-${loop.actor.id}-${index}`; `overlap-*`
     stays `null`) and in `monitor/session-projection.mjs` ~line 199 (`loop.actor.id`;
     the existing `agent` field there is the label, keep it), and extend the
     api-serialization allowlists for insights and loops. Each warning row with an
     `agentId` gets a "Show agent" link that selects that agent in the roster (SP-08 wires
     selection; until then `href="#agent-activity"`). Move `InsightsPanel` out of
     `.contentGrid`.
5. **Dashboard.tsx order** after this task:
   breadcrumb → command bar (if kept) → `SessionHero` → notices → `SessionKpiStrip` →
   (SP-05 panel placeholder: keep `ContextHistoryPanel` + `RequestSnapshotsPanel` here
   until SP-06) → `SessionSummaryCards` → `contentGrid` with `AgentActivityPanel` only →
   Resource usage (live only) → `SessionDetailsPanel`. Delete the `SummaryMetrics` render
   and the file `app/components/dashboard/SummaryMetrics.tsx` plus its
   `summaryStrip`/`summaryItem`/`metricPopover` CSS (check `tests/ui/` for references
   first and update them).
6. Readiness: KPI strip renders as soon as `readiness.core === "ready"` with "—" in any
   cell whose evidence is still `loading`; do not gate the whole strip behind
   `agentEvidence`. Summary cards keep the existing `activityEvidence` gate that
   `SessionProgressPanel` had.

### Acceptance criteria

- [ ] Page top matches `mockup-main.html` at 1440 px: hero, status card, five KPI cells
      with hairline dividers, three equal-height cards.
- [ ] `SummaryMetrics` no longer exists; flow score is visible only inside Session details.
- [ ] `WorkflowActivityPanel` is no longer rendered on the page (file kept).
- [ ] No number in the strip is a sum across requests or a rate.
- [ ] Light theme renders with the same structure (no hard-coded hex).

### Verification

```powershell
npx vitest run tests/ui/pomegr-design-contract.test.tsx
npx vitest run tests/ui/workflow-activity.test.tsx
npm run typecheck
npm run lint
```

Add `tests/ui/session-kpi-strip.test.tsx` covering: status tally text, "—" when progress
is null, thousands formatting of tool calls, and that the DOM contains no `summaryStrip`.

---

## POMEGR-SP-02 — Collapse Repository and Session details to one-line disclosure rows

### Goal

Bottom of the page becomes two 52 px disclosure rows with a summary on the right, as in the
last section of `mockup-main.html`.

### Work

1. `DashboardDisclosurePanel` already renders a closed-state `summary` prop. Use it.
2. **Repository row**: title "Repository"; summary
   `{repository.branch} · {commits.length} commits · {files.length} files changed · {historical ? "recorded state" : "working tree"}`;
   when `repository.available === false`: "No repository detected". Move `RepositoryPanel`
   out of `SessionDetailsPanel` into its own `DashboardDisclosurePanel`
   (`storageKey="pomegr-disclosure-repository"`, `defaultOpen={false}`).
3. **Session details row**: summary
   `Estimated cost {amount} (Claude Code estimate) · plugin v{pluginVersion} · policy v{policyVersion}`;
   omit segments whose source is null; when nothing is available: "Approval mode, usage
   limits, machinery, activity". `defaultOpen={false}`.
4. Both rows: `min-height: 52px; padding: 0 20px`; chevron 16 px on the left, title
   16 px/600, summary 12 px muted on the right, numbers in `--font-data`.
5. Resource usage panel (live only) stays as a full panel between Agent activity and
   these rows. Do not collapse it.

### Acceptance criteria

- [ ] Both rows closed by default on first visit; open state persists per storage key.
- [ ] Summary text never includes a path, a commit hash longer than 7 characters, or a
      cost when `showEstimatedCost` is false.

### Verification

```powershell
npx vitest run tests/ui/pomegr-design-contract.test.tsx
npm run typecheck
```

Add assertions to an existing UI test that the closed summary text renders and that the
cost segment disappears when the preference is off.

---

## POMEGR-SP-03 — Monitor: request action correlation (Claude adapter)

### Goal

Give every normalized request snapshot two bounded work-kind tallies: the tool results the
model had available before the request, and the tool calls the request issued. Nothing else
about those tools crosses the provider boundary.

Today there is no stored link between a request snapshot and tool calls:
`monitor/providers/claude-context.mjs` `parseClaudeContextRecords` builds one usage
snapshot per assistant record and discards the record's `content[]`;
`monitor/providers/claude.mjs` (lines ~583-606) builds `toolCalls[]` with `id = content.id`
and `workKind = toolWorkKind(tool, { detail, input })`, but that list has no foreign key to
the snapshot. This task adds the link inside the adapter and exposes only counts.

### Work

1. In `monitor/providers/claude-context.mjs`, inside `parseClaudeContextRecords`, walk the
   records in file order and maintain, per `actorId`:
   - `pendingResults: Map<WorkKind, number>` — reset to empty after each assistant record
     that produces a snapshot.
   - `issuedKinds: Map<toolUseId, WorkKind>` — populated from each assistant record's
     `message.content[]` blocks with `type === "tool_use"`, using
     `toolWorkKind(content.name || "Tool", { detail: safeDetail(...), input: content.input || {} })`
     imported from `monitor/work-kind.mjs`. If `safeDetail` lives only in `claude.mjs`,
     move it to a small shared module under `monitor/providers/claude-tool-detail.mjs` and
     import it from both places; do not duplicate it.
   For each record:
   - `type === "user"` with `message.content[]` blocks of `type === "tool_result"`: for
     each block, look up `issuedKinds.get(block.tool_use_id)`; when found increment
     `pendingResults[kind]`, when not found increment `pendingResults["shell"]` only if
     the block carries a `tool_use_id` (unknown tool identity stays generic). Blocks
     without `tool_use_id` are ignored.
   - `type === "assistant"` that yields a snapshot: attach
     `precedingWork = toCounts(pendingResults)` and `issuedWork = toCounts(this record's tool_use blocks)`,
     where `toCounts` returns an array `[{ kind, count }]` sorted by count descending then
     kind ascending, at most 8 entries, each `count` capped at 999. Then reset
     `pendingResults`.
   - Records for other actors do not touch this actor's maps.
   - Snapshots produced by records with no `content[]` array get `precedingWork: []` and
     `issuedWork: []`.
2. Add both fields to the usage snapshot object built at claude-context.mjs ~line 349.
   Add to the adapter schema `evidenceUsageSnapshot` in
   `monitor/providers/provider-contract.mjs` (~line 366) as
   `precedingWork: z.array(evidenceWorkCount).max(8)` and `issuedWork: z.array(evidenceWorkCount).max(8)`
   where `evidenceWorkCount = z.object({ kind: z.enum(WORK_KINDS), count: z.number().int().min(1).max(999) }).strict()`.
   Make both **optional with default `[]`** so the Codex adapter (`monitor/providers/codex-context.mjs`
   or wherever Codex usage snapshots are built) validates unchanged. Codex correlation is
   out of scope; its snapshots carry empty arrays.
3. In `monitor/request-snapshots.mjs` `requestSnapshotFromEvidence`, copy
   `precedingWork` and `issuedWork` through (re-validate bounds: drop unknown kinds, cap 8
   entries, cap 999). Add a third field `precedingAssociation: "transcript_adjacency" | null`
   set to `"transcript_adjacency"` when `precedingWork.length > 0`, else `null`. Add
   `issuedAssociation: "recorded_link" | null` set the same way from `issuedWork`.
4. Compaction handling: a compaction between two assistant records must **clear**
   `pendingResults` for that actor (results before a compaction are not "available" to
   the next request in any reliable sense). `claude-context.mjs` does not parse
   compactions itself; `monitor/providers/claude.mjs` (~line 542-563) collects them via
   `monitor/context-compactions.mjs` (`contextCompactions`, `readContextCompactions`).
   Pass the recognized compaction timestamps for the actor into `parseClaudeContextRecords`
   through `options.compactionTimestamps: string[]` and clear the tally when a compaction
   timestamp falls after the previous assistant record and at or before the current one.
   Do not re-parse compaction records inside claude-context.mjs.
5. Tests, in `tests/claude-context.test.mjs` and `tests/request-snapshots.test.mjs`:
   - assistant with two `tool_use` (Read, Bash `npm test`) → `issuedWork = [{read,1},{test,1}]`.
   - following user record with two `tool_result` for those ids, then an assistant →
     `precedingWork = [{read,1},{test,1}]`, and the first snapshot's `precedingWork` is `[]`.
   - `tool_result` with unknown `tool_use_id` → counted as `shell`.
   - compaction between them → next snapshot `precedingWork = []`.
   - interleaved records for two actors do not cross-contaminate.
   - 9 distinct kinds → only 8 kept, highest counts first.
   - no `content[]` → both arrays empty, snapshot still produced.
   - Existing golden fixture `tests/fixtures/providers/claude/expected-session-evidence.json`
     must be updated with the new fields for `session.jsonl`; regenerate deliberately and
     review the diff by hand.

### Acceptance criteria

- [ ] Every Claude usage snapshot carries `precedingWork` and `issuedWork` arrays bounded
      to 8 entries × count ≤ 999, kinds from `WORK_KINDS` only.
- [ ] No tool name, tool_use id, tool input, file path, or result text is stored on the
      snapshot. `grep -n "tool_use_id\|content.id" monitor/request-snapshots.mjs` returns
      nothing.
- [ ] Codex evidence validates without changes.
- [ ] `npm run test:contracts` passes (provider conformance).

### Verification

```powershell
node --test tests/claude-context.test.mjs
node --test tests/request-snapshots.test.mjs
node --test tests/provider-fixtures.test.mjs
npm run test:contracts
```

---

## POMEGR-SP-04 — Contract, serialization guard, and docs for request actions

### Goal

Expose the new fields through the browser contract, lock the allowlist, and document the
semantics.

### Work

1. `shared/monitor-contract.ts` `RequestSnapshot` gains, after `totalTokens`:

   ```ts
   /** Bounded work-kind tallies. Never a cost per operation. */
   precedingWork: Array<{ kind: WorkKind; count: number }>;
   precedingAssociation: "transcript_adjacency" | null;
   issuedWork: Array<{ kind: WorkKind; count: number }>;
   issuedAssociation: "recorded_link" | null;
   ```

2. `tests/api-serialization.test.mjs` line ~489: extend the exact key list for request
   snapshot items to
   `["agentId","cacheLifetime","cacheReadTokens","cacheWriteTokens","id","issuedAssociation","issuedWork","observedAt","outputTokens","precedingAssociation","precedingWork","totalTokens","uncachedInputTokens"]`
   and assert every `kind` is in the `WORK_KINDS` allowlist and no entry has extra keys.
   Add a fixture sentinel: put a `tool_use` in `tests/fixtures/providers/claude/session.jsonl`
   whose `input.file_path` contains `PRIVATE_PATH_MUST_NOT_LEAK` if one does not already,
   and confirm `assertNoPrivateFixtureSentinels` still passes on `/api/state`.
3. `app/session-report.mjs` and `monitor/session-report*.mjs`: reports embed request
   snapshots through `reportEvidence`. Either pass the new fields through the same
   allowlist or strip them; pick **strip** (reports stay unchanged) and add an assertion in
   `tests/session-report-evidence.test.mjs` that report items have no `precedingWork`.
4. `docs/METRICS.md` → section `## Request snapshots`: add a paragraph:

   > Each request may carry two bounded work-kind tallies. `issuedWork` counts the
   > tool calls contained in the same assistant record (`recorded_link`). `precedingWork`
   > counts tool results recorded for the same agent between the previous model request
   > and this one (`transcript_adjacency`); a compaction between them clears the tally.
   > Each tally keeps at most 8 kinds with counts capped at 999. These describe what the
   > model could see or asked for; they never attribute tokens to an operation, and
   > Pomegr never ranks operation categories by accumulated tokens. Codex snapshots carry
   > empty tallies until its transcript structure is validated separately.

   Also update the "Request snapshots are not context history…" paragraph to say the
   Requests & actions view draws the prompt size outline (uncached + cache write + cache
   read) per request and that this outline replaces the former Context history panel as
   the visible context level, while `contextHistory` stays in the API for reports and
   the Home view.
5. `docs/OBSERVATION_CACHE.md` → `## Presentation rules`: add one bullet: "Requests &
   actions renders only committed request snapshots; window, selection, and sort are
   frontend view state and never trigger acquisition."
6. `AGENTS.md` → the request-snapshot bullet under Security and privacy invariants: append
   "and bounded per-request work-kind tallies with a fixed association label".

### Acceptance criteria

- [ ] `npm run typecheck` passes with the new contract fields used nowhere yet in `app/`.
- [ ] api-serialization allowlist test updated and green.
- [ ] METRICS.md, OBSERVATION_CACHE.md, AGENTS.md updated as written above.

### Verification

```powershell
node --test tests/api-serialization.test.mjs
node --test tests/session-report-evidence.test.mjs
npm run typecheck
npm run check:provider-docs
```

---

## POMEGR-SP-05 — Requests & actions panel

### Goal

Build the hero chart panel exactly as drawn in `mockup-main.html` (section
"Requests & actions"): a 60-request window of bars, a minimap of all retained requests,
a selected-request detail card, and a Largest requests list, with the interactions defined
below.

### Data model (frontend only, `app/components/dashboard/requests-actions/model.ts`)

All pure functions, unit-tested without React.

```ts
export type RequestScope = "all" | string; // agent id
export type ChartMode = "fresh" | "full";
export type LargestSort = "uncachedInput" | "output" | "cacheWrite" | "total";

export type RequestRow = RequestSnapshot & {
  ordinal: number;            // 1-based position in the scoped, chronological list
  promptTokens: number;       // uncached + cacheWrite + cacheRead
  freshTokens: number;        // uncached + cacheWrite + output
  compactionBefore: boolean;  // a contextHistory boundary for this agent falls between the previous scoped row and this one
};

export function scopedRows(feed: RequestSnapshotFeed, boundaries: ContextHistoryBoundary[], scope: RequestScope): RequestRow[];
export function windowFor(rows: RequestRow[], selectedOrdinal: number | null, size: 60): { start: number; end: number }; // 1-based inclusive, clamps at edges, centers selection
export function scaleMax(rows: RequestRow[], mode: ChartMode): number; // max over the scoped rows (not the window) of promptTokens; "nice" rounded up (1.2/1.5/2/3/4.5/6/8 × 10^n); fixed across window moves
export function largestRequests(rows: RequestRow[], sort: LargestSort, limit: number): RequestRow[]; // stable: ties broken by ordinal ascending
```

Rules:
- `ordinal` is the position inside the retained, scoped feed. Show it as `#842`. Document
  in the panel footer: "Numbers are positions in the retained feed (latest 100 per
  agent), not provider ids."
- Scope "all" merges agents chronologically (the feed is already chronological).
- Compaction: a `ContextHistoryBoundary` with `kind` `automatic_compaction` or
  `manual_compaction` whose `agentId` matches and whose `timestamp` is > previous row's
  `observedAt` and ≤ this row's `observedAt`. `snapshot_drop` is not drawn.

### Layout (measurements from the mockup)

- Panel: `.card` grammar (`panel` class). Header 52 px: title "Requests & actions",
  eyebrow "One bar per model request", legend (Uncached input, Cache write, Output,
  Prompt size outline, Compaction dashed), right side: mode chips "Fresh tokens" /
  "Full breakdown" (segmented, `aria-pressed`), divider, agent scope `CommandSelect`
  labeled "Agent scope" (options: "All agents", then each agent by `agentDisplayName`,
  ordered as `agentTreeRows`).
- Chart: inline SVG, `viewBox="0 0 1112 246"`, height 246 px, width 100%. Plot area x
  56→1100, y 26→222. Five horizontal grid lines at 0 / 25 / 50 / 75 / 100 % of
  `scaleMax`. Y labels right-aligned at x=50 in `--font-data` 11 px: `compactNumber`.
  X labels under the plot at y=238: first ordinal left, middle ordinal + `shortTime`
  centered, last ordinal right.
- Bars: 60 per window, gap 3 px, width `(1044 - 3*59)/60`. For each row:
  - outline rect from `promptTokens` down to baseline, fill `--command-panel-2` at 60 %
    opacity, stroke 1 px outline color (mapping table), selected: stroke
    `--command-brand-text`, fill `color-mix(in srgb, var(--command-brand-text) 12%, var(--command-panel))`.
  - fresh mode: stacked from baseline: uncached (`--color-context`), cache write
    (`--command-green`), output (`--command-amber`).
  - full mode: stacked from baseline: uncached, cache write, cache read (fill
    `color-mix(in srgb, var(--command-line-strong) 45%, transparent)`), output; no
    outline.
  - `compactionBefore`: dashed vertical line `--command-amber` at the bar's left gap,
    label "compaction" 10 px above the plot.
  - selected bar gets `#ordinal` label above it in 11 px coral.
  - each bar is a `<g role="button" tabIndex={0} aria-label="Request #842, 12,600 uncached input, ...">`
    with `onClick` and Enter/Space selecting it.
- Minimap under the chart: 26 px tall SVG spanning all scoped rows; one 0.7 px rect per
  row, height ∝ `freshTokens` (fresh mode) or `promptTokens` (full mode) relative to the
  scoped max, color `--command-line-strong`; the current window drawn as a rect with 1 px
  coral stroke and 13 % coral fill. Drag the window rect or click anywhere on the minimap
  to move the window (pointer events; touch-action none on the SVG). Left label "All
  {n}" in 11 px muted.
- Below the chart, a two-column area `minmax(0,1fr) 420px` separated by a 1 px line:
  - **Selected request** (left, padding 16/20): title `Request #842` 15 px/600, subtitle
    `{agentDisplayName} · {shortTime with seconds} · cache lifetime {cacheLifetimeLabel}`;
    Prev / Next ghost buttons (32 px). Four stat boxes in a 4-column grid (1 px border,
    4 px radius, padding 10/12): Uncached input, Cache write, Cache read (muted), Output,
    each an eyebrow with an 8 px swatch and a 20 px/500 `--font-data` number with
    thousands separators. Then a 2-column grid: "Results available before ·
    transcript adjacency" and "Actions issued by request · recorded link" (association
    text lowercase, `--command-line-strong`), each a wrap of chips
    `{WORK_LABELS[kind]}{count > 1 ? " ×" + count : ""}` using `AgentChip`. When a list is
    empty render "None recorded" in muted 12 px. Footer note 11 px:
    "Surrounding actions do not establish token cost per operation. Uncached input is
    what the model had not seen before this request."
    When `cacheWriteAvailable` is false (Codex), hide the Cache write box and the cache
    write stack segment, keep the layout at 3 columns.
  - **Largest requests** (right): eyebrow "Largest requests" + sort chip that cycles
    `uncachedInput → output → cacheWrite → total` on click (label "by uncached input",
    "by output", "by cache write", "by total"; skip cacheWrite when unavailable). Five
    rows: `48px minmax(0,1fr) 64px`, padding 8/20, top border. Row = `#ordinal` mono,
    agent name 12 px/500 (ellipsis), second line `before: {kinds joined ", " with ×n}`
    (or "before: none recorded"), a 3 px bar whose width is the value relative to the
    first row, and the value right-aligned in mono (`compactNumber`). Selected row:
    `background: var(--command-panel-2); box-shadow: inset 2px 0 0 var(--command-brand-text)`.
    Footer: "Individual request measurements, never summed" and a "Show 20" link that
    grows the list to 20 rows (then "Show 5").
- Empty / unavailable: when `requestSnapshots.status === "unavailable"` render the panel
  header plus `EmptyState` text "No request observations for this session yet." and no
  chart. When `readiness.contextEvidence === "loading"` keep the existing skeleton gate
  in `Dashboard.tsx`.

### Interactions (exact)

1. Initial selection = the newest row in scope. Window = `windowFor(rows, selected, 60)`.
2. Click a bar → select it (window unchanged).
3. Click a Largest row → if the row's `agentId` differs from a non-"all" scope, set scope
   to that agent first; then select the row and recompute the window centered on it.
4. Prev / Next and ArrowLeft / ArrowRight (when focus is inside the chart) → move
   selection by one ordinal; when the new selection leaves the window, shift the window
   by one so it stays visible (do not re-center).
5. Enter on a focused Largest row = click.
6. Changing scope → selection = newest row in the new scope; window recomputed.
7. Changing mode → no change to selection or window; `scaleMax` recomputed.
8. Minimap drag → window moves; selection unchanged even if it leaves the window (the
   detail card keeps showing it; the bar highlight is simply off-screen).
9. Session change (`key` on the panel) resets everything.
10. Live sessions append rows every poll. If the selection was the newest row and the
    window was at the end, follow the newest row; otherwise keep the selection and
    window still.

### Files

- `app/components/dashboard/RequestsActionsPanel.tsx` (the panel; keep under 800 lines,
  split the chart into `requests-actions/RequestBarsChart.tsx`, the minimap into
  `requests-actions/RequestMinimap.tsx`, the list into
  `requests-actions/LargestRequestsList.tsx`).
- `app/components/dashboard/requests-actions/model.ts`.
- Styles: new block in `app/styles/evidence.css` under a comment
  `/* Requests & actions */`, class prefix `requestsActions*`. Reuse `.contextScopeControl`
  for the select.
- Props:

  ```ts
  export function RequestsActionsPanel({ agents, requestSnapshots, contextBoundaries, cacheWriteAvailable, historical }: {
    agents: Agent[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
    cacheWriteAvailable: boolean; historical: boolean;
  })
  ```

- `Dashboard.tsx`: render it inside the `contextEvidence` readiness gate, in the position
  locked in the design decisions, with
  `contextBoundaries={data.metrics.tokens.contextHistory.boundaries}`.
- Cache evidence list (the `cacheEvidenceSection` currently inside
  `RequestSnapshotsPanel`): move it into a `DashboardDisclosurePanel` titled
  "Cache evidence" (`storageKey="pomegr-disclosure-cache-evidence"`, closed by default,
  summary `{n} events`) rendered directly under Requests & actions. Keep its markup and
  tests; only the container changes.

### Tests

`tests/ui/requests-actions.test.tsx` (copy the pattern from
`tests/ui/request-snapshots.test.tsx`) covering: bar count equals window size; selected
bar has the coral stroke class; clicking a Largest row outside the window recenters the
window (assert first/last ordinal labels); Prev at window start shifts the window by one;
scope change resets selection to newest; fresh mode has no cache-read stack rect; full
mode has no outline rect; Codex (`cacheWriteAvailable=false`) hides the cache write box;
association labels render; empty lists render "None recorded"; unavailable feed renders
the empty state.

`tests/ui/requests-actions-model.test.ts` for `model.ts`: ordinal assignment, window
clamping at both ends, `scaleMax` rounding, compaction detection across scope "all",
largest sort tie-break.

### Acceptance criteria

- [ ] Visual parity with the mockup at 1440 px in dark and light themes.
- [ ] All ten interactions above behave as written.
- [ ] No cumulative sum, average, or rate anywhere in the panel. `grep -n "reduce(" app/components/dashboard/requests-actions/` only hits `scaleMax`/`largestRequests`/minimap helpers, never a displayed total.
- [ ] Panel file sizes stay under the 800-line architecture limit.

### Verification

```powershell
npx vitest run tests/ui/requests-actions.test.tsx
npx vitest run tests/ui/requests-actions-model.test.ts
npm run typecheck
npm run lint
npm run check:architecture
```

---

## POMEGR-SP-06 — Remove Context history and Request snapshots panels and the display preference

### Goal

Delete the two superseded panels and the "Context history" settings toggle.

### Work

1. Delete `app/components/dashboard/ContextHistoryPanel.tsx` and
   `app/components/dashboard/RequestSnapshotsPanel.tsx`. Move the pure helpers other
   modules import (`monotonePath`, `snapshotEventKey`, any exported formatter) into
   `app/components/dashboard/requests-actions/` if still used, otherwise delete.
2. Delete `tests/ui/context-history.test.tsx` and `tests/ui/request-snapshots.test.tsx`;
   port any assertion that still applies (cache evidence list behaviors) into
   `tests/ui/requests-actions.test.tsx`. Update `tests/ui/pomegr-design-contract.test.tsx`.
3. Remove `contextHistory` from `DisplayPreferences` in
   `app/hooks/DisplayPreferencesContext.tsx` (keep `estimatedCost`). Tolerate the stale
   key in stored JSON (`pomegr-display-preferences-v1`) by ignoring unknown keys. Remove
   the `context-history-visible` `PreferenceRow` from `app/settings/SettingsPage.tsx`.
   Desktop bridge: `setDisplayPreference` must reject or ignore `"contextHistory"`;
   update `desktop/` handlers and `tests/desktop-*.test.mjs` that enumerate preference
   keys.
4. Delete CSS: `.contextHistory*`, `.requestSnapshot*` (except what SP-05 reused and
   renamed), `.contextAreaChart`, `.contextSeriesLine`, `.contextChartPoint`,
   `.contextBoundary*` from `evidence.css`, `session.css`, `workspace.css`. Keep
   `.cacheEvidence*`.
5. The Home page (`app/HomeDashboard.tsx`) uses `HomeContextHistory`; leave it untouched.
   The API keeps `metrics.tokens.contextHistory` (reports and Home depend on it).
6. `docs/METRICS.md` `## Context history`: add a first line "Presented on the Home page
   and in focused reports; on the session page the context level is the prompt-size
   outline of Requests & actions."

### Acceptance criteria

- [ ] `grep -rn "ContextHistoryPanel\|RequestSnapshotsPanel\|contextHistory:" app/ desktop/ tests/ui` returns only Home/report references.
- [ ] Settings shows one toggle under Data display.
- [ ] Desktop preference tests pass.

### Verification

```powershell
npm run test:ui
node --test tests/desktop-behavior.test.mjs tests/desktop-shell.test.mjs
npm run lint
npm run check:boundaries
```

---

## POMEGR-SP-07 — Agent activity roster: groups, rollups, bounded region, distribution strip, filter bar

### Goal

Rebuild the List mode of `AgentActivityPanel` as the grouped, bounded roster drawn in
`mockup-main.html` (section "Agent activity", left column). The inspector column is SP-08;
this task renders the roster full-width with a placeholder right column of fixed 340 px
containing `EmptyState` "Select an agent".

### Grouping model (`app/components/dashboard/agent-roster/groups.ts`, pure, tested)

```ts
export type RosterGroup = {
  id: string;                          // "primary" | "direct" | `workflow:${workflowId}`
  kind: "primary" | "direct" | "workflow";
  title: string;                       // "Primary agent" | "Direct subagents" | workflow.name
  subtitle: string | null;             // direct: first two agent names + " and N more"; workflow: `phase {label}` of the newest phase with agents, else null
  agents: Agent[];                     // provider order (workflowOrder asc, then label), Primary excluded from other groups
  rollup: { agents: number; context: number; wallMs: number; toolCalls: number; statuses: Record<Agent["status"], number> };
  workflow: Workflow | null;
};
export function buildRosterGroups(agents: Agent[], workflows: Workflow[]): RosterGroup[];
export function statusTally(agents: Agent[]): { finished: number; idle: number; active: number; stopped: number; other: number };
export function roleTally(agents: Agent[]): Array<{ role: AgentRole; count: number }>; // desc by count
```

Rules:
- Primary = `agent.id === "primary"`. Direct = `parentId === "primary" && workflowId === null`.
  Workflow groups = agents whose `workflowId` matches, ordered by `workflowOrder` then
  label. Agents with a `workflowId` not present in `workflows[]` form a trailing group
  `workflow:unknown` titled "Unassigned workflow". Nested subagents of a direct subagent
  belong to "Direct subagents" too, rendered with the existing `--agent-indent` rail.
- `rollup.context` = sum of `agent.tokens.total` (latest snapshots; this is the existing
  All-agent context rule applied to a subset, label it "context"). `wallMs` = sum of
  `liveWallTimeMs` per agent. `toolCalls` = sum of `agent.toolCalls`.
- Status tally buckets: finished = `finished`; stopped = `stopped`; active = `active`;
  idle = `idle` + `waiting` + `warm` + `needs_input`; other = `unknown`.

### Layout

- Panel header (52 px): "Agent activity", `{n} observed · showing {visible}`, right: view
  chips "List" / "Grid" (`aria-pressed`, `onViewModeChange`). Remove the "Tree" chip.
- **Distribution strip** (padding 14/20, bottom border): an 8 px segmented bar
  (`display: flex; gap: 3px`, segments `flex: count`, colors: finished
  `--command-line-strong`, idle transparent with inset 1 px `--command-line-strong` ring,
  active `--command-green`, stopped `--red`, other `--command-line`), then a legend row
  with counts on the left and a role legend on the right (`WORK_LABELS` is for work kinds;
  roles use the `AgentRole` string as-is, e.g. "workflow-worker"). Omit zero-count
  entries except the four status ones, which always show.
- **Filter bar** (padding 10/20, bottom border): text input "Filter agents" (260 px,
  32 px tall, filters by label/assignment substring, case-insensitive), chip "Group by
  workflow" (pressed by default; unpressed = one flat group in `agentTreeRows` order with
  the rail indent), `CommandSelect` "Status · all" (options: all, active, idle, finished,
  stopped), `CommandSelect` "Model · all" (distinct `agent.model` values), the existing
  finished toggle relabeled "Hide finished" (pressed = hide; storage key unchanged), and
  on the right "Sort" + `CommandSelect` (Provider order, Final context desc, Wall time
  desc, Tool calls desc; sorts within groups; group order never changes).
- **Column header** (32 px, eyebrow style): blank (28) · Agent · Final context (92, right)
  · Wall time (96, right) · Calls (72, right) · Cache TTL (84, right) · Status (96) · blank
  (24). Grid `28px minmax(0,1fr) 92px 96px 72px 84px 96px 24px`, gap 0 12px, padding
  `0 12px 0 8px`.
- **Roster region**: `height: 560px; overflow-y: auto; position: relative`. Bottom fade
  (36 px gradient to panel color, pointer-events none). Footer (40 px): "Scroll inside
  the roster · groups stay pinned" and "Expand all {n}" / "Collapse all".
- **Primary row**: always first, pinned (`position: sticky; top: 0; z-index: 2`, background
  `color-mix(in srgb, var(--command-panel) 50%, var(--command-panel-2))`).
- **Group header row** (40 px, sticky under the primary row: `top: 40px; z-index: 1`,
  same background as primary): caret (16 px, rotates 90° when open), title 13 px/600 with
  muted subtitle, right side rollup `{agents} agents · {compactNumber(context)} context ·
  {formatDuration(wallMs)} wall · {toolCalls} calls · {status summary}` where status
  summary is "completed" (workflow status completed), "running", or a two-part idle /
  finished tally as in the mockup. Whole header is a `<button aria-expanded>`.
  Workflow group headers additionally render the existing phase progress list from
  `WorkflowActivityPanel` (`workflowPhaseProgress`) as a second 28 px line **only when
  expanded**.
- **Agent row** (40 px, grid as the column header, bottom border `--command-panel-2`,
  hover `color-mix(in srgb, var(--command-panel-2) 60%, var(--command-panel))`):
  role glyph (`RoleGlyph` in `AgentTreeView.tsx` is module-private today; move it to a
  new `app/components/dashboard/agent-tree/RoleGlyph.tsx`, export it, import it in both
  places; 16 px, muted), name 13 px/500 +
  muted 12 px meta `{role} · {model} · {effort} · {skills.length ? "N skills · " : ""}{executionTasks.length} shell tasks`
  (single line, ellipsis) + optional amber chip `repeat ×N` when the agent has a
  repetition insight (`insights` filtered by the `agentId` added in SP-01; pass
  `insights` and `loops` as new props; N = `repeats` of the `loops[]` entry whose
  `agentId` matches, else omit the number) +
  existing `AgentHistoryIndicators` (compaction / refill) + signal chip when
  `agent.signal`; final context mono bold; wall (`AgentWallTimeText`); calls; cache TTL
  (`cacheLifetimeLabel` without the "cache TTL" prefix); status pill (existing
  `.statusPill` styles, uppercase 11 px); chevron. Row is a `<button>` (or
  `role="row"` with an inner button) that selects the agent (SP-08). Selected row:
  `background: var(--command-panel-2); box-shadow: inset 2px 0 0 var(--command-brand-text)`.
- "Show {n} more in {group}" row: when a group has more than 8 agents, render the first
  8 and a 36 px link row that reveals the rest of that group (state per group id).
- Popovers for skills / execution tasks / plan tasks are **removed from rows**; their
  content moves to the inspector (SP-08). Until SP-08 lands, keep the popover code in the
  file but do not render the triggers.
- Persisted state (localStorage, per session id): open groups
  (`pomegr-agent-roster-open-${sessionId}`, JSON array of group ids), view mode (existing
  key, values now `"list" | "grid"`; treat stored `"tree"` as `"list"`).

### Acceptance criteria

- [ ] With 49 agents the page height does not depend on the agent count; the roster
      region is 560 px and scrolls internally.
- [ ] Group headers and the primary row stay visible while scrolling the region.
- [ ] Rollup numbers are sums of latest snapshots and are labeled "context", never
      "tokens used".
- [ ] Filter, status, model, sort, hide-finished combine (AND) and never reorder groups.
- [ ] `agentsWithFinishedVisibility` still keeps ancestors of visible agents.

### Verification

```powershell
npx vitest run tests/ui/agent-roster-groups.test.ts
npx vitest run tests/ui/agent-roster.test.tsx
npx vitest run tests/ui/agent-detail-popovers.test.tsx
npx vitest run tests/ui/workflow-activity.test.tsx
npm run typecheck
```

New tests: `agent-roster-groups.test.ts` (grouping rules, tallies, unknown workflow
group, nested direct subagents) and `agent-roster.test.tsx` (sticky classes present,
collapse/expand, show-more, filters AND, sort within group, stored view mode "tree"
coerces to list).

---

## POMEGR-SP-08 — Agent inspector with lineage strip

### Goal

Fill the 340 px right column with the selected agent's full evidence, as drawn in
`mockup-main.html` (Agent activity, right column) including the Lineage block.

### Work

1. New component `app/components/dashboard/agent-roster/AgentInspector.tsx`:

   ```ts
   export function AgentInspector({ agent, agents, workflows, sessionId, historical, requestSnapshots, cacheRefills, cacheReadDrops, contextBoundaries, insights, planTasks, onOpenTree }: {
     agent: Agent | null; agents: Agent[]; workflows: Workflow[]; sessionId: string; historical: boolean;
     requestSnapshots: RequestSnapshotFeed; cacheRefills: CacheRefillCount[]; cacheReadDrops: CacheReadDropCount[];
     contextBoundaries: ContextHistoryBoundary[]; insights: Insight[]; planTasks: PlanTask[];
     onOpenTree: (agentId: string) => void;
   })
   ```

   Background `color-mix(in srgb, var(--command-ground) 40%, var(--command-panel))`,
   sections separated by 1 px lines, each `padding: 14px 20px` (header 16/20/12):
   - **Header**: eyebrow "Selected agent"; name 15 px/600 + status pill; muted line
     `{role label} · {workflow name} · phase {phase label}` (omit missing parts);
     the agent's short id in mono (`agent.id` is the normalized id and is already
     browser-visible; show its last 6 characters).
   - **Lineage**: eyebrow "Lineage" + right link "Open in tree" (tree glyph 14 px) →
     `onOpenTree(agent.id)`. Vertical list with 7 px dots joined by 1 px 10 px
     connectors: Primary agent (ring dot) → each ancestor via `parentId` → workflow
     (filled dot, `{name} · {agentIds.length} agents`) → phase (`{label} · {siblings} siblings`)
     → the agent (coral dot, bold, `· no children` or `· N children`). Right column:
     `compactNumber` of context for agents, rollup context for workflow/phase. Skip
     workflow/phase rows when the agent has none.
   - **Facts** `.sessionKv`: Model, Effort, Final context (lavender), Wall time
     (`AgentWallTimeText`), Tool calls, Shell tasks (`executionTasks.length`), Cache
     lifetime (`cacheLifetimeLabel`), Last turn (existing `AgentTurnCacheTiming` in plain
     mode), Skills (count, then a list of `{name} ×{calls}` up to 6).
   - **Signals**: insights whose agent matches (amber warning glyph, 16 px) + the
     `AgentHistoryIndicators` content expanded as rows: compaction count, "Possible cache
     refill ×N · inference", cache-read drops. Each refill row opens the existing
     `CacheEvidencePopover`. When none: "No signals".
   - **Shell tasks** `{n}`: reuse `ExecutionTaskRow` for the first 4 (running first,
     then newest), link "All" expands to all retained rows (cap is 30 per agent; say
     "latest 30" in the eyebrow when `n === 30`). Rows show the 7 px status dot, label,
     and `exit {code}` in mono (red when non-zero).
   - **Plan checklist**: only when `agent.id === "primary"` and `planTasks.length > 0`;
     reuse the existing plan popover list markup inline with its "agent-maintained,
     may be stale" caution.
   - **Actions** (bottom, `margin-top: auto`): `CopyTranscriptButton` (existing gating
     by `useClientAccess`), rendered as a ghost button with label "Copy transcript
     path".
   - `agent === null`: `EmptyState` "Select an agent to inspect it."
2. Selection state lives in `AgentActivityPanel`: `selectedAgentId` (default: the
   primary agent), persisted per session (`pomegr-agent-roster-selected-${sessionId}`).
   Selecting an agent inside a collapsed group expands that group and scrolls the row
   into view (`scrollIntoView({ block: "nearest" })`).
3. Move the skills / execution / plan popover code out of `AgentActivityPanel.tsx`
   (delete it; the inspector replaces it). Update `tests/ui/agent-detail-popovers.test.tsx`
   to assert the same content in the inspector, and rename the file to
   `agent-inspector.test.tsx`.
4. Responsive: below 900 px the inspector renders under the roster as a full-width
   section; below 720 px it becomes a `DashboardDisclosurePanel` "Selected agent".

### Acceptance criteria

- [ ] Every datum previously visible in a list row or its popovers is visible in the
      inspector for the selected agent.
- [ ] Lineage lists the correct ancestor chain for nested subagents and workflow workers.
- [ ] Copy transcript path remains the only place a path can be obtained, still behind
      `canCopyTranscriptPath`.

### Verification

```powershell
npx vitest run tests/ui/agent-inspector.test.tsx
npx vitest run tests/ui/agent-roster.test.tsx
npx vitest run tests/ui/reported-signals.test.tsx
npm run typecheck
```

---

## POMEGR-SP-09 — Grid view mode

### Goal

Add the "Grid" tab drawn in `mockup-agentgrid.html`.

### Work

1. New component `app/components/dashboard/agent-roster/AgentGridView.tsx` receiving the
   same groups (`buildRosterGroups`), `selectedAgentId`, `onSelect`, `insights`, and a
   `metric: "context" | "wall" | "toolCalls"` state (chips "Final context" / "Wall time"
   / "Tool calls" in a 10/20 toolbar; default context; persisted
   `pomegr-agent-grid-metric-${sessionId}`).
2. Layout: one lane per group (`grid-template-columns: 160px minmax(0,1fr); gap: 14px;
   padding: 14px 0; border-top: 1px solid var(--command-panel-2)`), lane header = title
   13 px/600, subtitle muted 12 px (`{role or "N agents"} · {status summary}`), rollup
   line mono. Tiles in `grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px`
   (4 columns below 1100 px, 2 below 720 px).
3. Tile (64 px, padding 8/10, 1 px border, 4 px radius): name 12 px/500 ellipsis; bottom
   line mono 11 px `{toolCalls} calls` (or `{wall}` / `{context}` depending on metric,
   the metric value always on the right); 3 px bar at the bottom whose width =
   value / max value across **all agents in the session** for that metric; bar color
   lavender (context), green (wall), muted (tool calls). Border by status: finished =
   `--command-line`, idle = dashed `--command-line-strong`, active = `--command-green`
   with green-tinted background, stopped = `--red`; agent with a warning insight =
   `--command-amber` border and amber bar; selected = coral border + 1 px coral ring.
   Tile is a `<button aria-pressed>`; clicking selects the agent and the inspector on
   the right updates (inspector stays visible in grid mode).
4. Filters from SP-07 apply to the grid (hidden agents are omitted; lanes with zero
   visible agents are omitted). Grid region has the same 560 px bounded height.
5. Footer: "Click a tile to open it in the inspector · bar length is the tile metric
   relative to the largest agent in the session" and "Latest snapshots only, never
   cumulative spend".
6. `AgentActivityViewMode` becomes `"list" | "grid"`.

### Acceptance criteria

- [ ] 49 agents render as 49 tiles with no page growth.
- [ ] Bar widths are relative to the session max, not the lane max.
- [ ] Keyboard: tiles are tabbable, Enter/Space selects.

### Verification

```powershell
npx vitest run tests/ui/agent-grid.test.tsx
npm run typecheck
npm run lint
```

---

## POMEGR-SP-10 — Tree as focused drill-down

### Goal

The tree opens from the inspector centered on one agent, as drawn in
`mockup-focusedtree.html`, and is no longer a tab.

### Work

1. `AgentActivityPanel` gains state `treeFocusId: string | null` (not persisted). When
   set, the panel body (distribution strip, filter bar, roster, inspector) is replaced by
   the tree view; the header shows a back link "← Agent activity" and the title
   `Tree · focused on {agentDisplayName}`; Escape and the back link clear the focus.
2. `topology.ts`: add `focusVisualForest(forest: AgentTreeForest, focusId: string): AgentTreeVisualForest`
   that keeps the focus node, all its ancestors, the focus node's direct children, and the
   focus node's siblings; every other sibling set (children of an ancestor that are not
   on the path) collapses into one `AgentTreeCluster` per parent regardless of label
   (label `{parent label} · {n} more` or, for workflow/phase groupings, the workflow or
   phase label). Reuse the existing cluster shape so `ClusterCard` renders unchanged;
   clicking a cluster expands it in place (existing `toggle`).
3. `AgentTreeView` gains props `focusId?: string | null` and `mode?: "session" | "ancestors"`
   (toolbar chips "Ancestors" / "Whole session", default ancestors; whole session =
   existing `buildVisualForest`). On mount with a focus: fit the camera to the focus path
   bounds (`fitCamera` over the rects of path nodes) and give the focus node keyboard
   focus. Focus node card: coral border + ring (`.agentTreeCard.isFocus`); path
   connectors coral 1.5 px (`.agentTreeConnectors path.isHot`); an amber border when the
   agent has a warning insight.
4. Group headers in the roster get a small tree glyph button "Open in tree" that calls
   the same handler with the group's first agent (workflow) so the subtree is centered.
5. Footer: "Focus path: Primary › {workflow} › {phase} › {agent}" and "Layout follows
   provider evidence order · numbers are latest snapshots".
6. The rail form (`agentTreeView-rail`) stays for narrow widths.
7. Remove the "Tree" storage value handling left from SP-07.

### Acceptance criteria

- [ ] A 49-agent session focused on a leaf renders no more than ancestors + siblings +
      children + one cluster per off-path parent.
- [ ] Back link and Escape restore the roster with the same selection.
- [ ] Existing `tests/ui/agent-tree-layout.test.ts` still passes; new
      `focusVisualForest` tests cover a leaf, the primary, and a workflow worker.

### Verification

```powershell
npx vitest run tests/ui/agent-tree-layout.test.ts
npx vitest run tests/ui/agent-tree-focus.test.tsx
npm run typecheck
```

---

## POMEGR-SP-11 — Responsive, accessibility, dead CSS removal, final verification

### Goal

Ship-ready page across widths and themes, with nothing left over.

### Work

1. Breakpoints (existing ones in `session.css`: 900 px and 520 px; `evidence.css`: 720 px
   and 420 px):
   - ≤ 1100 px: KPI strip 3 + 2 columns; summary cards 1 column; Requests & actions
     detail area stacks (largest list under the detail card); roster columns drop Cache
     TTL and Calls (they remain in the inspector).
   - ≤ 900 px: hero stacks; inspector under roster; grid 4 columns.
   - ≤ 720 px: roster becomes the existing mobile row layout (two lines per agent), region
     height 60vh; chart window size 30; minimap hidden; grid 2 columns.
   - ≤ 520 px: KPI strip 2 columns; chart window 20.
2. Accessibility: every chart bar, tile, row, and group header reachable by keyboard with
   a visible focus ring (`--focus-ring`); segmented chips use `aria-pressed`; the roster
   region has `aria-label="Agent roster"`; live regions for selection changes are not
   needed (selection is user-initiated). Respect `prefers-reduced-motion` for the
   caret rotation and any transition.
3. Remove dead CSS and components: `SummaryMetrics`, `WorkflowActivityPanel` (if the
   phase list moved into the roster group header, delete the file and its test), old
   `.agentRow` popover anchors, `.agentViewMode` tree button styles, `.contentGrid-tree`.
   Run `grep -rn "className=\"" app | grep -o 'class[A-Za-z]*' | sort -u` against
   `evidence.css` selectors to find orphans; delete orphans only when no test references
   them.
4. Docs: `docs/METRICS.md` entries touched by SP-04/SP-06 re-read for consistency;
   `README.md` screenshots or feature bullets that mention "Context history" or "Request
   snapshots" updated to "Requests & actions".
5. Mark this plan's header with the status blockquote used by
   `docs/plans/provider-neutral-session-observation-cache.md` once every task is done.

### Acceptance criteria

- [ ] `npm run verify` passes (includes build, plugin tests, UI tests, landing).
- [ ] Manual check at 1440 / 1100 / 900 / 720 / 390 px in both themes against the mockups.
- [ ] `/api/state` serialization test still green; no new browser-visible field beyond
      the four added in SP-04.

### Verification

```powershell
npm run verify
npm run verify:desktop
```

---

## Non-goals (do not do these inside any task)

- Codex request-action correlation. Codex snapshots carry empty tallies; the UI shows
  "None recorded".
- Raising the 100-per-agent request snapshot cap. If a session needs more, open a
  separate decision; the minimap label "All {n}" describes retained requests.
- Any per-operation cost, token attribution, or "most expensive tool" ranking.
- Changing the Home page, sidebar, Agents page, or focused reports.
- Persisting any of the new frontend view state outside localStorage.

## Progress log

| Date | Task | Result | Notes |
| --- | --- | --- | --- |
| 2026-09-04 | Plan | Written | Mockups copied to `docs/plans/session-page-redesign/`. Canvas: https://claude.ai/code/artifact/663c33bb-fb5f-41ba-9e78-8c11e0219ba2 |
