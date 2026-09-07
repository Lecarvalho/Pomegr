# Repositories page redesign plan

> Status: complete — 2026-09-07. Option A (index + detail page) was chosen
> by the product owner. POMEGR-RP-01 through POMEGR-RP-07 are complete.

## Objective

Replace the accordion on `/repositories` (`app/components/repositories/RepositoryInventoryView.tsx`)
with two views that stay readable as repository management grows:

1. **Index** (`/repositories`): one row per repository that answers, left to right, *which
   repository, which providers, how many sessions, does setup need me*. Nothing expands
   inline. The whole row is a link.
2. **Detail** (`/repositories/<repositoryId>`): the Settings-style layout (210 px tab rail
   and a pane). One tab per concern: Overview, Setup, Context inventory, Reporting, Git
   (coming soon). Every row inside a tab has the same anatomy: title, status chip,
   one-line detail, actions on the right.

Nothing about what is observed, persisted, or exposed changes. This is a presentation
restructure of data the browser already receives from `/api/repositories` and the session
catalog, plus one new page route.

The target design is the canvas published on 2026-09-06 and copied verbatim into
`docs/plans/repositories-redesign/`:

| Mockup file | What it shows |
| --- | --- |
| `mockup-index.html` | The index at 1440 px, dark theme: header, toolbar with search and three filter chips, column headers, three rows. |
| `mockup-detail-setup.html` | The detail page with the **Setup** tab: two provider sections, the shared reporting row, everything "Ready". |
| `mockup-detail-setup-states.html` | Setup tab for a repository that needs attention: update available (primary button), inline capture confirmation strip, action feedback line, reporting not configured. |
| `mockup-detail-overview.html` | The **Overview** tab: four facts, three setup summary cards, recent sessions. |
| `mockup-detail-inventory.html` | The **Context inventory** tab: revision select, four-fact summary, category breakdown, two disclosures. |
| `mockup-mobile-index.html` | The index at 390 px. |
| `mockup-mobile-detail.html` | The detail page at 390 px, Setup tab, with the tab strip and full-width actions. |

Each mockup has a rendered PNG beside it (same basename). The PNGs were rendered by
headless Edge; the HTML is authoritative for exact values. Regenerate a PNG after editing
a mockup with:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,900 --screenshot="$PWD\docs\plans\repositories-redesign\mockup-index.png" "file:///$PWD/docs/plans/repositories-redesign/mockup-index.html"
```

The mockups are static HTML with inline styles and dark-theme hex values; open them in a
browser, no build needed. When the plan and a mockup disagree, the mockup wins for
visuals and this plan wins for data semantics and privacy.

Data in the mockups is illustrative. Repository names, counts, versions, revision ids,
category names and session titles are sample values. Never copy them into fixtures as if
they were provider truth.

## How to use this plan

Start a new session with a request such as:

> Implement `POMEGR-RP-02` from `docs/plans/repositories-redesign.md`. Preserve unrelated
> working-tree changes and stop when that task's acceptance criteria are met.

Before starting any task:

1. Read `AGENTS.md`, `DESIGN.md`, this plan, the mockup file(s) the task names, and the
   source files the task names.
2. Run `git status --short` and preserve unrelated changes.
3. Confirm the task's listed dependencies are complete (see the Progress log).
4. Keep raw configuration, paths, provenance, policy content, commands, and credentials
   out of browser state, fixtures, and tests. The repository snapshot already exposes only
   bounded enums, versions, and check times; do not add fields to it.
5. Run the task's Verification commands. Run `npm run verify:fast` before handing off.
6. Update the Progress log table only when the acceptance criteria are met.

## Locked design decisions

Decided with the product owner during the design session. Do not reopen them inside an
implementation task.

1. **Two views, one route family.** `/repositories` is the index; `/repositories/<id>` is
   the detail. The inline accordion, `commandRepositoryDisclosure`, and
   `commandRepositoryProvidersPanel` are removed.
2. **Index columns** in order: repository (icon, name, "N observed sessions · last
   {relative time}"), providers (one `ProviderBadge` per observed provider), sessions
   (`live` and `history` counts in `--font-data`; live count in green when > 0), setup
   (one chip, rule in decision 4), and a trailing chevron. Column widths:
   `20px minmax(240px, 1.4fr) 200px 190px minmax(200px, 1fr) 24px`, gap 14 px, row
   min-height 60 px, padding `10px 16px`. Rows are `<a>` links, hover uses
   `--command-panel-2`.
3. **Index toolbar**: the existing `CommandSearch`, then three `CommandFilter` chips
   **All / Needs attention / Live now**, then the count on the right:
   "{n} repositories · {m} needs attention" (omit the second part when m is 0).
   "Needs attention" shows rows whose setup chip tone is `warning`. "Live now" shows rows
   with `liveCount > 0`.
4. **Setup chip rule** (client-side, from fields already in `RepositorySummary`; first match
   wins):

   | Condition | Label | Tone |
   | --- | --- | --- |
   | Any provider `pluginSetup.readiness === "loading"` | Checking setup | neutral |
   | Any provider `pluginSetup.canUpdate` | Plugin update available | warning |
   | Any provider with `sessionCount > 0` and `pluginSetup.installation === "not_installed"` | Plugin not installed | warning |
   | Any provider with `pluginSetup.enabled === false` | Plugin disabled | warning |
   | `reporting.status === "invalid"` | Reporting invalid | warning |
   | `reporting.status === "not_configured"` | Reporting not configured | neutral |
   | Any provider `pluginSetup` missing, `readiness === "unavailable"`, or `installation === "unknown"`; or `reporting` missing or `unknown` | Setup unverified | neutral |
   | otherwise | Ready | positive |

   Put the rule in one exported function (`repositorySetupSummary(repository)` in
   `app/components/repositories/repository-setup.ts`) so the index chip, the detail-page
   Setup tab chip, and the Overview cards agree. Tones map to the existing `.commandChip`
   modifiers (`positive`, `warning`, and no modifier for neutral).
5. **Detail page header**: breadcrumb "Repositories › {displayName}" in the shell header
   (same mechanism as the session breadcrumb), a 42 px outlined repository icon, the
   `<h1>` with the display name, a one-line identity row (`live · history · provider
   badges`), and one secondary action on the right: "View sessions" (links to the Sessions
   page filtered to this repository).
6. **Tabs** in this order: Overview, Setup, Context inventory, Reporting, Git. Overview is
   the default. Git is a disabled-looking tab with a "Soon" tag (`--font-data`, faint) and
   opens the existing `CommandComingSoon` content. The active tab is stored in the
   `?tab=` search param (`overview | setup | inventory | reporting | git`), never in
   localStorage, so links and the legacy deep link keep working.
7. **Row anatomy inside a tab** (`.repositoryRow`): grid `minmax(0, 1fr) auto`, gap 22 px,
   `padding-block: var(--divider-content-gap)`, `border-top: 1px solid var(--command-line)`.
   Left: title (13 px/600) + chip on one line, one-line muted 12 px detail under it,
   optional feedback line (12 px, green / muted / error by tone). Right: actions, right
   aligned, gap 8 px. Reuse `.commandSettingRow` rules where they already match; do not
   fork them.
8. **Button roles inside rows** follow `DESIGN.md`: Recheck and "Open inventory" are quiet;
   Capture inventory / Capture again / Review policy / Configure reporting / Cancel are
   secondary; Install plugin, Update plugin, and Run diagnostic are primary. At most one
   primary per row. "How reporting works" is a text link.
9. **Section heads inside a tab**: a provider head is the `ProviderBadge` (14 px mark) plus
   "{n} observed sessions" (or "No observed sessions yet") on the left and a faint
   `--font-data` "Checked {relative}" on the right; `margin-top: 24px; padding-bottom: 10px`.
   The shared reporting row sits under a plain "Shared by both providers" head.
10. **Capture confirmation** renders as an inline strip directly under the Context inventory
    row it belongs to (Setup tab) or under the pane head (Context inventory tab), never as
    a modal. Its copy and native-confirmation boundary are unchanged.
11. **Overview tab** shows only data already available: four facts (Live sessions, History,
    Last activity, Providers), three setup cards (Pomegr plugin, Reporting policy, Context
    inventory) each with a chip and a one-line detail and an "Open {tab}" link, then the
    five most recent sessions for this repository from the session catalog with a "View
    all {n}" link. No new API.
12. **Tokens and typography stay as defined in `app/styles/tokens.css`.** Inter for UI,
    Geist Mono for counts, versions, revision ids and check times, 4 px control radius,
    6 px panel radius, lavender `--color-context` only for estimated token counts, green for
    ready/live, amber for attention, brand text only for links and the active rail icon.
13. **Phone is a first-class layout.** Index rows stack name + chip, then counts and
    providers. The detail tab rail becomes a horizontal, scrollable strip at 760 px and
    below (same as `.commandSettingsNav`). Row actions become full-width 44 px controls;
    two actions split the row. Touch targets are 44 px minimum.
14. **Privacy invariants hold.** No repository root, path, command, executable, raw
    configuration, provenance, or policy content reaches the browser. Plugin and capture
    actions still require the desktop bridge and native confirmation; browser and LAN
    clients see setup instructions instead. Nothing here changes
    `docs/OBSERVATION_CACHE.md` behavior.

## Mockup-to-token mapping

The mockups hard-code dark-theme hex values. Implement with tokens so light theme works.

| Mockup hex | Token to use |
| --- | --- |
| `#111315` | `--command-ground` |
| `#191c20` | `--command-panel` |
| `#23272d` | `--command-panel-2` |
| `#333941` | `--command-line` |
| `#697482` | `--command-line-strong` / `--command-faint` (faint text) |
| `#edf0f3` | `--command-ink` |
| `#a8afb9` | `--command-muted` |
| `#e58b80` | `--command-brand-text` |
| `#a63c32` | `--command-brand` |
| `#91c5a4` | `--command-green` |
| `#e3b575` | `--command-amber` |
| `#bbb3d3` | `--command-lavender` |
| `#f09a9f` | `--command-error` |
| `#d97757` | Claude mark fill inside `ProviderBadge` (already in code) |

Font sizes in the mockups are literal (26/16/14/13/12/11); map them to `--text-title`,
`--text-heading`, `--text-base`, `--text-sm`, `--text-xs`, `--text-caption`.

## Milestones

| Milestone | Tasks | Outcome |
| --- | --- | --- |
| M1 Index | RP-01 | `/repositories` is a scannable list with setup chips and filters; no accordion. |
| M2 Detail shell | RP-02 | `/repositories/<id>` exists, is reachable from the index, desktop, and LAN, and the legacy deep link redirects. |
| M3 Tabs | RP-03, RP-04, RP-05, RP-06 | Setup, Context inventory, Overview, Reporting, and Git tabs render the moved content. |
| M4 Finish | RP-07 | Phone layout, accessibility, dead CSS removal, docs, final verification. |

Dependency order: RP-01 and RP-02 are independent. RP-03 through RP-06 need RP-02. RP-07
needs everything else.

---

## POMEGR-RP-01 — Index: rows as links, setup chip, filters

### Goal

Turn the index into the list in `mockup-index.html` and `mockup-mobile-index.html`.

### Work

1. Add `app/components/repositories/repository-setup.ts` exporting
   `repositorySetupSummary(repository: RepositorySummary): { label: string; tone: "positive" | "warning" | "neutral" }`
   implementing decision 4, and `repositoryLastActivity(repository)` returning
   `repository.updatedAt` formatted with `relativeTime` or "—".
2. In `RepositoryInventoryView.tsx`, replace the accordion with `<div className="commandRepositoryList">`
   containing a column-header row (`.commandRepositoryHead`, eyebrow style: 11 px/500,
   uppercase, `letter-spacing: .02em`, muted) and one `<Link className="commandRepositoryRow" href={`/repositories/${repository.id}`}>`
   per repository, with the five cells from decision 2. Until RP-02 lands the link target
   404s; that is acceptable inside this task.
3. Toolbar: keep `CommandSearch`; add the three `CommandFilter` chips and the count text
   from decision 3. Default filter is All. Filtering by chip and by search compose.
4. Replace the `CommandComingSoon` block under the list with the one-line muted footnote
   from the mockup ("Rows reflect session associations only. Branch, working-tree, and
   pull-request detail will appear inside each repository when the monitor can provide a
   bounded repository summary."). The full coming-soon panel moves to the Git tab in RP-06.
5. Empty states: keep the three existing `CommandEmpty` cases. Add a fourth for "No
   repositories need attention" / "No repositories are live now" when a filter chip hides
   everything, with detail "Clear the filter to see all {n} repositories."
6. Phone (760 px and below): rows use `grid-template-columns: minmax(0, 1fr) 24px`,
   min-height 76 px, padding `12px 14px`; first line is name + chip, second line is
   counts, a dot, then provider badges (12 px marks). Column header row hides; the count
   text moves into the list head. Filter chips are 44 px high and scroll horizontally.
7. Delete the now-unused pieces of `RepositoryInventoryView.tsx` only if RP-02 has not yet
   moved them; otherwise leave `ProviderInventory`, `ProviderPluginSetupRow`,
   `RepositoryReportingRow`, and `RevisionEvidence` in place for RP-03/RP-04 to move.

### Acceptance criteria

- [x] No `aria-expanded` disclosure on the index; every repository row is an `<a>` to
      `/repositories/{id}`.
- [x] Setup chip label and tone match decision 4 for fixtures covering each row of the
      table.
- [x] "Needs attention" shows only warning-tone rows; "Live now" only `liveCount > 0`.
- [x] Light theme renders with the same structure (no hard-coded hex).
- [x] 390 px: no horizontal overflow; chips and search are 44 px.

### Verification

```powershell
npx vitest run tests/ui/repository-inventory.test.tsx
npx vitest run tests/ui/pomegr-design-contract.test.tsx
npm run typecheck
npm run lint
```

Rewrite `tests/ui/repository-inventory.test.tsx` cases that assert the accordion
("uses the repository row as the only top-level disclosure") into: row links, setup chip
per fixture, filter chips. Add `tests/ui/repository-setup-summary.test.ts` covering every
row of the decision-4 table.

---

## POMEGR-RP-02 — Detail route, page shell, breadcrumb, tabs, legacy redirect

### Goal

Create `/repositories/<repositoryId>` with the header, tab rail, and empty tab panes from
`mockup-detail-setup.html` (structure only; content lands in RP-03 to RP-06).

### Work

1. **Route.** Add `app/repositories/[repositoryId]/page.tsx` modeled on
   `app/sessions/[sessionId]/page.tsx`. Validate the id with `/^repo-[a-f0-9]{24}$/u`
   (the same pattern the current deep-link parser uses); `notFound()` otherwise. Read
   `tab`, `provider`, and `revision` search params, validate them (`tab` from the
   decision-6 set, `provider` in `["claude", "codex"]`, `revision` matching
   `/^ctx-\d{3,9}$/u`), and pass them as props.
2. **View.** Add `app/components/repositories/RepositoryDetailView.tsx` exporting
   `RepositoryDetailView({ repositoryId, initialTab, initialProvider, initialRevisionId })`.
   It reuses `useRepositoryInventory()` and selects the repository by id. States:
   - snapshot loading and repository not yet present: `CommandPage` with `busy` and a
     skeleton header (title "Repository");
   - snapshot ready and repository absent: `CommandEmpty` titled "Repository not observed"
     with detail "This repository has no observed sessions on this machine." and a
     text link back to `/repositories`;
   - monitor unavailable: the existing "Repository inventory unavailable" copy.
3. **Header** per decision 5. "View sessions" links to `/sessions?repository={id}`. Extend
   `app/sessions/page.tsx` to accept a validated `repository` search param (same regex) and
   `SessionsView` to accept `initialRepositoryId` and filter `session.repositoryId ===
   initialRepositoryId`, alongside the existing `initialProject`. When `repositoryId` is
   absent on catalog rows (older monitor), the filter yields no rows; show the normal
   "No sessions match" empty state.
4. **Breadcrumb.** `CommandCenterShell.tsx` currently derives the breadcrumb from the
   session route. Generalize: detect `/repositories/<id>` the same way it detects
   `/sessions/<id>`, look the display name up from the repository snapshot (add a
   lightweight `useRepositoryInventory` read or a context, whichever the shell already has
   for sessions), and render "Repositories › {displayName}" with the same
   `.sessionBreadcrumb` markup and phone behavior. Rename nothing; add a class alias only
   if the selector name is confusing (`.commandBreadcrumb` extending
   `.sessionBreadcrumb` is fine).
5. **Tabs.** `<div className="commandSettingsLayout repositoryDetailLayout">` with a
   `role="tablist"` column of five `role="tab"` buttons (`aria-selected`) styled by the
   existing `.commandSettingsNav` rules, and a pane `<div role="tabpanel">` per active
   tab. Switching a tab calls `router.replace` with the new `?tab=` value (keep other
   params). Git tab shows the "Soon" tag and renders `CommandComingSoon` with the existing
   copy.
6. **Legacy deep link.** `/repositories?repository=<id>&provider=<p>&revision=<r>` (used by
   `app/components/dashboard/MachineryPanel.tsx`) must redirect to
   `/repositories/<id>?tab=inventory&provider=<p>&revision=<r>`. Do it in
   `app/repositories/page.tsx` with `redirect()` after validation. Update
   `MachineryPanel.tsx` to link to the new URL directly.
7. **Routing allowlists.**
   - `desktop/lan-gateway.mjs`: extend `pageRouteIsAllowed` with
     `/^\/repositories\/repo-[a-f0-9]{24}$/`. Add a test in `tests/lan-gateway.test.mjs`
     for allowed and rejected shapes (`/repositories/../settings`, `/repositories/x`).
   - `desktop/security-policy.mjs`: no change expected (hidden paths only); add a test in
     `tests/desktop-security.test.mjs` asserting `/repositories/repo-…` navigates.
   - Search routing in `CommandCenterShell.tsx` (`[/repo|git|branch/i, "/repositories"]`)
     stays.
8. `metadata.title` for the route: "Repository · Pomegr".

### Acceptance criteria

- [x] `/repositories/repo-<24 hex>` renders header, breadcrumb, five tabs; invalid ids 404.
- [x] `?tab=` drives the active tab; the Git tab shows coming-soon content.
- [x] Legacy `?repository=…` links redirect and land on the Context inventory tab.
- [x] LAN gateway allows the new route shape and rejects traversal; desktop navigation
      policy allows it.
- [x] Breadcrumb shows the display name on desktop and phone exactly like the session
      breadcrumb.

### Verification

```powershell
node --test tests/lan-gateway.test.mjs tests/desktop-security.test.mjs
npx vitest run tests/ui/repository-detail.test.tsx tests/ui/sessions-view.test.tsx
npm run typecheck
npm run lint
```

Add `tests/ui/repository-detail.test.tsx` covering: not-observed empty state, tab switch
updates `?tab=`, Git tab content, and "View sessions" href.

---

## POMEGR-RP-03 — Setup tab

### Goal

Move plugin setup, the context-inventory summary row, capture confirmation, and the
shared reporting row into the Setup tab per `mockup-detail-setup.html` and
`mockup-detail-setup-states.html`.

### Work

1. Pane head: `<h2>Setup</h2>`, the explanatory paragraph from the mockup, and the
   decision-4 chip on the right (same function as the index).
2. For each `repository.providers[]` entry, in catalog order, render a provider head
   (decision 9) then:
   - **Pomegr plugin row**: move `ProviderPluginSetupRow` into
     `app/components/repositories/PluginSetupRow.tsx` and restyle to the decision-7
     anatomy. Title "Pomegr plugin"; chip from `pluginStatus()`; detail line
     `{version in --font-data} · {scope} installation · {update status}` where the
     "v{x} available" fragment is amber when `update.status === "available"`; feedback
     line unchanged. Actions: Recheck (quiet), then Install plugin or Update plugin
     (primary) when `canInstall` / `canUpdate`. Non-desktop clients keep the
     "View setup instructions" disclosure as the only action.
   - **Context inventory row**: title "Context inventory"; chip: "{revision id} saved"
     (info tone) / "Not captured" / "Capturing" (warning) / "Failed" (negative, error text
     from `failureMessage`) / "Unavailable"; detail "Native diagnostic of what this
     repository loads into every session · {compactNumber(machineryTokens)} estimated
     tokens" (lavender number) when a revision exists. Actions: "Open inventory" (quiet,
     switches to `?tab=inventory&provider=…`) when a revision exists, then
     Capture inventory / Capture again / Retry diagnostic (secondary; disabled while
     capturing) on desktop, or the "Capture available in Pomegr desktop" hint otherwise.
   - **Capture confirmation strip** under that row when confirming (decision 10): existing
     `.repositoryCaptureConfirm` copy, Cancel (secondary) + Run diagnostic (primary).
     Capture feedback lines render under the row, same tones as today.
3. "Shared by both providers" head, then the **Repository reporting row**: move
   `RepositoryReportingRow`. Title, chip from `reportingState()`, detail line, actions:
   "How reporting works" (text link, toggles the existing `/pomegr:init` help block under
   the row) and Review policy / Configure reporting (secondary).
4. Footnote: "Plugin and reporting state are local observations, rechecked on demand. Raw
   configuration never leaves this machine." (faint 12 px).
5. Keep `feedback` and `pluginActionKey` state in `RepositoryDetailView` (lifted from the
   old view) so a feedback line survives tab switches within the page.

### Acceptance criteria

- [x] Every provider in the snapshot renders one plugin row and one inventory row; the
      reporting row renders once.
- [x] Primary buttons appear only for Install plugin, Update plugin, and Run diagnostic.
- [x] Native actions still go through the desktop bridge; browser clients see
      instructions, never a disabled primary button.
- [x] Feedback messages and pending/cancelled/busy/failed copy are unchanged from today.

### Verification

```powershell
npx vitest run tests/ui/repository-detail.test.tsx tests/ui/repository-inventory.test.tsx
npm run typecheck
npm run lint
```

Port the plugin-action and desktop-only-capture cases from
`tests/ui/repository-inventory.test.tsx` to the detail test.

---

## POMEGR-RP-04 — Context inventory tab

### Goal

Move `RevisionEvidence` into its own tab per `mockup-detail-inventory.html`.

### Work

1. Pane head: `<h2>Context inventory</h2>`, the paragraph from the mockup, and on the
   right the capture action for the selected provider (same rules as the Setup row).
2. One provider section per supported provider. Provider head right side holds the
   revision `CommandSelect` (label "Revision", options "{id} · {compactNumber(tokens)}")
   when there is more than one revision; otherwise the "Checked/Captured" text.
3. Body is the existing `RevisionEvidence` content restyled: four-fact summary
   (`.repositoryInventorySummary` already matches), change line, category breakdown grid,
   "Inspect {n} listed items" and "Compare revisions" disclosures, privacy footnote. Keep
   the loading and "no longer retained" states.
4. `initialProvider` and `initialRevisionId` from the route pre-select the provider
   section and revision; the section scrolls into view on first render when both are set.
5. `not_captured`, `capturing`, `failed`, and `unavailable` render the same short status
   line as today's `.repositoryProviderRow` in place of the evidence body.

### Acceptance criteria

- [x] Deep link `?tab=inventory&provider=claude&revision=ctx-001` opens the tab with that
      revision selected.
- [x] Category grid, item groups, and revision comparison behave exactly as before.
- [x] Failure kinds render their existing sanitized messages; no raw output anywhere.

### Verification

```powershell
npx vitest run tests/ui/repository-detail.test.tsx
node --test tests/repository-inventory.test.mjs
npm run typecheck
```

---

## POMEGR-RP-05 — Overview tab

### Goal

Build the default tab per `mockup-detail-overview.html` from data already in the browser.

### Work

1. Four facts in a hairline grid (`repeat(4, minmax(0, 1fr))`, 1 px `--command-line`
   gaps, cells `padding: 14px`): Live sessions (`liveCount`, green when > 0), History
   (`historyCount`), Last activity (`relativeTime(updatedAt)` or "—"), Providers
   (badges, or "None observed").
2. "Setup" head with an "Open Setup" text link, then three cards
   (`repeat(3, minmax(0, 1fr))`, gap 12 px, `padding: 12px 14px`, 1 px line): each has an
   eyebrow, a chip, and a one-line detail:
   - Pomegr plugin: chip from the best-installed provider ("Enabled · v0.6.0") or the
     decision-4 plugin condition; detail lists the other provider's state.
   - Reporting policy: `reportingState()` label plus "· v{version}" when configured.
   - Context inventory: "{id} saved" / "Not captured"; detail "Captured {relative} ·
     {tokens} estimated tokens".
   Cards link to `?tab=setup`, `?tab=reporting`, `?tab=inventory`.
3. "Recent sessions" head with "View all {n}" (same href as View sessions), then up to
   five rows from `useSessionCatalog()` where `session.repositoryId === repository.id`,
   newest first (reuse `newestSessionsFirst`). Row: title, "{agents} agents · {source}",
   relative time, status chip (In progress / Needs input / Idle / Ended using the shared
   activity labels), chevron; links to `/sessions/{routeId}` using the existing session
   route encoder. When the catalog has no `repositoryId` values, render "Sessions for this
   repository are listed once the monitor reports repository associations." and no rows.

### Acceptance criteria

- [x] Overview shows no number that is a sum across sessions or a rate; only counts and
      timestamps already in the snapshot.
- [x] Cards agree with the Setup tab chip for the same fixture.
- [x] Recent sessions come only from the catalog filtered by repository id.

### Verification

```powershell
npx vitest run tests/ui/repository-detail.test.tsx
npm run typecheck
```

---

## POMEGR-RP-06 — Reporting tab and Git tab

### Goal

Give the shared reporting policy its own tab and park the Git placeholder.

### Work

1. Reporting tab: pane head "Repository reporting" + paragraph "One policy, shared by
   Claude Code and Codex, that chooses what agents report about this repository."; the
   status row from RP-03 (same component, `context="reporting"` so it hides the
   "How reporting works" toggle); then the `/pomegr:init` help content always visible
   under the row, and a link to `docs/PLUGINS.md` as today.
2. Git tab: `CommandComingSoon` with the existing title and detail, icon `git`.
3. Setup tab keeps its reporting row; the two rows share one component and one state.

### Acceptance criteria

- [x] Reporting tab and Setup tab show the same status and version for the same fixture.
- [x] Git tab content is the existing coming-soon copy, unchanged.

### Verification

```powershell
npx vitest run tests/ui/repository-detail.test.tsx
```

---

## POMEGR-RP-07 — Phone layout, accessibility, dead CSS, docs, final verification

### Goal

Finish per `mockup-mobile-index.html`, `mockup-mobile-detail.html`, and `DESIGN.md`.

### Work

1. Phone rules (760 px and below): detail layout collapses to one column; the tab list
   becomes the horizontal strip (`.commandSettingsNav` phone rules); rows switch to a
   stacked grid (title + chip, detail, actions) with actions `grid-auto-flow: column;
   grid-auto-columns: 1fr; gap: 8px`, every control 44 px; the capture strip stacks its
   buttons; provider heads keep the checked time on the right.
2. Accessibility: tabs are a real `tablist` with arrow-key movement and
   `aria-controls`; the index rows have accessible names "{name}, {setup label}"; the
   breadcrumb announces the current page; focus returns to the tab after a tab-triggered
   action completes.
3. Remove dead CSS from `app/styles/workspace.css`: `.commandRepositoryDisclosure`,
   `.commandRepositoryChevron`, `.commandRepositoryProvidersPanel`,
   `.repositoryProviderHead`, `.repositoryProviderRow`, `.repositoryContextDisclosure`,
   `.repositoryGitComingSoon`, and any `.repositorySetup*` rule replaced by the shared row
   anatomy. Run the design contract test; add no literal colors.
4. Add samples for the new row anatomy and the setup chip set to
   `app/components/design-system/DesignSystemView.tsx` only if a new shared class was
   introduced; otherwise none.
5. Docs: update the "Repositories place current Pomegr plugin setup inside each expanded
   repository's provider section…" paragraph in `DESIGN.md` (Session Evidence) to describe
   the index and the detail tabs; update `docs/PLUGINS.md` and `README.md` wherever they
   describe expanding a repository row; note the route in `docs/AGENT-WORKFLOW.md` if it
   lists page routes.
6. Final verification: `npm run verify:fast`, `npm test`, then a browser pass at 1440,
   1100, 900, 760, 390 and 360 px in both themes on the index, each tab, and the legacy
   redirect, using synthetic normalized fixtures only.

### Acceptance criteria

- [x] No horizontal overflow at 360 px on either view; all controls 44 px on phone.
- [x] Keyboard-only navigation reaches every tab, row link, and action.
- [x] No selector left in `workspace.css` that nothing renders.
- [x] `DESIGN.md` describes the shipped structure.

### Verification

```powershell
npm run verify:fast
npm test
```

---

## Non-goals (do not do these inside any task)

- New monitor endpoints, new fields on `RepositorySummary`, or any change to
  `docs/OBSERVATION_CACHE.md` semantics.
- Git, branch, working-tree, or pull-request aggregation. The Git tab stays coming-soon.
- Repository pinning, renaming, hiding, or any write to repository state.
- Bulk plugin actions across repositories.
- Changing the Home page beyond an optional "What's new" card (open a separate task if
  wanted, following the SP-12 precedent).

## Progress log

| Date | Task | Result | Notes |
| --- | --- | --- | --- |
| 2026-09-06 | Plan | Written | Option A chosen. Mockups copied to `docs/plans/repositories-redesign/`. Canvas: https://claude.ai/code/artifact/89105ade-65d0-451b-9f4a-f240a6b1b4d4 |
| 2026-09-07 | POMEGR-RP-01 | Complete | Linked index rows, shared setup summary, composed search/filters, phone layout. Full npm test and verify:fast passed; final build and 37 focused checks passed. Both themes measured at 1440/1100/900/760/390/360 px with no overflow and 44 px phone controls; finish review shipped. API reporting `missing` maps to Not configured. RP-02 route is intentionally pending; removed detail components/tests can be recovered from parent `91954d9ddf636e6b3d7d84dd5b828233a485d5a2` for RP-03/RP-04 (RP-01 step 7). |
| 2026-09-07 | POMEGR-RP-02 | Complete | Validated detail route, header, shared breadcrumb, five URL-backed tabs, Git placeholder, Sessions repository filter, legacy redirect, and LAN/desktop routing. Full npm test passed (549 UI tests; node/plugin suites), final build and verify:fast passed. Synthetic browser checks at 1440/390 px in both themes: no overflow, 44 px phone tabs, preserved query selection, redirect and 404 verified. Finish review shipped. Tab content remains deferred to RP-03 through RP-06. |
| 2026-09-07 | POMEGR-RP-03 | Complete | Setup tab with per-provider plugin and inventory rows, inline native capture confirmation, shared reporting help, and page-owned action feedback. Reused settings geometry and standard chips; static design-system row sample added. Full npm test passed (564 UI tests; node/plugin suites), verify:fast and final build passed; 45 focused checks passed. Synthetic browser review at 1440/900/390/360 px in both themes: no page overflow, 44 px phone actions, finish review shipped. Context inventory evidence tab remains RP-04. |
| 2026-09-07 | POMEGR-RP-04 | Complete | Context inventory tab with supported-provider sections, URL-backed revision selectors, initial deep-link scroll, saved facts, category/item evidence, comparison, and sanitized loading/failure/retention states. Capture action and inline native confirmation shared with Setup; existing API and observation semantics preserved. Full npm test passed (578 UI tests; node/plugin suites), verify:fast passed, 43 focused detail checks passed. Production browser review at 1440/900/390/360 px in both themes: no page overflow, 44 px phone controls, revision URL update verified. Independent finish review shipped using fallback reviewer instructions. |
| 2026-09-07 | POMEGR-RP-05 | Complete | Default Overview with four snapshot facts, three linked setup cards sharing plugin attention and inventory status rules, and five recent sessions strictly filtered by repository ID using shared sorting, activity labels, and route encoding. Inventory estimates remain tied to one saved provider revision; missing/loading/unavailable catalog states are explicit. Current shared activity label Closed is preserved in place of mockup Ended. Full npm test passed (591 UI tests; node/plugin suites and build), verify:fast passed, 86 focused checks passed. Synthetic production browser review at 1440/900/390/360 px in both themes: no page overflow, 44 px phone controls, Setup and filtered Sessions links verified, no browser errors. Independent finish review returned ship using fallback reviewer instructions. RP-06 Reporting content and RP-07 final cleanup/docs remain next. |
| 2026-09-07 | POMEGR-RP-06 | Complete | Reporting pane reuses the Setup reporting row and normalized policy state, with always-visible agent setup help and the plugin documentation link. Review/Configure focuses the visible help in Reporting; Setup retains its disclosure. Git keeps the existing coming-soon title, detail, and icon. Full npm test passed (597 UI tests; node/plugin suites and build); final build, 70 focused checks, and final verify:fast passed. Synthetic production browser review of Reporting and Git at 1440/390 px in both themes: no page overflow, 44 px phone controls, help focus verified, no browser errors. Independent finish review returned ship using fallback reviewer instructions. RP-07 owns final responsive/accessibility cleanup, dead CSS, docs, and full viewport verification. |
| 2026-09-07 | POMEGR-RP-07 | Complete | Finished focus restoration for pane changes, native action completion, and capture cancellation while preserving focus moved elsewhere. Phone capture buttons stack; existing equal-width row actions, provider check times, 44 px controls, row names, breadcrumb, and arrow-key tabs verified. Removed obsolete accordion/provider/setup CSS and the unused metrics wrapper; remaining dynamic agent-tree classes verified in use. DESIGN.md, plugin instructions, README, and workflow routing describe the shipped index and all tabs. Final verify:fast and full npm test passed (599 UI tests; node/plugin suites and production build). Synthetic production browser matrix passed 88 checks at 1440/1100/900/760/390/360 px in both themes across the index, all tabs, legacy redirect, expanded inventory, and browser instructions: no page overflow, 44 px phone controls, keyboard and redirect behavior, no browser errors. Final production capture-cancel focus check passed after the last edit. Observation, API, and native confirmation boundaries unchanged. |
