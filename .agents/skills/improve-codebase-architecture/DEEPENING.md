# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Assumes the vocabulary in [LANGUAGE.md](LANGUAGE.md) — **module**, **interface**, **seam**, **adapter**.

## Dependency categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new interface directly. No adapter needed.

In Pomegr: Normalization and Derivation logic such as metric rules, cache-event classification, context-history bucketing, and agent-role mapping.

### 2. Local-substitutable

Dependencies that have local test stand-ins. Deepenable if the stand-in exists. The deepened module is tested with the stand-in running in the test suite. The seam is internal; no port at the module's external interface.

In Pomegr: provider transcripts on disk (synthetic transcripts under `tests/fixtures/` or an isolated temporary provider home, never real sessions), checkpoints and the SQLite file-history index (a temporary directory), and Git inspection (a throwaway repository created in the test).

### 3. Remote but owned (Ports & Adapters)

Your own processes across a transport seam. In Pomegr: the loopback monitor behind the `app/api/*` same-origin proxies, desktop main/renderer IPC, monitor worker processes, and the Pomegr MCP server. Define a **port** (interface) at the seam. The deep module owns the logic; the transport is injected as an **adapter**. Tests use an in-memory adapter. Production uses the HTTP, IPC, or worker-message adapter.

Recommendation shape: *"Define a port at the seam, implement an HTTP adapter for production and an in-memory adapter for testing, so the logic sits in one deep module even though it's deployed across a network."*

### 4. True external (Mock)

Third-party services you don't control. In Pomegr: the provider usage endpoints, the Claude Remote Control metadata endpoint, provider service-status pages, GitHub via `gh`, and the provider CLIs and native processes. Tests never call them; `AGENTS.md` limits what may be sent to them at all. The deepened module takes the external dependency as an injected port; tests provide a mock adapter.

## Seam discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a port unless at least two adapters are justified (typically production + test). A single-adapter seam is just indirection.
- **Internal seams vs external seams.** A deep module can have internal seams (private to its implementation, used by its own tests) as well as the external seam at its interface. Don't expose internal seams through the interface just because tests use them.

## Testing strategy: replace, don't layer

- Old unit tests on shallow modules become waste once tests at the deepened module's interface exist — delete them.
- Write new tests at the deepened module's interface. The **interface is the test surface**.
- Tests assert on observable outcomes through the interface, not internal state.
- Tests should survive internal refactors — they describe behaviour, not implementation. If a test has to change when the implementation changes, it's testing past the interface.
