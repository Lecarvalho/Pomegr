# Session overview sparse state and link rule

> Status: active; design approved on the canvas on 2026-09-20, no code written yet.
> Created: 2026-09-20.
> Scope: make the session **Overview** tab read well when a session has just started, and stop repeating brand-colored text links on panel headers and evidence rows (Overview and Signals tabs, desktop and phone). UI only: no monitor, contract, or API change.
> Continuation owner: the agent that picks up this plan in a fresh session; the user reviews the result against the artboards.
> Authority: working checklist. `AGENTS.md`, `DESIGN.md`, and `docs/METRICS.md` stay authoritative; this plan changes `DESIGN.md` in task 1 and task 6.
> Next task or decision: start task 1. Do the tasks in order; each ends with a command that must pass before the next begins.
> Completion criteria: every checkbox below is ticked with its verification recorded under the continuation checkpoint, `npm run verify:fast` and `npm run test:ui` pass, and the running app matches the artboards listed below apart from the written differences.
> Permanent destinations: `DESIGN.md` (link rule, heading link, sparse overview rule), `/design-system` (heading link sample), and the information architecture redesign plan's T08 (Repository tab links).
> Lifetime: temporary; delete this file in the change that completes the last task. The artboards stay with the [information architecture redesign plan](ia-redesign.md), which owns their deletion.

## Read this first

You do not need access to the design canvas. Everything is in the repository.

| What | Where |
| --- | --- |
| Artboard 2, full overview (link rule applied) | `docs/internal/plans/ia-redesign/prototype/Main-html/Main.dc.html` |
| Artboard 2b, sparse overview (new) | `docs/internal/plans/ia-redesign/prototype/OverviewSparse-html/OverviewSparse.dc.html` |
| Artboard 5, Signals tab | `docs/internal/plans/ia-redesign/prototype/SignalsTab-html/SignalsTab.dc.html` |
| Artboard 6, phone | `docs/internal/plans/ia-redesign/prototype/Mobile-html/Mobile.dc.html` |
| Artboard 7, Repository tab (not implemented by this plan) | `docs/internal/plans/ia-redesign/prototype/RepositoryTab-html/RepositoryTab.dc.html` |
| Written rules behind the drawings | [prototype README](ia-redesign/prototype/README.md), sections **Sparse overview** and **Links** |

To look at an artboard, serve its folder and open the `.dc.html` file, for example from the repository root:

```powershell
npx --yes http-server docs/internal/plans/ia-redesign/prototype/OverviewSparse-html -p 8099
```

The artboards are reference drawings with hard-coded colors and inline styles. Do not copy their markup or colors. Use the existing classes and the tokens in `app/styles/tokens.css`.

Rules that apply to every task:

- Follow `AGENTS.md` and `DESIGN.md`. No literal colors, no new font sizes, no new radii in `app/styles/`. Every button uses one of the six button roles.
- Do not change anything under `monitor/` or `shared/`. Do not add fields to any API response.
- Do not change `formatDuration` in `app/dashboard-utils.ts`; other views depend on it.
- Keep every readiness message. A panel is hidden only when its readiness is `ready` and there is nothing to show. **Loading** and **unavailable** messages always stay visible.
- Do not run `npm run build` and `npm test` at the same time.
- Commit only if the user asks.

### The problem being fixed

A session that started minutes ago has one agent, about five requests, no progress estimate. Today the Overview then shows:

1. Five request bars about 230px wide each, because every bar has `flex: 1 1 0` and no width limit (`app/styles/session.css` line 182).
2. A tall empty **Right now** panel, because it is forced to span two grid rows and stretch (`app/styles/session.css` lines 151–152).
3. An empty **Progress** card with a reserved `min-height: 140px` (`app/styles/session.css` line 189), and `0m median` on every **Work by kind** row because `formatDuration` floors anything under one minute to `0m`.
4. Five brand-colored links in one screen (**All agents**, **View signals**, **View evidence**, **Open repository**, **Open activities**). `DESIGN.md` reserves the text link for section expanders and says it is never a standalone action, so these links also break the contract.

### The link rule (approved 2026-09-20)

1. A panel whose content continues on a session tab uses its heading as the link: the title followed by a small muted chevron; both turn to ink color on hover. There is no link on the right side of the panel header.
2. On an evidence row, the way to the evidence is a chevron icon action at the end of the row. A second destination on the same row is a quiet action (**Show agent**).
3. The brand text link (`.commandTextLink`) stays for expanders (**Show 20**, **Expand all**, **Show N more calls**, **Retry**) and for at most one in-content pointer per panel.

## Work and verification

### Task 1 — Add the shared panel heading link

- [ ] Done

Files: `app/components/PanelHeadingLink.tsx` (new), `app/styles/shell.css`, `DESIGN.md`, `app/components/design-system/DesignSystemView.tsx`, `tests/ui/pomegr-design-contract.test.tsx`, `tests/ui/design-system.test.tsx`.

1. Create `app/components/PanelHeadingLink.tsx`:

   ```tsx
   "use client";

   /** Panel heading that opens the fuller view of the same evidence. Composes the quiet action role. */
   export function PanelHeadingLink({ id, children, onOpen }: { id: string; children: string; onOpen: () => void }) {
     return <h2 id={id} className="panelHeading">
       <button type="button" className="commandQuietAction panelHeadingLink" onClick={onOpen}>
         {children}
         <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
       </button>
     </h2>;
   }
   ```

   The accessible name of the button is the heading text, for example **Right now**. Do not add an `aria-label`.

2. In `app/styles/shell.css`, directly after the `.commandQuietAction > svg` rule (line 202), add:

   ```css
   /* Panel heading link: the heading is the way into the tab that continues the panel. Composes the quiet role. */
   .panelHeading { margin: 0; }
   .commandQuietAction.panelHeadingLink { min-height: 0; padding: 0; display: inline-flex; align-items: center; gap: 4px; color: var(--command-ink); font: inherit; cursor: pointer; }
   .commandQuietAction.panelHeadingLink > svg { color: var(--command-faint); }
   .commandQuietAction.panelHeadingLink:hover:not(:disabled) { background: transparent; }
   .commandQuietAction.panelHeadingLink:hover:not(:disabled) > svg { color: var(--command-ink); }
   ```

   Inside the existing `@media (max-width: 760px), (pointer: coarse)` block (line 380), after line 385, add:

   ```css
   .commandQuietAction.panelHeadingLink { width: auto; min-height: 44px; }
   ```

   `font: inherit` makes the button take the heading's type. The Overview heading type comes from `.sessionOverviewHeading h2` in `app/styles/session.css` line 149, which keeps working because the `h2` is still there.

3. In `DESIGN.md`:
   - In the **Quiet** bullet (line 231), append: `A panel heading that opens the tab continuing its evidence composes this role as `.panelHeadingLink`: heading type and ink color, a 14px muted chevron after the title, no hover fill, chevron lifts to ink on hover, 44px tap box on phone. It is not a seventh role.`
   - In the **Text link** bullet (line 232), append: `Use it for at most one in-content pointer per panel. Panel-to-tab navigation uses the panel heading link, and a row's second destination uses the quiet role; never place a text link on the right of a panel header.`
4. In `app/components/design-system/DesignSystemView.tsx`, in the `quiet` entry of `BUTTON_ROLES` (lines 138–149), add a third sample inside `render` after the two buttons: `<PanelHeadingLink id="design-system-panel-heading" onOpen={() => undefined}>Efficiency signals</PanelHeadingLink>`. Import the component. Extend the `contract` string with `Panel headings compose it as .panelHeadingLink.`
5. In `tests/ui/pomegr-design-contract.test.tsx`, inside the `it("defines the six shared button roles…")` block (lines 182–201), add:

   ```ts
   expect(styles).toMatch(/\.commandQuietAction\.panelHeadingLink\s*\{[^}]*padding:\s*0;[^}]*color:\s*var\(--command-ink\);[^}]*font:\s*inherit/);
   expect(styles).toMatch(/\.commandQuietAction\.panelHeadingLink > svg\s*\{\s*color:\s*var\(--command-faint\)/);
   ```

6. In `tests/ui/design-system.test.tsx`, next to the assertion on line 55, add:

   ```ts
   expect(within(buttons).getAllByRole("button", { name: "Efficiency signals" })[0]).toHaveClass("commandQuietAction", "panelHeadingLink");
   ```

Verify:

```powershell
npx vitest run tests/ui/pomegr-design-contract.test.tsx tests/ui/design-system.test.tsx
npm run lint
```

If `var(--command-faint)` does not exist in `app/styles/tokens.css`, use `var(--command-muted)` in both the CSS and the test.

### Task 2 — Overview: heading links and quieter signal rows

- [ ] Done

File: `app/components/dashboard/SessionOverview.tsx`. Line numbers refer to the file before any edit.

1. Import `PanelHeadingLink` from `"../PanelHeadingLink"`.
2. Replace the four linked headings. In each case the `<div className="sessionOverviewHeading">` wrapper stays, the `<h2 …>` and the `routeLink(…)` call inside it are replaced by one `PanelHeadingLink`:

   | Line | Replace with |
   | --- | --- |
   | 45 | `<PanelHeadingLink id="session-right-now" onOpen={() => onNavigate({ tab: "agents" })}>Right now</PanelHeadingLink>` |
   | 58 | `<PanelHeadingLink id="session-signals" onOpen={() => onNavigate({ tab: "signals" })}>Efficiency signals</PanelHeadingLink>` |
   | 65 | `<PanelHeadingLink id="session-repository" onOpen={() => onNavigate({ tab: "repository" })}>Repository</PanelHeadingLink>` |
   | 72 | `<PanelHeadingLink id="session-requests" onOpen={() => onNavigate({ tab: "activities" })}>Requests</PanelHeadingLink>` |

   The `id` values are unchanged, so every `aria-labelledby` keeps working. The headings of **Progress**, **Work by kind**, and **Cost** stay plain `<h2>` elements: they have no tab.
3. Signal rows (line 61). When `signal.agentId` is set, keep a **Show agent** button but change its class to `commandQuietAction`. When it is not set, render nothing (remove **View evidence**; the heading is now the way to the Signals tab). Replace the ternary with:

   ```tsx
   {signal.agentId && <button type="button" className="commandQuietAction" onClick={() => onNavigate({ tab: "agents", agent: signal.agentId! })}>Show agent</button>}
   ```

4. Delete the `routeLink` helper (lines 15–17) and the `ReactNode` import it used. `query` is then unused inside the component: remove `query` from the destructuring on line 23, but keep `query: SessionRouteQuery;` in the props type so callers do not change.
5. Leave the agent name button on line 50 as it is. `app/styles/session.css` line 161 already renders it in ink color.
6. In `app/styles/session.css`, inside the `@media (max-width: 760px)` block, add after line 282: `.sessionSignals .commandQuietAction { width: auto; }` so **Show agent** does not become a full-width row on phone.

Tests: in `tests/ui/dashboard-t04.test.tsx`, the test at lines 405–414 clicks the button named **Show agent** on the Overview; it must still pass unchanged. Add one test next to it:

```tsx
it.each([["Right now", "agents"], ["Efficiency signals", "signals"], ["Repository", "repository"], ["Requests", "activities"]])("opens the matching tab from the Overview heading %s", async (name, tab) => {
  mount({ tab: "overview" });
  const overview = await screen.findByLabelText("Session overview");
  for (const label of ["All agents", "View signals", "View evidence", "Open repository", "Open activities"]) expect(within(overview).queryByRole("button", { name: label })).not.toBeInTheDocument();
  await userEvent.setup().click(within(overview).getByRole("button", { name }));
  expect(String(navigation.replace.mock.calls.at(-1)?.[0])).toMatch(new RegExp(`tab=${tab}`));
});
```

`navigation` is the module-level mock already used by the test on lines 392–403, and `mount` (line 81) returns the render result including `container`. Each case mounts again because a click leaves the Overview tab. Import `within` from `@testing-library/react` if the file does not import it yet. Do not change `mount`.

Verify:

```powershell
npx vitest run tests/ui/dashboard-t04.test.tsx
npm run lint
```

### Task 3 — Overview: fixed-slot request strip

- [ ] Done

Files: `app/components/dashboard/SessionOverview.tsx`, `app/styles/session.css`.

Background: the monitor already limits the overview strip to the last 48 requests (`monitor/session-domain-projection.mjs` line 252, `requests.items.slice(-48)`). The strip therefore always draws 48 slots. With 5 requests, 5 slots hold bars and 43 slots hold only a baseline, so a bar has the same width in a new session and in a long one.

1. At the top of `SessionOverview.tsx`, after the imports, add `const REQUEST_STRIP_SLOTS = 48;`.
2. Inside the component, before `return`, add:

   ```tsx
   const freshTokens = (request: (typeof requests)[number]) => request.uncachedInputTokens + request.cacheWriteTokens + request.outputTokens;
   const maximumFreshTokens = Math.max(...requests.map(freshTokens), 1);
   const emptySlots = Math.max(0, REQUEST_STRIP_SLOTS - requests.length);
   ```

3. In the `requests.map(…)` on line 77, delete the two inline `const` declarations and use `freshTokens(request)` and `maximumFreshTokens` instead. The rendered button stays the same.
4. Directly after the `requests.map(…)` expression and still inside `<div className="sessionRequestTracks" …>`, add the empty slots:

   ```tsx
   {Array.from({ length: emptySlots }, (_, index) => <span className="sessionRequestSlot" key={`empty-${index}`} aria-hidden="true"><i className="sessionRoleTrack" /></span>)}
   ```

5. In `app/styles/session.css`, after line 182, add:

   ```css
   .sessionRequestSlot { min-width: 4px; height: 100%; flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; }
   .sessionRequestSlot .sessionRoleTrack { background: var(--command-line); }
   ```

Bars are drawn first (left), empty slots after them (right): the strip fills from left to right. Do not sum, average, or carry values between requests; each bar is still one request's own numbers (see the metric conventions in `AGENTS.md`).

Test, added to `tests/ui/dashboard-t04.test.tsx`. `sessionSummaryFixture` comes from `tests/ui/session-summary-test-fixture.ts`; read it to see how many request snapshots the default fixture has and call that number `N`:

```tsx
it("draws the Overview request strip with 48 fixed slots", async () => {
  const { container } = mount({ tab: "overview" });
  await screen.findByRole("button", { name: "Requests" });
  const tracks = container.querySelector(".sessionRequestTracks")!;
  const bars = tracks.querySelectorAll("button").length;
  expect(bars).toBeGreaterThan(0);
  expect(bars + tracks.querySelectorAll(".sessionRequestSlot").length).toBe(48);
});
```

Verify: `npx vitest run tests/ui/dashboard-t04.test.tsx`.

### Task 4 — Overview: sparse layout for one or two agents

- [ ] Done

Files: `app/components/dashboard/SessionOverview.tsx`, `app/styles/session.css`.

1. On the root element (line 43) add a data attribute:

   ```tsx
   <div className="sessionOverview" data-density={summary.rightNow.length <= 2 ? "sparse" : "full"} aria-label="Session overview">
   ```

2. In `app/styles/session.css`, after line 153, add. The `min-width` media query is required: without it these selectors would override the single-column phone layout.

   ```css
   @media (min-width: 761px) {
     .sessionOverview[data-density="sparse"] .sessionRightNow { grid-column: 1 / -1; grid-row: auto; }
     .sessionOverview[data-density="sparse"] :is(.sessionSignals, .sessionRepositoryOneLine) { grid-column: span 3; align-self: stretch; }
   }
   ```

Result on desktop with zero, one, or two agents: **Right now** spans the full width and is only as tall as its rows; **Efficiency signals** and **Repository** sit side by side under it, each half width. With three or more agents nothing changes (artboard 2).

Not in scope: artboard 2b draws a context meter on the agent row. Do not build it. The session summary carries only `tokens.total` for each **Right now** agent and no context-window size, so a percentage would be invented. Keep the plain count.

Test, added to `tests/ui/dashboard-t04.test.tsx`: mount the overview with a summary whose `rightNow` has one item and assert `document.querySelector(".sessionOverview")` has `data-density="sparse"`; mount with three items (copy the first item with different `id` values) and assert `"full"`. Build the summaries with `sessionSummaryFixture({ rightNow: [...] })`.

Verify: `npx vitest run tests/ui/dashboard-t04.test.tsx`.

### Task 5 — Overview: no empty bottom panels, no `0m median`

- [ ] Done

Files: `app/components/dashboard/SessionOverview.tsx`, `app/styles/session.css`.

1. Before `return`, add:

   ```tsx
   const hasPlanTasks = summary.planTasks.length > 0;
   const showProgress = activityReady !== "ready" || Boolean(progress) || hasPlanTasks;
   const showWork = activityReady !== "ready" || summary.activity.byKind.length > 0;
   const showCost = Boolean(cost);
   ```

2. Wrap the three bottom sections (lines 87–108) in one container and render each only when its flag is true:

   ```tsx
   {(showProgress || showWork || showCost) && <div className="sessionOverviewBottom">
     {showProgress && <section className="sessionOverviewPanel sessionProgressOverview" …>…</section>}
     {showWork && <section className="sessionOverviewPanel sessionWorkOverview" …>…</section>}
     {showCost && <section className="sessionOverviewPanel sessionCostOverview" …>…</section>}
   </div>}
   ```

3. Inside **Progress**, the branch without an estimate (line 93) is now reached only when plan tasks exist. Replace the `No progress estimate recorded.` paragraph with the plan-task line drawn on artboard 2:

   ```tsx
   <><span>Plan tasks · {completedTasks} of {summary.planTasks.length} done</span>
   <div className="sessionOverviewMeter"><span style={{ width: `${Math.round(completedTasks / summary.planTasks.length * 100)}%` }} /></div>
   <small>Agent-maintained checklist, may be stale. No agent estimate recorded.</small></>
   ```

4. Inside **Cost**, remove the three empty-state branches on lines 105–106 (hidden in Settings, unavailable for this provider, no estimate recorded). The panel now renders only when `cost` exists, so keep only the final branch that prints the amount.
5. Inside **Work by kind** (line 100), print the median only when it is at least one minute:

   ```tsx
   {item.count.toLocaleString()}{item.medianDurationMs === null || item.medianDurationMs < 60_000 ? "" : ` · ${formatDuration(item.medianDurationMs)} median`}
   ```

6. In `app/styles/session.css`:
   - Line 189: change to `.sessionProgressOverview, .sessionWorkOverview, .sessionCostOverview { min-width: 0; }` (the `grid-column: span 2` and `min-height: 140px` go away).
   - Add after it: `.sessionOverviewBottom { grid-column: 1 / -1; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 16px; align-items: start; }`
   - Inside the `@media (max-width: 760px)` block add `.sessionOverviewBottom { display: contents; }` and leave lines 276–278 as they are, so the phone order (Progress 5, Work by kind 6, Cost 7) still applies.

Result: one, two, or three bottom panels share the row equally; none of them renders an empty box.

Tests, added to `tests/ui/dashboard-t04.test.tsx`:

- With `sessionSummaryFixture()` defaults (progress and cost present): headings **Progress**, **Work by kind**, **Cost** are all in the document.
- With `session: { ...base.session, progress: null, cost: null }` and `planTasks: []`: `screen.queryByRole("heading", { name: "Progress" })` and `{ name: "Cost" }` are absent, **Work by kind** is present, and the text `median` is absent (the fixture medians are 900 ms and 1200 ms).
- With `sectionReadiness: { ...base.sectionReadiness, activityEvidence: "unavailable" }`: the text `Progress evidence unavailable.` is present.

Here `base` is `sessionSummaryFixture()`.

Verify: `npx vitest run tests/ui/dashboard-t04.test.tsx`.

### Task 6 — Signals tab rows

- [ ] Done

Files: `app/components/dashboard/signals/SignalsEfficiencySection.tsx`, `app/components/dashboard/signals/SignalsCacheEvidenceSection.tsx`, `app/components/dashboard/SignalsTab.module.css`.

1. `SignalsEfficiencySection.tsx` line 33: change `className="commandTextLink"` to `className="commandQuietAction"`. The label **Show agent** stays. An efficiency signal carries no request reference (`Insight` in `shared/monitor-contract.ts` has only `id`, `level`, `title`, `detail`, `agentId`), so the row gets no chevron.
2. `SignalsCacheEvidenceSection.tsx` line 76: replace the text link with a chevron icon action. The accessible name stays **Open in Activities** so the existing tests keep passing:

   ```tsx
   {supported && <button className="commandIconAction" type="button" aria-label="Open in Activities" title="Open in Activities" onClick={() => onOpenActivity(target!)}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg></button>}
   ```

3. `SignalsTab.module.css`: add `:global(.signalsInsight) > :global(.commandQuietAction), :global(.signalsCacheEvidenceRow) > :global(.commandIconAction) { flex: 0 0 auto; align-self: center; }` and, inside the file's phone media query (add `@media (max-width: 760px)` if the file has none), `:global(.signalsInsight) > :global(.commandQuietAction) { width: auto; }`.
4. `DESIGN.md`, section **Session Evidence** (heading on line 285): add one paragraph: `Overview and Signals follow the link rule: panel headings open their tab, a cache evidence row ends in a chevron icon action named Open in Activities, and Show agent is a quiet action. Overview is sparse-aware: the request strip always draws 48 slots so a bar keeps its width in a new session, Right now spans the full width while at most two agents are listed, and a bottom panel (Progress, Work by kind, Cost) renders only when it has evidence or a readiness message to show. Work by kind omits medians under one minute.` Also update the Overview sentence on line 281 only if it contradicts this paragraph.

Accepted difference from artboard 5: the drawing makes the whole row the link. The app uses one chevron button per row instead, so each row has a single focusable control and no nested interactive elements.

Verify:

```powershell
npx vitest run tests/ui/signals-tab.test.tsx tests/ui/efficiency-signals.test.tsx tests/ui/cache-evidence-disclosure.test.tsx
```

### Task 7 — Full verification and visual comparison

- [ ] Done

1. Run, one after the other, from the repository root:

   ```powershell
   npm run verify:fast
   npm run build
   npm run test:ui
   ```

2. Start the app with `npm run dev`, open `http://localhost:3003`, open a live session with one agent, and compare the **Overview** tab at 1440px width with artboard 2b, and a session with three or more agents with artboard 2. Compare the **Signals** tab with artboard 5. At 390px width compare Overview with artboard 6. Check the light theme as well.
3. Confirm that no brand-colored link remains in any Overview panel header and that **Tab** reaches every panel heading link with a visible focus ring.
4. Record under the continuation checkpoint: the commands run with their results, and every difference from the artboards with its reason.

### Out of scope

| Item | Owner |
| --- | --- |
| Session Repository tab links (**Git tab on repository page**, **All history on repository page** as quiet actions with a chevron) | T08 of the [information architecture redesign plan](ia-redesign.md); today's Repository tab has no text links |
| Context meter on the **Right now** row (artboard 2b) | Not approved; needs a context-window size in the session summary first |
| Phone **Signals** heading count (artboard 6 draws `Signals 6`) | Not built; the summary exposes only the top two signals, not a total |
| Height of the request strip (artboard 84px, app 124px) | Unchanged |
| Other `.commandTextLink` uses (Activities feed, agent roster, agent inspector, repositories pages) | Unchanged; they are expanders or single in-content pointers |

## Continuation checkpoint

2026-09-20: design approved on the canvas (version 53). Exports of artboards 2, 2b, 5, 6, and 7 are in the prototype folder and its README records the two rules. No application code has changed. Next action: task 1.
