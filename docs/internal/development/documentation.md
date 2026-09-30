# Maintain documentation

> Scope: documentation placement, migration, publication, verification, and closure.
> Authority: maintained workflow; the [style guide](../../STYLE_GUIDE.md) owns
> writing and artifact lifecycle, and [current contracts](../README.md#choose-the-authority)
> own runtime behavior.
> Related code and checks: [agent workflow](../../AGENT-WORKFLOW.md#focused-verification),
> [verification scripts](../../../package.json), and [website operations](../../../landing/OPERATIONS.md).

Keep one maintained owner for each subject. Use the [documentation index](../../README.md)
for audience navigation and the [maintainer index](../README.md) to locate current
authorities before editing. Existing pages keep their paths and authority until
their individual migration is complete.

## Place the page

| Material | Home |
| --- | --- |
| User tasks, concepts, and recovery | `docs/public/` under `get-started/`, `using-pomegr/`, `concepts/`, or `help/` |
| Runtime contracts and boundaries | `docs/internal/architecture/` |
| Contributor workflows and tooling | `docs/internal/development/` |
| Release procedures and diagnostics | `docs/internal/operations/` |
| Accepted rationale with continuing relevance | `docs/internal/decisions/` |
| Active plans and their temporary attachments | `docs/internal/plans/<topic>.md` and `docs/internal/plans/<topic>/` |

Create directories when their first page needs them; use lowercase kebab-case
topic names. Keep root entrypoints, legal files, package-local entrypoints, and
tool-required files in place. Preserve application, test, skill, plugin, and
package layouts. Link those entrypoints to canonical detail instead of duplicating
it. Follow the [style guide's asset and lifecycle rules](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact)
for images, scratch work, reports, and retained release evidence. Internal means
excluded from website publication, not confidential in Git.

### Introduction screenshot ownership

The [introduction](../../public/get-started/introduction.md) owns the four JPEGs in
`docs/public/images/introduction/`. Recaptured on 2026-09-30 from the Pomegr 0.5.3
interface (the 2026-09-08 set showed 0.3.6), they show one recorded Claude Code
session in the Pomegr repository, titled “Agent-readiness audit of repo
structure” (one primary agent and eight subagents). The project owner authorized
any recorded session of the Pomegr, Pokrr, or Catalogus repositories on
2026-09-30. Dark mode leads the session overview (`session-overview.jpg`), the
Agents panel in List view with the subagent group expanded and the primary agent
selected (`agents-tab.jpg`, cropped above the empty roster area), and the
Activities tab's Requests panel in Lanes and Full breakdown with request #300
selected, cropped to the lanes and axis (`requests-chart.jpg`); the light
overview (`light-mode.jpg`), cropped to the header, summary strip, and tab bar,
demonstrates the alternative theme. Captures came directly from the running local
dashboard's recorded session view at 2x scale, without changing its data, at a
1200 px viewport (1000 px for the Requests panel) so their smallest labels stay
readable at the documentation column width, and were cropped and converted to
JPEG. Only displayed dashboard content was captured; no raw session files were
read or copied.

When the pictured UI changes, recapture the actual session dashboard using
owner-authorized project data or synthetic data, check legibility and privacy,
and update the guide and images together. Keep the caption accurate about which
kind of data is shown. These are maintained explanatory screenshots;
they do not replace the design-system page or preserve a temporary mockup.

### Context and tokens screenshot ownership

The [context and tokens](../../public/concepts/context-and-tokens.md) page owns the
two JPEGs in `docs/public/images/context-and-tokens/`. `compaction-drop.jpg` was
captured on 2026-09-30 from the Pomegr 0.5.3 interface in dark theme. It shows the
Activities tab's Requests panel in Lanes and Full breakdown, at a 1000 px viewport
and cropped to the lanes and axis, for the recorded Codex session titled “Fix PR 30
Windows CI” in the Pomegr repository. Request #290 is selected so the chart's
`compaction` label stays visible beside the recorded automatic compaction that
precedes request #271.
The project owner authorized any recorded session of the Pomegr, Pokrr, or
Catalogus repositories on 2026-09-30. None of the recorded Claude Code sessions in
the catalog’s newest 100 rows had a recorded compaction, so the image comes from a
Codex session and its legend has no Cache write series. The capture came from the
running local dashboard at 2x scale, was converted to JPEG, and shows only displayed
dashboard content (agent labels, roles, models, and token bars); no raw session
files were read or copied. When the chart changes, recapture a recorded compaction
and update the page, alt text, and image together.

`fresh-tokens.jpg` was captured the same day from the same interface and theme, at
a 1000 px viewport and 2x scale, cropped to the header, lanes, and axis. It shows the
Requests panel in Fresh tokens (the default mode) with the Direct subagents group
expanded, for requests #270 to #330 of the recorded Claude Code session titled
“Agent-readiness audit of repo structure” in the Pomegr repository, with request
#300 selected. It shows the same window as the introduction's `requests-chart.jpg`
in the other chart mode. Recapture it with the introduction image.

### Cache reuse screenshot ownership

The [cache reuse](../../public/concepts/cache-reuse.md) page owns the two JPEGs in
`docs/public/images/cache-reuse/`. Both were captured on 2026-09-30 from the Pomegr
0.5.3 interface in dark theme, at a 1000 px viewport and 2x scale, cropped to the
Requests panel's header, one lane, and axis. They show one subagent's requests #63 to
#101 (the lane “Implement part 4 shared lookup”, focused with its lane label) in the
recorded Claude Code session titled “ACOS part 4: shared Claude/Codex source ledger
lookup” in the Pomegr repository, with request #93 selected under its **Possible full
refill** marker. `refill-write-spike.jpg` uses Fresh tokens and `refill-cache-reads.jpg`
uses Full breakdown; the two captures are the same request in both modes. The project
owner authorized any recorded session of the Pomegr, Pokrr, or Catalogus repositories
on 2026-09-30; the session was chosen because its refill is the only one in it and is
bracketed by high-reuse requests, and the lifetime inference appears when the marker is
hovered. Only displayed dashboard content was captured. When the chart or marker
changes, recapture a recorded possible full refill in both modes and update the page,
alt text, and images together. The former `docs/user-guide/images/cache-reuse-drop.png`
crop of the old line chart was deleted.

### Usage limits screenshot ownership

The [usage limits](../../public/concepts/usage-limits.md) page owns
`docs/public/images/usage-limits/provider-windows.jpg`, captured on 2026-09-30 from
the running Pomegr 0.5.3 dashboard in dark theme at a 1100 px viewport and 2x scale,
cropped to the two provider cards and the caution note. It shows live account
percentages for the project owner's Claude Code and Codex accounts at that moment (no
account identifiers). Only displayed dashboard content was captured. Recapture it when
the Usage limits page changes and keep the caption's date, providers, and values
accurate.

### Signals and estimates screenshot ownership

The [signals and estimates](../../public/concepts/signals-and-estimates.md) page owns
the two JPEGs in `docs/public/images/signals-and-estimates/`. Both were captured on
2026-09-30 from the Pomegr 0.5.3 interface in dark theme at a 1100 px viewport and 2x
scale, from the recorded Claude Code session titled “ACOS part 4: shared Claude/Codex
source ledger lookup” in the Pomegr repository. `signals-tab.jpg` shows the Signals tab
(Efficiency, Cache lifetime, Reported signals) cropped to its content; `progress-and-cost.jpg`
shows the Overview tab's Progress and Cost panels. Only displayed dashboard content
was captured; the reported signal's short label and description were reviewed and show
no paths, prompts, or credentials. Recapture both when the tab layout changes.

## Migrate one page at a time

1. Read the source and its governing contract. Identify consumers, inbound
   headings, generated regions, and content for each audience.
2. Move or rewrite the selected page using the [page templates](../../STYLE_GUIDE.md#page-templates).
   Split mixed audiences only when every resulting page has a clear owner;
   preserve necessary invariants and distinguish proposals from shipped behavior.
3. Repair links, anchors, image paths, agent routes, source/test literals,
   generator paths, and build inputs in the same change. Search tracked hidden
   tool directories as well as ordinary source files.
4. Remove the old source only after all useful content and references have owners.
   Keep partially migrated sources authoritative for their remaining content;
   leave the migration task open until the split is complete.
5. Update both indexes as applicable, replacing planned paths with working links.
   Run the checks below, then record the task's completion date and verification
   or commit reference in its active checklist.

## Publish approved public content

The [publication manifest](../../site.json) explicitly selects public pages and
navigation order. Follow its [format and content contract](documentation-manifest.md)
for source membership, unique routes, and local link/image handling. Keep drafts
in active plans; add ready public pages as their migrations finish.

**Migration status:** the manifest selects ready public pages in reading order,
starting with the [introduction to Pomegr](../../public/get-started/introduction.md).
The build-time content loader, `/docs` renderer, search, and `check:docs` command are not
implemented yet. Adding a Markdown file or manifest entry does not deploy it.
Validate selected links, routes, and images before publication. Repair repository
references on every move; preserve or redirect previously published URLs when
their routes change.

Public content updates require the normal website build and deployment,
independently of desktop packaging. Internal-only edits require documentation
validation, not website deployment. Follow [website operations](../../../landing/OPERATIONS.md#5-release-the-exact-audited-artifact)
for the existing manual deployment procedure; documentation work does not enable
automatic deployment. Update this section when the publication tooling lands.

## Verify the change

With repository dependencies installed, run from the repository root:

```powershell
git diff --check
npm run verify:fast
```

Run Git in the host environment as required by [AGENTS.md](../../../AGENTS.md#git-and-github-from-codex).
Expect no whitespace errors and a passing verifier. These checks do not validate
all Markdown links or render documentation. Until `npm run check:docs` exists,
inspect changed pages for the supported syntax, heading hierarchy, local links
and anchors, image existence and alt text, and stale inbound references. Preview
their Markdown and verify that the page reads coherently for its intended audience.
Record the actual coverage and any unavailable checks in the handoff.

For generated documentation, update its source and generator and run the relevant
check, such as `npm run check:provider-docs`. For implementation changes, also
follow the [agent workflow](../../AGENT-WORKFLOW.md#focused-verification) and
[change checklist](../../../AGENTS.md#change-checklist); documentation checks do
not replace build, test, privacy, or affected landing verification.

## Close temporary work

Give every new plan a continuation owner, status, next task or decision,
completion criteria, and permanent destinations using the style guide's template.
Paused work needs a concrete next decision.

Apply the [closure procedure](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact)
in the change that completes, cancels, or supersedes the work: transfer enduring
behavior and rationale, assign unfinished obligations, repair references, preserve
required release evidence, then delete the plan and unneeded attachments. Do not
create an archive copy. Before deleting a visual exploration, apply the
[design promotion rules](../../STYLE_GUIDE.md#give-visuals-an-owner); the existing
`/design-system` page remains the authoritative visual reference.
