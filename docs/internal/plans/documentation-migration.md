# Documentation migration

> Status: in progress; DOC-00 through DOC-04 and PUB-01 through PUB-03 complete. Next: PUB-08 pilot.
> Created: 2026-09-07.
> Audience and owner: Pomegr maintainers; each executing maintainer owns their selected task.
> Lifetime: ephemeral. Delete this plan in the change that completes the migration.
> Scope: documentation organization, writing, artifact lifecycle, and website publication.
> Authority: migration checklist only; current runtime contracts remain authoritative.

## Outcome

Give public readers and maintainers clear navigation and readable, focused pages.
Migrate one document at a time, updating references and checking off each task.
The initial change created only this plan. Progress is recorded in the task list
and continuation checkpoint below.

The permanent writing and artifact-lifecycle rules now live in the
[style guide](../../STYLE_GUIDE.md). Placement, migration, publication, checks, and
closure follow the [maintenance workflow](../development/documentation.md).
The [publication manifest contract](../development/documentation-manifest.md)
defines selection, routes, and local links/images. These authorities must outlive
this plan.

## Agreed decisions

- Public guides live in `docs/public/`; internal technical docs in `docs/internal/`.
  Internal means excluded from the documentation website, not confidential in Git.
- One style guide covers shared writing rules and public/internal audience profiles.
- Use plain Markdown with a small, documented formatting vocabulary.
- The simplest publication model wins: the website build reads approved public
  Markdown. Publishing public edits requires the normal website deployment.
  No separate content service or per-request GitHub fetch is planned.
- `docs/site.json` explicitly selects public pages and navigation order.
- The existing **`/design-system` page is the authoritative visual reference**.
  Promote missing reusable design examples there through their actual tokens and
  components. Do not establish a second visual authority in docs or HTML previews.
- Existing HTML mockups must be reviewed, promoted where necessary, and deleted.
  Already-promoted or rejected alternatives require no duplicate promotion.
- Plans and mockups are temporary. Delete them when their target is accomplished,
  cancelled, or superseded, after accounting for enduring knowledge and open work.
  Do not introduce an archive directory.
- Preserve application, test, skill, plugin, and package layouts. This is a docs
  migration, not a codebase restructure.

## Final target

```text
docs/
  README.md                   Documentation entrypoint for all audiences
  STYLE_GUIDE.md              Shared writing rules and audience profiles
  site.json                  Explicit public publication/navigation manifest
  public/
    get-started/              Introduction, install, first session
    using-pomegr/             Tasks and product controls
    concepts/                 Labels, numbers, evidence, limitations
    help/                     Symptoms and recovery
    images/<topic>/           Assets belonging to maintained public pages
  internal/
    README.md                 Maintainer navigation and authority map
    architecture/             Current behavior, boundaries, invariants
    development/              Workflow, configuration, tooling, verification
    operations/               Releases, acceptance procedures, diagnostics
    decisions/                Accepted rationale with continuing relevance
    plans/
      <topic>.md              Active temporary checklist
      <topic>/                Temporary attachments, only while needed
```

Create directories only when their first page needs them. New topic names use
lowercase kebab-case. Retain conventional entrypoint names such as `README.md`,
`STYLE_GUIDE.md`, `AGENTS.md`, and tool-required `SKILL.md`.

The individual tasks below define the target files. For public pages, a source
such as `docs/public/concepts/context-and-tokens.md` maps to
`/docs/concepts/context-and-tokens`.

### Keep these entrypoints and tool files in place

| Existing home | Continuing responsibility |
| --- | --- |
| Root `README.md` | Product overview; links to docs, downloads, contribution |
| Root `AGENTS.md`, `CLAUDE.md` | Global boundaries and agent routing; thin provider-specific entrypoint |
| Root `CONTRIBUTING.md` | Contributor entrypoint linked to the maintainer workflow |
| Root `PRODUCT.md` | Current product purpose, supported capabilities, positioning |
| Root `DESIGN.md` | Written design contract tied to the authoritative design-system page |
| Root legal/source notices | Preserve legal and packaging paths, including generated legal copies |
| `landing/README.md` | Package-local entrypoint linked to canonical website operations |
| Repository skills and provider wrappers | Keep canonical packages, scripts, and working pointer relationships |
| `.impeccable/` active configuration/surface briefs | Maintain tooling through its supported workflow; retire stale reports separately |
| `.pomegr/`, `plugin-src/`, `plugins/` | Reporting configuration and shipped/generated plugin content retain existing owners |

Do not relocate tool-required templates just because they are Markdown.

## Permanent versus ephemeral

Permanent means maintained while its subject remains relevant, not preserved
forever regardless of usefulness.

| Material | Lifetime and destination |
| --- | --- |
| User guide, current contract, runbook | Maintained in the public/internal structure; retire with its subject |
| Accepted decision | Keep useful rationale in `internal/decisions/`; link replacement if superseded |
| Working plan or research proposal | Temporary in `internal/plans/`; delete on closure |
| HTML mockup or design review image | Temporary plan attachment; promote needed design into `/design-system`, then delete |
| Explanatory screenshot or diagram | Maintained with the page it explains; update/remove with that page |
| One-session notes or scripts | Ignored `work/<topic>/`; remove when the investigation closes |
| Generated review reports, screenshots, logs | Ignored `outputs/<topic>/` or external artifacts; remove when review closes |
| Required release evidence | Follow explicit release-evidence retention in the designated artifact store; keep reusable procedures in docs |

Purpose determines lifetime. A screenshot explaining a supported feature is not
the same as a screenshot recording a finished design exploration.

### Closing temporary work

1. Transfer current behavior/invariants to their permanent contract.
2. Transfer useful accepted rationale to a concise decision record, without copying
   the entire plan. Visual rules/examples belong to the existing design system.
3. Account for unfinished obligations in a named active plan or existing issue.
4. Replace every reference treating the temporary artifact as current authority.
5. Preserve any explicitly required release evidence outside the temporary plan.
6. Delete the plan and unneeded attachments in the closing change. Git history
   retains prior tracked versions; there is no checked-in archive copy.

New plans must identify scope, continuation ownership, status, next task,
completion criteria, and the permanent destinations of their findings.
Paused work must have a next decision; it is not an indefinite artifact archive.

## Writing standard to establish

DOC-02 established the [style guide](../../STYLE_GUIDE.md) as the maintained
editorial authority. The summary below records the migration's agreed direction;
use the guide for the current rules and templates.

Shared rules: one purpose per page, answer/responsibility first, descriptive
headings, short paragraphs, numbered procedures, precise labels, and purposeful
visuals. Put limitations next to the claims they qualify. Link canonical detail
instead of duplicating it.

| Public profile | Internal profile |
| --- | --- |
| What can I do or understand? | What does this own? |
| What steps and expected results matter? | How does it work, and what must remain true? |
| What does this label mean? | Where do I change it, and how do I verify it? |
| Screenshots and worked examples | Data-flow, dependency, and state diagrams |

Aim for 3–5 focused sections and roughly 200–600 words for ordinary guides.
These are editorial defaults, not hard limits on technical contracts.
Preserve necessary invariants when shortening or splitting.

Public front matter starts with `title` and `description`. Internal pages state
scope/authority and related code/checks where useful. Plans add lifecycle fields.
Support ordinary headings, lists, tables, fenced code, images, and a small
documented callout syntax; arbitrary MDX/React is not required.

## Execute one task at a time

1. Read the source and identify its current consumers and authoritative content.
2. Move/rewrite the selected page; split mixed audiences only with clear owners.
3. Update links, anchors, agent routes, test/source literals, generator paths, and
   build inputs in the same change. Search tracked hidden tool directories too.
4. Remove the old source once all useful content and references are accounted for.
   Do not maintain two authoritative copies.
5. Update indexes and, for ready public pages, the publication manifest.
6. Check Markdown/links/images and affected consumers. Follow existing focused
   and canonical verification requirements for any implementation changes.
7. Mark the task `[x]` with a short date and verification/commit reference.

Old paths remain authoritative until their migration task completes. Transitional
indexes may link to old files. Proposed destinations below use code spans because
the files do not exist yet. Public URLs need redirects only if previously
published; repository moves still require all inbound references to be repaired.
A partially completed split stays unchecked.

## Phase 1 — Foundation

- [x] **DOC-00** Create this plan in `docs/internal/plans/` and inventory current documentation. 2026-09-07; existing docs unchanged.
- [x] **DOC-01** Create `docs/README.md` and `docs/internal/README.md`: audiences, navigation, authority map, old/new transitional paths, and links from root entrypoints. 2026-09-08; verified 74 local navigation links/anchors, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings).
- [x] **DOC-02** Write `docs/STYLE_GUIDE.md`: shared rules, both profiles, templates, supported formatting, visual ownership, permanent/ephemeral lifecycle. 2026-09-08; verified 66 local guide/index links and anchors, Markdown structure/whitespace, independent review, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings).
- [x] **DOC-03** Create `docs/internal/development/documentation.md`: placement, migration, publication, checks, and closure. Update agent routing for the new homes and ephemeral-plan rule. 2026-09-08; verified 94 local links/anchors across seven changed pages, Markdown structure/whitespace, independent review, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings). Website preview remains unavailable until the renderer is implemented.
- [x] **DOC-04** Define `docs/site.json`: ordered groups, explicit page membership, unique routes, and local image/link handling. Keep drafts in plans; no automatic publication of all repository Markdown. 2026-09-08; verified JSON format, four ordered groups with no selected pages, 108 local links/anchors across eight changed pages, Markdown structure/whitespace, independent review, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings). Content loading, rendering, and automated docs validation remain WEB tasks.

## Phase 2 — Public pages

Start with PUB-01, PUB-02, and PUB-08 as overview, task, and explanation pilots.
Review their writing and reading experience before migrating the rest.
Every path in this section is relative to `docs/public/`.

- [x] **PUB-01** `get-started/introduction.md` — extract root README and `docs/user-guide/README.md`; keep root README as the entrypoint. 2026-09-08; verified 113 local links/anchors across eight Markdown pages, heading hierarchy, manifest selection/metadata/route/public boundary, independent review, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings). Website rendering remains pending; legacy user-guide index retained for existing navigation until PUB-19.
- [x] **PUB-02** `get-started/install.md` — extract supported download/desktop modes from README, CONFIGURATION, and DESKTOP_RELEASES; leave maintainer packaging internal. 2026-09-08; verified official stable-release asset names, desktop implementation facts, 131 local links/images and anchors across ten Markdown pages, public metadata/heading hierarchy/manifest routes and boundaries, independent review, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings). Website rendering remains pending.
- [x] **PUB-03** `get-started/first-session.md` — first launch, discovery, session selection, expected empty/unavailable states. 2026-09-08; verified current UI/discovery behavior, 141 local links/images and anchors across eleven Markdown pages, heading hierarchy, public metadata/manifest routes and boundaries, independent review, `git diff --check`, and `npm run verify:fast` (passed; 15 existing lint warnings). Website rendering remains pending.
- [ ] **PUB-04** `using-pomegr/sessions-and-agents.md` — shipped UI, lifecycle labels, and bounded evidence; use SESSION_STATUS/METRICS as inputs.
- [ ] **PUB-05** `using-pomegr/repositories.md` — current index/detail experience; distinguish working features from placeholders.
- [ ] **PUB-06** `using-pomegr/reporting-plugins.md` — extract user installation, setup, reporting, and troubleshooting from PLUGINS.
- [ ] **PUB-07** `using-pomegr/phone-access.md` — extract pairing, scope, settings, and recovery from CONFIGURATION/current behavior.
- [ ] **PUB-08** `concepts/context-and-tokens.md` — extract focused definitions and worked examples from the existing tokens/cache guide.
- [ ] **PUB-09** `concepts/cache-reuse.md` — extract cache behavior and inference limits from that guide, CACHE_TIMING, and METRICS.
- [ ] **PUB-10** `concepts/usage-limits.md` — windows, freshness, missing evidence, and provider differences.
- [ ] **PUB-11** `concepts/signals-and-estimates.md` — recorded values, agent reports, provider estimates, and deterministic inferences.
- [ ] **PUB-12** `using-pomegr/settings.md` — settings, notifications, updates, installed/portable differences from CONFIGURATION.
- [ ] **PUB-13** `using-pomegr/mcp-queries.md` — supported query usage from MCP_QUERIES; retain transport/privacy contracts internally.
- [ ] **PUB-14** `concepts/token-pricing.md` — review the existing guide's sources, examples, and dates before publishing; distinguish API prices from subscription allowances.
- [ ] **PUB-15** `help/missing-sessions.md` — extract relevant CONFIGURATION symptoms and recovery steps.
- [ ] **PUB-16** `help/unavailable-data.md` — missing/stale evidence and service-status interpretation without unsupported cause claims.
- [ ] **PUB-17** `help/connection-problems.md` — startup/connection symptoms; link phone-specific instructions to PUB-07.
- [ ] **PUB-18** Move `docs/user-guide/images/cache-reuse-drop.png` to `images/cache-reuse/` and `context-compaction-drop.png` to `images/context-and-tokens/`; repair links and alt text.
- [ ] **PUB-19** After every useful section has a new owner, delete the old `docs/user-guide/README.md`, `tokens-and-cache.md`, and obsolete image directory; update all inbound references.

## Phase 3 — Internal pages

The first 19 tasks account for every current top-level `docs/*.md` source.
Mixed-audience sources remain until their public extractions are complete.
Targets are relative to `docs/internal/`.

- [ ] **INT-01** `docs/AGENT-WORKFLOW.md` -> `development/agent-workflow.md`; preserve focused checks/forbidden directions and update agent entrypoints.
- [ ] **INT-02** `docs/ARCHITECTURE.md` -> `architecture/overview.md`; preserve runtime map and link precise contracts rather than repeating them.
- [ ] **INT-03** `docs/OBSERVATION_CACHE.md` -> `architecture/observation-cache.md`; preserve canonical operational authority, invariants, and anchors; improve navigation before splitting.
- [ ] **INT-04** `docs/METRICS.md` -> `architecture/metrics.md`; preserve deterministic rules and evidence boundaries.
- [ ] **INT-05** `docs/CLAUDE_SESSION_STATUS.md` -> `architecture/claude-session-status.md`.
- [ ] **INT-06** `docs/SESSION_STATUS.md` -> `architecture/session-status.md`; keep current behavior separate from unresolved proposals.
- [ ] **INT-07** `docs/PROVIDER_STATUS.md` -> `architecture/provider-status.md`.
- [ ] **INT-08** `docs/CACHE_TIMING.md` -> `architecture/cache-timing.md`; finish PUB-09 extraction.
- [ ] **INT-09** `docs/SIGNAL_DICTIONARY.md` -> `architecture/signal-dictionary.md`; preserve identifiers.
- [ ] **INT-10** `docs/COMMAND_TABLE.md` -> `development/command-table.md` for technical integration guidance only; promote missing visual examples to `/design-system`, link that authority, and remove duplicated styling specifications.
- [ ] **INT-11** `docs/CONFIGURATION.md` -> `development/configuration.md` after public extraction. Preserve environment/configuration detail. Update `scripts/provider-capability-docs.mjs`, generated-region paths, diagnostics, and tests together.
- [ ] **INT-12** `docs/MCP_QUERIES.md` -> `architecture/mcp-queries.md`; finish PUB-13 extraction.
- [ ] **INT-13** `docs/PIPELINE_OPERATIONS.md` -> `operations/pipeline-diagnostics.md`; preserve current runbook/contract and transfer unfinished future milestones to an active plan.
- [ ] **INT-14** `docs/PLUGINS.md` -> `development/plugins.md` after PUB-06; retain precise source/output ownership, generation, validation, versioning, and release procedures.
- [ ] **INT-15** `docs/DESKTOP_RELEASES.md` -> `operations/desktop-releases.md`; retain acceptance/rollback, link user installation to PUB-02.
- [ ] **INT-16** `docs/DESKTOP_BETA_ACCEPTANCE.md` -> `operations/desktop-beta-acceptance.md`; keep reusable procedure, separate per-candidate execution evidence.
- [ ] **INT-17** `docs/DESKTOP_CLEAN_VM_CHECKLIST.md` -> `operations/desktop-clean-vm.md`; keep reusable checklist, handle completed records under release-evidence retention.
- [ ] **INT-18** `docs/LICENSE_HISTORY.md` -> `decisions/license-history.md`; preserve enduring rationale and root/legal links.
- [ ] **INT-19** Split `docs/COMMERCIAL_STRATEGY.md`: accepted positioning into root PRODUCT; useful accepted rationale into `decisions/product-positioning.md`; unresolved hypotheses into temporary `plans/commercial-strategy.md`. Remove original when accounted for; do not create empty targets or present speculative editions as shipped.
- [ ] **INT-20** `landing/OPERATIONS.md` -> `operations/website.md`; keep landing README as local entrypoint and repair root/release links.
- [ ] **INT-21** Refresh retained root entrypoints and tool context: new links, duplicated policy wording, stale provider-support claims. Preserve essential always-visible invariants.

## Phase 4 — Plans and visual artifacts

### Design promotion gate

The live page is `app/design-system/page.tsx`, with examples in
`app/components/design-system/DesignSystemView.tsx`. Shared tokens/components are
the implementation; root `DESIGN.md` is the written contract for that same system.

For each mockup: compare with existing examples, identify any missing accepted
reusable pattern, promote through the actual shared implementation and page, update
DESIGN/contract tests together where required, verify the result, then delete.
If already covered or rejected, delete after repairing references.
Do not promote whole speculative screens, fake supported features, or screenshots
of HTML as a substitute for working examples. Missing feature work goes to a named
active plan; it does not justify retaining an obsolete mockup.

The page remains static-data-only and web-development-only under its existing
access contract. It is not added to public docs, desktop, or phone navigation.
Internal prose can explain implementation; it must not become a competing gallery.

### Individual retirement tasks

- [ ] **TMP-01** `docs/plans/agent-tree-view.md`: reconcile verification exceptions/open work, promote any missing design-system patterns, preserve current contracts, then delete.
- [ ] **TMP-02** `docs/plans/codex-provider-integration.md`: reconcile shipped milestones; put only unresolved obligations into `plans/codex-provider-follow-ups.md` if needed, then delete.
- [ ] **TMP-03** `docs/plans/codex-windows-liveness-strategy.md`: extract relevant accepted rationale into `decisions/codex-windows-presence.md`, distinguish shipped semantics from earlier proposals, then delete.
- [ ] **TMP-04** `docs/plans/desktop-app-implementation.md`: preserve missing current contracts/procedures and outstanding acceptance tasks, then delete.
- [ ] **TMP-05** `docs/plans/provider-neutral-session-observation-cache.md`: verify durable coverage in INT-03, then delete.
- [ ] **TMP-06** `docs/plans/repositories-redesign.md` and its 14 HTML/PNG attachments: apply promotion gate, transfer outstanding work, repair references, then delete all.
- [ ] **TMP-07** `docs/plans/session-page-redesign.md` and its 10 HTML/PNG attachments: apply the same gate and delete all.
- [ ] **TMP-08** Move active `docs/plans/mobile-pairing-cloudflare.md` to `plans/mobile-pairing-cloudflare.md`; add owner, exit criteria, enduring destinations, and deletion on closure. Do not implement its feature.
- [ ] **TMP-09** Move active `docs/plans/remote-platform-and-orgs.md` to `plans/remote-platform-and-orgs.md` with the same lifecycle; preserve its unshipped status.
- [ ] **TMP-10** `docs/design/pomegr-ui-preview.html`: replace DESIGN.md's explicit HTML-authority reference with the existing design-system page and its implementation, promote gaps, repair tool references, then delete.
- [ ] **TMP-11** `docs/design/agents-preview.html` and `agents-preview-notes.md`: promote missing accepted examples, account for open work, update the matching Impeccable surface brief through supported tooling, then delete.
- [ ] **TMP-12** `docs/design/context-inventory-options.html`: promote accepted reusable patterns or record an outstanding decision in an active plan, then delete the HTML.
- [ ] **TMP-13** Both HTML files in `docs/mockups/`: apply promotion gate, repair references, then delete.
- [ ] **TMP-14** `mockups/pomegr/{aril,index,kernel,orchard}.html`: apply promotion gate, repair references, then delete all four.
- [ ] **TMP-15** Review completed reports under `.impeccable/critique/`; transfer open findings to active work and delete closed reports. Keep required current tool configuration/briefs, correcting any stale authority links.
- [ ] **TMP-16** Retire empty legacy `docs/plans/`, `docs/design/`, `docs/mockups/`, and `mockups/` roots. Account for any new artifacts created during migration before declaring completion.

Future temporary explorations may accompany an active plan only while they help
resolve that work. They follow the same promotion-and-deletion gate; there is no
permanent mockup home in the final structure.

## Phase 5 — Website and verification

- [ ] **WEB-01** Add build-time preparation of manifest-selected public Markdown/images. Keep the landing runtime self-contained; document/audit a narrow content-input boundary without imports from monitor/desktop/application code.
- [ ] **WEB-02** Add `/docs` rendering: grouped sidebar, readable text, heading anchors, optional on-page outline, previous/next links, accessible phone/keyboard navigation, and supported Markdown elements. No hand-authored React route per Markdown page.
- [ ] **WEB-03** Generate search from the same published public content revision; exclude internal docs, plans, and mockups from search and sitemap.
- [ ] **WEB-04** Add a documented `npm run check:docs` entrypoint for metadata, links/anchors, images/alt text, routes, navigation membership, and supported syntax; validate maintained internal links too.
- [ ] **WEB-05** Wire appropriate docs checks into the canonical verifier and website build. Test that non-public content cannot enter pages/assets/search/sitemap even through a mistaken manifest reference.
- [ ] **WEB-06** Document the build/deploy publication flow in website operations. Decide explicit automation triggers using the existing release policy; do not silently enable deployment. Internal-only edits require docs validation, not site deployment; public content updates need website deployment, independent of desktop packaging.
- [ ] **WEB-07** Preview pages and check links, images, navigation, search/unknown routes, and desktop/phone reading. Run affected landing/build/privacy checks and publish through the established release procedure; record the verified revision and required redirects.

## Completion and deletion

- [ ] **END-01** Every maintained page has one canonical home and index entry. No old path remains an active authority. Check links, anchors, source/test literals, generator paths, and hidden tool references.
- [ ] **END-02** Every existing mockup is deleted after promotion/disposition. The design-system page is the sole visual reference; no parallel gallery or archive has appeared.
- [ ] **END-03** Every unresolved obligation has a named active plan/issue and owner. Finished plans are deleted; active plans declare their completion and deletion conditions.
- [ ] **END-04** The style guide, documentation-maintenance guide, and website operations retain all enduring writing, placement, lifecycle, and publication rules. Published public docs are verified.
- [ ] **END-05** Run final documentation and affected website checks. Remove references/index links to this plan; record completion in the closing change description.
- [ ] **END-06** Delete this file and any temporary attachments it owns in the closing change. Removal fulfills this checkbox; do not retain a fully checked archive copy.

## Continuation checkpoint

DOC-00 through DOC-04 and PUB-01 through PUB-03 are complete. Next: the PUB-08
explanation pilot, followed by review of the three pilots before continuing the
remaining public pages.
DOC-01 is committed
as `031d51c`. The documentation and maintainer indexes link current authorities,
planned homes, and the maintained style guide and maintenance workflow. Root
README, CONTRIBUTING, and AGENTS link to the indexes. AGENTS and the agent workflow
route documentation changes to the new homes and the temporary-plan closure rule.
The publication manifest has four ordered groups and selects
`get-started/introduction.md`, `get-started/install.md`, then
`get-started/first-session.md`; add only ready public pages as their migrations
finish. Root README and both documentation indexes route to all three guides.
The legacy user-guide index links to the introduction and first-session guide and retains the
tokens/cache guide link for existing consumers, including the app's Documentation
link; remove that bridge and repair the app link under PUB-19.
PUB-02's installation guide owns supported downloads, prerequisites, desktop mode
selection, launch steps, and a brief update procedure. README, CONFIGURATION, and
DESKTOP_RELEASES link to it; the latter two keep their original paths and retain
settings, technical configuration, and maintainer packaging/release procedures for
their remaining migration tasks. Official stable release v0.3.6 and both executable
asset names were checked through GitHub on 2026-09-08. Website publication remains
pending the WEB tasks. User download instructions point to `pomegr.com/download`
and its **Download installer** and **Download portable** options; GitHub asset
navigation and filename selection are not required.
PUB-03's first-session guide owns the desktop walkthrough from launch to session
selection, automatic discovery, loading and empty-state interpretation, and basic
recovery. Installation and introduction now lead to it; CONFIGURATION links to
the walkthrough while retaining advanced provider setup and troubleshooting for
their remaining tasks. PUB-03 was completed at the user's request before PUB-08;
the explanation pilot and three-pilot review remain the next migration work.
PUB-01's visual revision adds four maintained screenshots of real Catalogus
development work, authorized by the project owner. Dark mode leads the overview,
agent grid, and requests chart; a light-mode overview shows the alternative.
These replace the synthetic example and its captions.
Capture provenance and refresh ownership live in the documentation maintenance
workflow; assets live in `docs/public/images/introduction/`.
The visual revision was checked on 2026-09-08: all four screenshot crops reviewed,
image paths/alt text/public boundaries and JPEG dimensions validated, and
`npm run verify:fast` passed with the same 15 existing lint warnings. Website
rendering remains a WEB task.
The maintained manifest contract defines
membership, derived unique routes, and local link/image handling. Build-time
content loading, the website renderer, search, and the documentation checker
remain pending. Existing source documents remain at their original paths.
Recheck the inventory before each migration because other work can add documents. Scope each
change to its selected task; do not reorganize application code or delete
unrelated local artifacts.

