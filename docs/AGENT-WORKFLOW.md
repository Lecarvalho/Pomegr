# Agent workflow

`AGENTS.md` is the repository-wide policy. This table routes a change to the nearest
behavior owner so a coding agent can discover the contract before editing it.

| Change area | Start here | Keep out of this area |
| --- | --- | --- |
| Documentation, migration, and temporary artifacts | [Maintenance workflow](internal/development/documentation.md), [style guide](STYLE_GUIDE.md), and [maintainer index](internal/README.md); use the workflow's documentation checks and `npm run verify:fast` | Duplicate authorities, publication of internal material, or completed plans retained as archives |
| Provider discovery, parsing, normalization | `monitor/providers/` and `monitor/providers/provider-contract.mjs` | React components and raw provider schemas in shared code |
| Observation cache, checkpoints, readiness, API cadence | `docs/OBSERVATION_CACHE.md`, `monitor/observation-runtime.mjs`, and `monitor/session-observation-*.mjs` | Raw parsing in serving handlers; frontend control of acquisition or persistence |
| Monitor indexing, projection, enrichment | `monitor/server.mjs`, `monitor/` utilities | Browser credentials, prompts, responses, and provider-native payloads |
| Internal pipeline operations and timing | `docs/PIPELINE_OPERATIONS.md`, `monitor/pipeline-operations*.mjs`, and `scripts/pipeline-ops.mjs` | Browser API fields, transcript/source identity, persisted diagnostics, or diagnostic reads that trigger pipeline work |
| Agents model and work analytics | `monitor/agents-analytics.mjs`, `monitor/agents-observation.mjs`, `shared/agents-contract.ts`, and `app/agents/` | Provider acquisition or aggregation in GETs; browser-owned analytics caches |
| Browser/API state | `app/`, `shared/`, `app/api/` | `monitor/providers/` imports from React |
| Repository index and detail (`/repositories`, `/repositories/<repositoryId>`) | `app/components/repositories/`, `app/repositories/`, shared Settings geometry in `app/styles/shell.css`, and repository styles in `app/styles/workspace.css`; run `npx vitest run tests/ui/repository-inventory.test.tsx tests/ui/repository-detail.test.tsx` | New acquisition in browser GETs, raw repository paths/configuration, or bypassing native action confirmation |
| Any UI control, chip, token, or style | `DESIGN.md` first, then `app/styles/tokens.css` and the button roles in `app/styles/shell.css`; verify on `/design-system` and in `tests/ui/pomegr-design-contract.test.tsx` | Literal colors, radii, or font sizes; a seventh button style; bespoke chip formats |
| Design-system reference (web only, `/design-system`) | `app/design-system/page.tsx`, `app/components/design-system/`, `app/styles/design-system.css`, hidden paths in `desktop/security-policy.mjs`, `DESIGN.md` | Navigation entries, LAN gateway `APP_PATHS`, desktop `loadURL` triggers, monitor fetches, session data, edits to shared shell/session/evidence styles |
| Desktop lifecycle and packaging | `desktop/`, `desktop/workers/` | Renderer access to credentials or raw monitor files |
| Landing site | `landing/` and its own `package.json` | Main application scripts and monitor state |
| Generated plugins | `plugin-src/`, then `npm run build:plugin` | Direct edits to `plugins/**` generated artifacts |

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
```

Before handing off a change, run `npm run verify:fast`. The full `npm run verify`
also rebuilds generated plugin artifacts, runs the root and landing suites, and checks
that generated files are in sync. Desktop packaging uses
`npm run desktop:prepare:from-build` after a verifier/build has already produced the
web output; `npm run desktop:prepare` remains the compatibility wrapper that builds
from scratch. The web build generates legal notices before copying public assets.
Preparation from an existing build checks that the built legal copies still match
exactly before bundling services; it never regenerates legal files after the web build.

`npm run verify:desktop` runs the full Windows desktop smoke with a hidden production
`BrowserWindow`. GitHub-hosted Windows runners have no interactive desktop, so the
manually dispatched release workflow runs the canonical `npm run verify` followed by
`npm run desktop:smoke:ci`. The latter exercises the packaged Electron main process,
ASAR/native runtime, loopback services, provider discovery, APIs, privacy checks, and
shutdown without constructing an Electron renderer. The canonical verifier owns the UI,
landing, repository-inventory, and desktop-security suites without repeating them in a
second desktop wrapper. `npm run verify:desktop:ci` remains available for focused local use.
The full sandboxed preload, renderer, and `BrowserWindow` smoke remains a local or
interactive-VM release acceptance requirement.

PR/main GitHub Actions verification is intentionally paused. Run `npm run verify` and the
applicable desktop command locally before pushing. Creating or pushing a tag does not start
the Windows release workflow; dispatch it manually with the existing release tag only after
the candidate is ready to package and publish.

The independent public landing deployment is also manual: dispatch
`.github/workflows/deploy-landing.yml` with the branch to deploy. It runs the landing
tests, typecheck, build, and artifact audit before deploying to Cloudflare. See
`landing/OPERATIONS.md` for GitHub secrets and production setup.

`npm run release:windows -- --tag vX.Y.Z` performs only release-point checks and
dispatches the Windows workflow with the exact clean local and remote tagged commit.
CI checks that SHA, installs both dependency trees and the Electron runtime, runs the
canonical verifier and CI desktop smoke, then owns signing, artifact/privacy checks,
and publication. The SHA
selects the release commit; it is not proof that tests ran locally. Use `--check-only`
to validate without dispatch. Run with Git and GitHub CLI available; see
`docs/DESKTOP_RELEASES.md`.

`npm run check:boundaries` also rejects unreferenced production modules.
Treat each orphan as a diagnostic to review for stale code or a missing dynamic entry
point; do not delete a module solely because a static graph cannot see a runtime load.

Production web tests copy the complete `dist` tree into a private temporary fixture.
The Vinext build wrapper and fixture copier share a filesystem lock, so concurrent
checkout builds cannot mix server HTML with a different set of hashed client assets.
The lock is released after copying; tests serve their private build while other work
continues. Use `npm run build` (or `scripts/run-vinext.mjs build`) so this coordination
is preserved.
