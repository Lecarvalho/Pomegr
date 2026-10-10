# Agent workflow

`AGENTS.md` is the repository-wide policy. This table routes a change to the nearest
behavior owner so a coding agent can discover the contract before editing it.

| Change area | Start here | Keep out of this area |
| --- | --- | --- |
| Documentation, migration, and temporary artifacts | [Maintenance workflow](documentation.md), [style guide](../../STYLE_GUIDE.md), and [maintainer index](../README.md); run `npm run check:docs` (links, anchors, images, public pages and boundary; needs `npm ci --prefix landing`; `npm run check`, and so `npm run verify:fast`, includes it) and `npm run verify:fast`; checker tests: `node --test tests/docs-check.test.mjs` | Duplicate authorities, publication of internal material, or completed plans retained as archives |
| Provider discovery, parsing, normalization | `server/providers/claude/` or `server/providers/codex/`, the shared `server/providers/kernel/`, the `server/normalize/` kernel, and `server/providers/provider-contract.mjs` | React components and raw provider schemas in shared code |
| Observation cache, checkpoints, readiness, API cadence | `docs/internal/architecture/observation-cache.md`, `server/runtime/observation-runtime.mjs`, `server/sessions/domain/session-domain-serving.mjs`, and `server/sessions/checkpoints/` | Raw parsing in serving handlers; frontend control of acquisition or persistence |
| Server indexing, projection, enrichment | `server/server.mjs`, then the owning folder in the server layout below | Browser credentials, prompts, responses, and provider-native payloads |
| Internal pipeline operations and timing | `docs/internal/operations/pipeline-diagnostics.md`, `server/diagnostics/`, and diagnostic scripts; run `npm run test:diagnostics`, `npm run check:boundaries`, and focused production/desktop exclusion checks | Browser API fields, session/transcript/source identity, prompts/content/errors in diagnostics, diagnostic reads that trigger pipeline work, a second development JSONL writer, or any capture/export/viewer path |
| Agents model and work analytics | `server/analytics/agents-analytics.mjs`, `server/runtime/agents-observation.mjs`, `shared/agents-contract.ts`, and `app/agents/` | Provider acquisition or aggregation in GETs; browser-owned analytics caches |
| Shared notifications | [Observation cache](../architecture/observation-cache.md#shared-notifications), `shared/notification-contract.ts`, `server/notifications/`, `server/runtime/notification-observation.mjs`, `server/serving/notification-routes.mjs`, and `app/notifications-client.ts`; run `node --test tests/server/notifications/*.test.mjs` and `npx vitest run tests/ui/notifications-client.test.tsx tests/ui/app-shell.test.tsx` | Provider acquisition or raw source data in rules, derivation in GETs or React, monitor-offline emitted by the monitor, arbitrary navigation or provider control |
| Task board store, rules, and routes | [Task board contract](../architecture/tasks.md), `server/tasks/` (store, record, board, queue, dispatch standing, checks, gates), `server/serving/task-routes.mjs`, and `shared/task-contract.ts`; run `node --test tests/server/tasks/*.test.mjs` and `npm run check:boundaries` | `server/tasks/` importing `server/runtime/` or `server/serving/`; rule modules reading the store, Git, or a route; observation modules reading the task store; task content in `/api/state`, catalogs, reports, logs, or checkpoints; a GET that acquires provider evidence |
| GitHub issues for the task board | [GitHub issues](../architecture/tasks.md#github-issues): `server/repository/issues.mjs` (the `gh` reader and issue normalization), `server/runtime/task-issues.mjs` (repository root lookup and the in-memory list), `server/serving/task-issue-routes.mjs` (the four desktop-token routes), and the `promote_issue` and `record_issue` actions in `server/tasks/task-store.mjs`; task images are `server/tasks/task-images.mjs` and `server/serving/task-image-routes.mjs` (`node --test tests/server/tasks/task-images.test.mjs`); run `node --test tests/server/repository/issues.test.mjs tests/server/tasks/task-issue-*.test.mjs` and `npm run check:boundaries` | A real GitHub call from a test; a GET, queue step, or agent tool that reads GitHub; issue text accepted from a caller; an issue created outside the explicit `issue-create` route, a title or body accepted from a caller for it, or an automatic retry of it; issue text persisted outside promoted task text, or served anywhere but `issues-list`; a token, username, path, command, or error text leaving the reader; a shell string or issue text in a command line |
| Desktop task actions and dispatch | `desktop/runtime/task-*.mjs` (action IPC, dispatch, queue runner, worktrees, GitHub issues and sign-in, task images), plus the `pomegr:task-action`, `pomegr:task-start`, `pomegr:task-worktree-open`, `pomegr:task-issues`, and `pomegr:task-image` handlers registered in `shell-main.mjs` and `preload.cjs`; run `node --test tests/desktop-task-*.test.mjs tests/desktop-security.test.mjs` | A browser or LAN mutation path; renderer-supplied paths, commands, or URLs; a shell string launch or task text in a command line; imports of `server/` internals; any stop, attach, or input to a started session |
| Task board UI | `app/tasks/page.tsx` (the root `/tasks` route), `app/components/tasks/` (`TasksPage.tsx` picks the repository, `TaskBoardPane.tsx` is the one board implementation), `app/tasks-store.ts`, `app/components/tasks/task-search.ts` with `app/components/command-center/palette-scope.ts` (the board's tasks in the Search bar), and `app/api/tasks/route.ts`, plus a `/design-system` sample for any new shared control; run `npx vitest run tests/ui/task tests/ui/new-task tests/ui/repository-tasks tests/ui/session-task` | Mutation outside the desktop IPC, direct monitor fetches from components, task state derived or retracted in React, task content outside the Tasks surfaces |
| Agent task tools | `mcp/task-tools.mjs` (registered from `mcp/server.mjs`), `shared/agent-query-transport.mjs`, and the session-binding scripts and sources in `plugins/claude-code/scripts/` and `plugin-src/`, then `npm run build:plugin`; run `node --test tests/mcp-task-tools.test.mjs tests/pomegr-plugin.test.mjs tests/codex-plugin.test.mjs` | A session or repository ID supplied by the model, a write path beyond the three tool paths and the session-start `bind` in [the contract](../architecture/tasks.md#boundaries), `desktop/` imports, hand-edited `plugins/**` bundles |
| Browser/API state | `app/`, `shared/`, `app/api/` | `server/` imports from React |
| Repository index and detail (`/repositories`, `/repositories/<repositoryId>`) | `app/components/repositories/`, `app/repositories/`, shared Settings geometry in `app/styles/shell.css`, and repository styles in `app/styles/workspace.css`; run `npx vitest run tests/ui/repository-inventory.test.tsx tests/ui/repository-detail.test.tsx` | New acquisition in browser GETs, raw repository paths/configuration, or bypassing native action confirmation |
| Any UI control, chip, token, or style | `DESIGN.md` first, then `app/styles/tokens.css` and the button roles in `app/styles/shell.css`; verify on `/design-system` and in `tests/ui/pomegr-design-contract.test.tsx` | Literal colors, radii, or font sizes; a seventh button style; bespoke chip formats |
| Design-system reference (web only, `/design-system`) | `app/design-system/page.tsx`, `app/components/design-system/`, `app/styles/design-system.css`, hidden paths in `desktop/runtime/security-policy.mjs`, `DESIGN.md` | Navigation entries, LAN gateway `APP_PATHS`, desktop `loadURL` triggers, monitor fetches, session data, edits to shared shell/session/evidence styles |
| Desktop lifecycle | `desktop/runtime/` (packaged app code); generated service bundles land in `desktop/workers/` | Renderer access to credentials or raw server files; packaging or release tooling |
| Desktop packaging and release | `desktop/packaging/` (build, electron-builder hooks, artifact and release policy, acceptance tools); procedures in [desktop releases](../operations/desktop-releases.md), [beta acceptance](../operations/desktop-beta-acceptance.md), and the [clean-VM checklist](../operations/desktop-clean-vm.md) | Imports from `desktop/runtime/` into packaging tooling are fine; the reverse is not, and none of these files ship in the app |
| Web host (Node server for the built dashboard) | `server/web/` (`server.mjs`, `cli.mjs`; `entry.ts` is the Vite server entry) | Imports of monitor modules under `server/`; the monitor importing `server/web/` |
| Landing site | `landing/` and its own `package.json`; deployment and documentation publication in [website operations](../operations/website.md); run `npm --prefix landing run test`, `typecheck`, and `build:audit` (publication-boundary tests: `landing/tests/ui/docs-exclusion.test.ts`, `docs-artifact.test.ts`) | Main application scripts and monitor state; landing code reading outside `landing/` except the documentation loader |
| Generated plugins | `plugin-src/`, then `npm run build:plugin` | Direct edits to `plugins/**` generated artifacts |

The five task rows route the task board and dispatcher specified in the
[task board contract](../architecture/tasks.md). The development server refuses a LAN peer's
`/api/tasks` read in `scripts/provider-folders-local-gate.mjs`
(`node --test tests/provider-folders-local-gate.test.mjs`). The same gate marks a LAN peer's
`/api/sessions` read with `x-pomegr-lan-gateway`, so the Sessions list serves it no task
reference (`tests/server/tasks/task-session-link.test.mjs`, `tests/ui/sessions-view.test.tsx`).

## Server layout

`server/` is the private loopback backend (the "monitor" process). Each folder owns one
behavior, and `npm run check:boundaries` enforces the import column with one
dependency-cruiser rule per folder. A post-edit agent hook
(`scripts/agent-edit-check.mjs`) runs the same check after every source edit.

| Folder | Owns | Pipeline phase | May import (inside `server/`) |
| --- | --- | --- | --- |
| `server.mjs`, `cli.mjs`, `dev-cli.mjs` | Entry points and composition | — | Anything; the only importers of `runtime/` and `serving/` |
| `runtime/` | Observation lifecycle, coordination, startup | Orchestrates U1–P | Anything except `serving/` |
| `normalize/` | Record normalizers and value primitives shared by core and adapters | U2 kernel | `normalize/` only |
| `providers/` | `index`, `registry`, `provider-contract`: the only provider files generic code may import | U1/U2 seam | `providers/**`, `normalize/` |
| `providers/kernel/` | Provider-neutral ingestors, observers, ledgers | U1 | `normalize/`, `diagnostics/pipeline-operations{,-failures}.mjs` |
| `providers/claude/`, `providers/codex/` | One adapter each; never import each other | U1, U2 | `providers/kernel/`, `providers/provider-contract.mjs`, `normalize/` |
| `sessions/catalog/` | Session catalog rows and inventory | D | `normalize/`, `sessions/domain/`, provider contract, `persistence/prepared-statements.mjs` |
| `sessions/domain/` | Session projections and domain serving | D | `normalize/`, `analytics/`, `repository/`, provider contract |
| `sessions/checkpoints/` | L1 observation store, checkpoints, restore | C, P | `normalize/`, `repository/`, `sessions/catalog/`, `sessions/domain/`, provider contract |
| `sessions/history/` | Incremental session history store and refresh | P | `normalize/` |
| `analytics/` | Cache, context, efficiency, and agent derivations | D | `normalize/` |
| `notifications/` | Pure notification rules and bounded occurrence ledger | D | `notifications/`, `normalize/` only |
| `tasks/` | Task store, record validation, board projection; a control plane outside the observation pipeline | — | `tasks/`, `normalize/`, `persistence/` only |
| `repository/` | Git state, pull requests, snapshots, file history | U1 (Git), D | `normalize/`, `persistence/` |
| `resources/` | Resource sampling and history | U1 (OS), D | `normalize/`, `persistence/prepared-statements.mjs` |
| `persistence/` | SQLite store, retention, committed response caches | C, P | `normalize/` |
| `serving/` | HTTP request handling | S | `normalize/`, `persistence/`, `repository/`, `sessions/domain/`, provider contract |
| `diagnostics/` | Pipeline operations, logs, dev tracing | — | `normalize/`, provider contract |
| `web/` | Node host for the built dashboard (LAN-reachable, not the monitor); `entry.ts` is the Vite server entry | — | `web/` only; reaches the monitor over HTTP. No monitor folder may import it |

Tests mirror this tree under `tests/server/<same path>.test.mjs`; cross-cutting server
tests sit at the `tests/server/` root.

## Focused verification

Run the smallest relevant command while iterating:

```powershell
npm run test:contracts
npm run test:ops
node --test tests/<one-file>.test.mjs
npx vitest run tests/ui/<one-file>.test.tsx
npm --prefix landing run test -- tests/<one-file>.test.tsx
npm run check:architecture
npm run check:boundaries
npm run check:docs
```

Before handing off a change, run `npm run verify:fast` (lint, type checks, `npm run check:docs`, architecture and boundary checks, contract and operations tests). The full `npm run verify`
also rebuilds generated plugin artifacts, runs the root and landing suites, and checks
that generated files are in sync. Desktop packaging uses
`npm run desktop:prepare:from-build` after a verifier/build has already produced the
web output; `npm run desktop:prepare` remains the compatibility wrapper that builds
from scratch. The web build generates legal notices before copying public assets.
Preparation from an existing build checks that the built legal copies still match
exactly before bundling services; it never regenerates legal files after the web build.

`npm run verify:desktop` runs the full Windows desktop smoke with a hidden production
`BrowserWindow`. Pull requests targeting `main` and pushes to `main` run
[Windows verification](../../../.github/workflows/verify.yml) on `windows-2022` with Node
22.13.0. It installs the locked root and landing dependencies plus Electron's on-demand
runtime, checks the checked-out commit's release source archive with
`npm run check:release-source -- --ref HEAD`, then runs the canonical `npm run verify` followed by
`npm run desktop:smoke:ci`. The CI-safe smoke exercises the packaged Electron main
process, ASAR/native runtime, loopback services, provider discovery, APIs, privacy
checks, and shutdown without constructing an Electron renderer. The canonical verifier
owns the UI, landing, repository-inventory, and desktop-security suites without repeating
them in a second desktop wrapper. `npm run verify:desktop:ci` remains available for
focused local use. The full sandboxed preload, renderer, and `BrowserWindow` smoke
remains a local or interactive-VM release acceptance requirement.

Windows verification can also be dispatched manually from Actions without creating a
release tag. Keep this workflow enabled in GitHub so PR and main events can start it.

Creating or pushing a tag does not start the Windows release workflow; dispatch it
manually with the existing release tag only after the candidate is ready to package and
publish.

The independent public landing deployment is also manual: dispatch
`.github/workflows/deploy-landing.yml` with the branch to deploy. It runs the landing
tests, typecheck, build, and artifact audit before deploying to Cloudflare. See
[website operations](../operations/website.md) for GitHub secrets and production setup.

`npm run release:windows -- --tag vX.Y.Z` releases a version that was already bumped:
`npm run version:bump -- X.Y.Z` commits the version and pushes the checked-out branch, it
reaches `main` by the usual merge,
and the command never
edits the version. For a tag GitHub does not have yet, it requires a clean `main` that
matches `origin/main` with that version in `package.json`, creates and pushes the
annotated tag, runs the release-point checks, and dispatches
the Windows workflow with the exact clean local and remote tagged commit. An existing
remote tag is only checked and dispatched, never changed.
CI checks that SHA, installs both dependency trees and the Electron runtime, runs the
canonical verifier and CI desktop smoke, then owns signing, artifact/privacy checks,
and publication. The SHA
selects the release commit; it is not proof that tests ran locally. Use `--check-only`
to validate without dispatch. Run with Git and GitHub CLI available; see
[desktop releases](../operations/desktop-releases.md).

`npm run check:boundaries` also rejects unreferenced production modules.
Treat each orphan as a diagnostic to review for stale code or a missing dynamic entry
point; do not delete a module solely because a static graph cannot see a runtime load.

Production web tests copy the complete `dist` tree into a private temporary fixture.
The Vinext build wrapper and fixture copier share a filesystem lock, so concurrent
checkout builds cannot mix server HTML with a different set of hashed client assets.
The lock is released after copying; tests serve their private build while other work
continues. Use `npm run build` (or `scripts/run-vinext.mjs build`) so this coordination
is preserved.
