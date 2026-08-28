# Agent workflow

`AGENTS.md` is the repository-wide policy. This table routes a change to the nearest
behavior owner so a coding agent can discover the contract before editing it.

| Change area | Start here | Keep out of this area |
| --- | --- | --- |
| Provider discovery, parsing, normalization | `monitor/providers/` and `monitor/providers/provider-contract.mjs` | React components and raw provider schemas in shared code |
| Monitor indexing, projection, enrichment | `monitor/server.mjs`, `monitor/` utilities | Browser credentials, prompts, responses, and provider-native payloads |
| Browser/API state | `app/`, `shared/`, `app/api/` | `monitor/providers/` imports from React |
| Desktop lifecycle and packaging | `desktop/`, `desktop/workers/` | Renderer access to credentials or raw monitor files |
| Landing site | `landing/` and its own `package.json` | Main application scripts and monitor state |
| Generated plugins | `plugin-src/`, then `npm run build:plugin` | Direct edits to `plugins/**` generated artifacts |

## Focused verification

Run the smallest relevant command while iterating:

```powershell
npm run test:contracts
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
`BrowserWindow`. GitHub-hosted Windows runners have no interactive desktop, so PR and
release workflows use `npm run verify:desktop:ci`: it exercises the same Electron main
process, ASAR/native runtime, sandboxed preload and renderer, loopback services, APIs,
privacy checks, and shutdown through an unattached `WebContentsView`. A full
`BrowserWindow` smoke remains a local or interactive-VM release acceptance requirement.

`npm run check:boundaries` also rejects unreferenced production modules.
Treat each orphan as a diagnostic to review for stale code or a missing dynamic entry
point; do not delete a module solely because a static graph cannot see a runtime load.
