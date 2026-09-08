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
`docs/public/images/introduction/`. Captured on 2026-09-08 from the Pomegr 0.3.6
interface, they show real Catalogus development work with the project owner's
explicit permission. The session is titled “Phase 4 backend: Supabase schema,
RLS, views, seed on local Postgres.” Dark mode leads the overview, agent grid,
and requests chart; the light overview demonstrates the alternative theme.
Captures came directly from the running local dashboard's recorded session view,
without changing its data. Only displayed dashboard content was captured; no raw
session files were read or copied. These images replace the earlier synthetic set.

When the pictured UI changes, recapture the actual session dashboard using
owner-authorized project data or synthetic data, check legibility and privacy,
and update the guide and images together. Keep the caption accurate about which
kind of data is shown. These are maintained explanatory screenshots;
they do not replace the design-system page or preserve a temporary mockup.

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

**Migration status:** the manifest selects the
[introduction to Pomegr](../../public/get-started/introduction.md) and
[installation guide](../../public/get-started/install.md). The build-time
content loader, `/docs` renderer, search, and `check:docs` command are not
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
