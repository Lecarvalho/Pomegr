# Agent workflow

`AGENTS.md` is the repository-wide policy. This table routes a change to the nearest
behavior owner so a coding agent can discover the contract before editing it.

| Change area | Start here | Keep out of this area |
| --- | --- | --- |
| Provider discovery, parsing, normalization | `monitor/providers/` and `monitor/providers/provider-contract.mjs` | React components and raw provider schemas in shared code |
| Observation cache, checkpoints, readiness, API cadence | `docs/OBSERVATION_CACHE.md`, `monitor/observation-runtime.mjs`, and `monitor/session-observation-*.mjs` | Raw parsing in serving handlers; frontend control of acquisition or persistence |
| Monitor indexing, projection, enrichment | `monitor/server.mjs`, `monitor/` utilities | Browser credentials, prompts, responses, and provider-native payloads |
| Internal pipeline operations and timing | `docs/PIPELINE_OPERATIONS.md`, `monitor/pipeline-operations*.mjs`, and `scripts/pipeline-ops.mjs` | Browser API fields, transcript/source identity, persisted diagnostics, or diagnostic reads that trigger pipeline work |
| Agents model and work analytics | `monitor/agents-analytics.mjs`, `monitor/agents-observation.mjs`, `shared/agents-contract.ts`, and `app/agents/` | Provider acquisition or aggregation in GETs; browser-owned analytics caches |
| Browser/API state | `app/`, `shared/`, `app/api/` | `monitor/providers/` imports from React |
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
from scratch.

`npm run verify:desktop` runs the full Windows desktop smoke with a hidden production
`BrowserWindow`. GitHub-hosted Windows runners have no interactive desktop, so the
tag-triggered release workflow uses `npm run verify:desktop:ci`: it exercises the packaged
Electron main process, ASAR/native runtime, loopback services, provider discovery, APIs,
privacy checks, and shutdown without constructing an Electron renderer. The canonical UI
and desktop-security suites remain part of that workflow, while the full sandboxed preload,
renderer, and `BrowserWindow` smoke remains a local or interactive-VM release acceptance
requirement.

PR/main GitHub Actions verification is intentionally paused. Run `npm run verify` and the
applicable desktop command locally before pushing. The tag-only Windows release workflow
remains available for explicitly created release tags.

`npm run check:boundaries` also rejects unreferenced production modules.
Treat each orphan as a diagnostic to review for stale code or a missing dynamic entry
point; do not delete a module solely because a static graph cannot see a runtime load.

Production web tests copy the complete `dist` tree into a private temporary fixture.
The Vinext build wrapper and fixture copier share a filesystem lock, so concurrent
checkout builds cannot mix server HTML with a different set of hashed client assets.
The lock is released after copying; tests serve their private build while other work
continues. Use `npm run build` (or `scripts/run-vinext.mjs build`) so this coordination
is preserved.
