# Revised agent tree view plan

> Status: implementation complete. Repository-wide verification exceptions are documented under POMEGR-TREE-05. This document supersedes the earlier eight-task plan.

## Review outcome

The existing List view remains the default because it is compact, readable, accessible, and retains task, skill, execution, and plan details through popovers. Its structural defect was duplication: workflow workers appeared in both Agent activity and Workflow activity.

The Tree view adds recorded spawn topology, branch state, and stable spatial memory. Recorded `parentId` ancestry is canonical; workflow and phase are provenance only and never replace or visually masquerade as parentage.

## Locked design decisions

- List remains the default and shows every agent once in canonical spawn order.
- Tree is a full-width dashboard panel; Efficiency signals stack below it.
- Tree cards have no detail popovers. A persistent note routes users back to List.
- At observed container widths of 640px and above, Tree uses fixed approximately 156×140 tiles.
- Below 640px, Tree becomes a fixed 48px indented rail measured with `ResizeObserver`.
- Rail mode uses native vertical scrolling only. It has no camera, zoom HUD, wheel interception, pinch handling, or `touch-action: none`.
- Column mode alone supports pan, pinch, wheel zoom, Fit, and camera persistence.
- Latest context is primary. Wall time, recency, status, role, fold state, and roll-ups form a stable secondary hierarchy.
- Narrow rows keep visible status text, latest context, and recency; wall time and visible role text may drop, but role and status remain in the accessible name.
- Role shape encodes role; visible text and colour encode status. Active is green, needs-input amber, waiting/warm blue, stopped red, and idle/finished muted.
- The role key is a collapsible help disclosure.
- Connector SVGs are decorative; DOM order communicates hierarchy.
- No production density selector ships in v1.

## Public contract and repository configuration

`Agent.role` is a bounded provider-neutral union:

- `orchestrator`, `explore`, `plan`, `builder`, `reviewer`, `tester`, `researcher`
- `general-purpose`, `workflow-worker`, `fork`, `compaction`, `unknown`

The browser-facing `Agent.kind` field is removed. Provider evidence may retain raw kind only inside the monitor boundary. Legacy role-less payloads render `Unknown`; browser code never reinterprets kind. No new HTTP endpoint is introduced.

Repository mappings live in `.pomegr/roles.json`:

~~~json
{
  "version": 1,
  "roles": {
    "cavecrew-builder": "builder",
    "cavecrew-investigator": "explore",
    "cavecrew-reviewer": "reviewer"
  }
}
~~~

Keys are canonical lowercase agent-type identifiers with the final namespace segment retained and separators folded to `-`. Repositories may map only to the built-in role enum. Resolution order is primary agent, repository map, built-in exact table, documented ordered keyword rules, verified workflow association, then `unknown`.

The file is capped at 16 KiB and 64 mappings; keys are capped at 64 characters. Unsupported versions, malformed JSON, and extra top-level fields invalidate the file. Invalid individual rows are skipped. Historical sessions re-resolve display roles at read time from current mappings.

## Milestones

### POMEGR-TREE-01 — Monitor-side roles and repository configuration

- [x] Add normalization, built-in resolution, repository config loading, strict bounded validation, and a read-only diagnostic command.
- [x] Convert provider evidence to public `role` before creating `MonitorState`.
- [x] Remove browser/report uses of agent kind and add hostile-kind serialization sentinels.
- [x] Update List, report generation, privacy invariants, configuration docs, metrics docs, and doctor workflow.
- [x] Verify focused role/privacy tests and the complete Node suite.

Implementation note: the full Node suite passes 418/418. The wrapper build is temporarily blocked by a Windows lock on the generated Claude plugin bundle; the standalone web build passes.

### POMEGR-TREE-02 — Pure topology, roll-ups, layout, and camera arithmetic

- [x] Build canonical forests from `parentId`, preserving multiple roots and detaching missing, self-referential, and cyclic parents.
- [x] Keep workflow/phase only as provenance.
- [x] Compute descendant counts, attention/live/finished roll-ups, and labelled context sums before pruning.
- [x] Add presentation-only same-label sibling clusters over four agents.
- [x] Implement pure column/rail layout, bounds, fit-to-width, zoom-at-point, pin-card, and reveal-children arithmetic.
- [x] Cover forests, cycles, orphans, chains, fan-out, clusters, ordering, bounds, and camera invariants.

### POMEGR-TREE-03 — Integrated List/Tree surface and workflow de-duplication

- [x] Lift the per-session List/Tree preference to Dashboard with safe in-memory fallback.
- [x] Keep List as default and show every agent once.
- [x] Remove the separate Workflow agents resource group.
- [x] Reduce Workflow activity to identity, lifecycle, context sum, wall time, phase progress/counts, and metadata availability; never repeat worker rows.
- [x] Make Tree full-width and stack Efficiency signals below.
- [x] Add role marks, visible status, workflow provenance, context hierarchy, and the persistent List-details note.
- [x] Close the independent review corrections as part of POMEGR-TREE-04.

### POMEGR-TREE-04 — Folding, responsive rail, gestures, and keyboard model

- [x] Persist fold state per session and apply live/historical initial expansion rules.
- [x] Switch forms from observed container width, not viewport width.
- [x] Use fixed 156×140 column tiles and 48px rail rows.
- [x] Restrict camera gestures and HUD to column mode.
- [x] Add drag threshold, pinch, modifier-wheel zoom, plain-wheel pan, double-tap/`0` Fit, and keyboard camera controls.
- [x] Implement roving tree focus and Left/Right/Up/Down/Enter/Space behavior.
- [x] Pin the activated card through folds and translate only enough to reveal opened children.
- [x] Preserve scale through folds and disable pulse/camera animation under reduced motion.
- [x] Close review findings for nullable workflow timestamps, verified phase membership, distinct role glyphs/key, explicit spawn/provenance copy, RTL, empty states, touch targets, and accessible names.

Initial folding rules:

- Live trees with ten or fewer agents expand fully.
- Larger live trees reveal roots and paths containing active, waiting, warm, or needs-input agents; finished-only and deeper branches collapse.
- Historical trees initially reveal roots and direct children.

Camera invariants:

- Initial fit is width-only and clamped to 40–100%.
- Manual zoom is clamped to 25–300%.
- Pinning and revealing translate only and never change scale.
- Rail mode keeps native scrolling and never intercepts wheel or pinch gestures.

### POMEGR-TREE-05 — Hardening, visual QA, and prototype retirement

- [x] Cover empty sessions, duplicates, long/RTL labels, unavailable workflow metadata, storage failure, missing `ResizeObserver`, 45-agent trees, history, and legacy role-less payloads.
- [x] Verify 390px rail, 640px boundary, 1200px columns, 200% browser zoom, keyboard-only operation, touch folding, drag/click separation, and zero page overflow.
- [x] Run the Impeccable detector on production targets.
- [x] Perform one bounded desktop/mobile browser review, one batched correction pass, and one confirmation.
- [x] Delete both prototype HTML files and remove their detector-ignore entry only after production passes.
- [x] Run `npm run build`, `npm test`, and `npm run lint`.

Verification note: the production web build passes, as do 418 Node tests, 109 UI tests, and 17 plugin tests. Feature-owned lint targets pass. The required wrapper commands were also run: `npm run build` and therefore `npm test` stop before web compilation because an active Windows process denies writes to the generated `plugins/claude-code/mcp/server.bundle.mjs`; `npm run lint` reaches four pre-existing errors in generated `landing/.next/types/routes.d.ts` plus warnings in vendored Impeccable and landing files. The production detector reported 242 whole-file findings, overwhelmingly the existing global palette/type-ramp baseline; the feature reuses those incumbent tokens. The bounded browser confirmation verified visible recency, 44px controls, fixed rail/tile dimensions, native rail scrolling, and zero page overflow.

## Orchestration and delegation

The root coordinator owns sequencing, integration, privacy/API decisions, working-tree preservation, consolidated fixes, plan status, and final verification.

Wave 1 used two non-overlapping lightweight builders in parallel:

- Role/config builder: monitor normalization, contract, validator, privacy tests, and documentation.
- Topology builder: pure topology/layout/camera modules and their tests.

Wave 2 used one UI builder for Dashboard, Agent activity, Workflow activity, Tree rendering, styles, and focused tests. No other agent edited those files concurrently.

An independent report-only reviewer audited Wave 2 for spawn truth, raw-kind leakage, metric semantics, responsive behavior, and accessibility. Its findings were consolidated into the Wave 3 assignment.

Wave 3 used one interaction/test builder for folding, camera, pointer, keyboard, responsive behavior, and edge cases, followed by an independent browser/Impeccable reviewer. Reviewers did not edit overlapping files; the coordinator applied one consolidated correction pass.

Delegated workers use economical Terra/Luna-class models. Stronger reasoning is reserved for privacy-contract review or difficult interaction defects. Every milestone must leave the repository buildable and tested, and unrelated user changes remain untouched.

## Acceptance and verification

- Every agent appears exactly once in expanded List and Tree views.
- Workflow provenance never changes or visually masquerades as recorded parentage.
- Workflow panels contain no repeated worker rows.
- `/api/state` exposes bounded roles only and contains no hostile provider kind or role-map contents.
- Repository role changes take effect on the next monitor read; invalid configuration cannot break analysis.
- Folding never changes card scale or fixed dimensions.
- A 390px container is a native-scrolling rail with no horizontal overflow; a 1200px container is columns.
- Role and status remain understandable without colour, hover, or pointer input.
- Tree details remain discoverable through the persistent List switch and note.
- Final commands: `npm run build`, `npm test`, and `npm run lint`.

## Assumptions

- Spawn-first hierarchy, repository role configuration, and List-default behavior are confirmed user decisions.
- Impeccable remains at v4.0.4; updating it is outside this implementation.
- The two temporary prototype HTML files and their detector exception were removed after production browser and detector verification passed.
