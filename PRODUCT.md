# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a developer observing active and historical coding-agent sessions.

## Product Purpose

Pomegr presents live and recorded coding-agent execution metadata in a dashboard so people can understand session state, agent activity, context usage, repository changes, usage limits, and concrete efficiency signals without exposing the underlying conversation.

Success means making active work and attention needs legible while keeping the observation layer local, read-only, privacy-preserving, and faithful to recorded provider state.

## Positioning

Pomegr is a local, read-only observer that normalizes existing session records into a live dashboard and explainable signals.

## Operating Context

- Pomegr runs locally alongside a coding-agent harness and reads the provider's existing session records.
- The web dashboard is available on the local network, while the privileged monitor remains bound to loopback.
- Live sessions refresh continuously; historical sessions show recorded session state only.
- Users can inspect concurrent sessions, attention state, agent hierarchy, latest context snapshots, bounded actual-level context history, bounded normalized cache events, tool activity, Git changes, pull requests, usage limits, and deterministic insights.
- Users can download deterministic Markdown retrospective reports assembled from normalized state.

## Capabilities and Constraints

- Claude Code is the current provider adapter. Codex support is planned and must produce the same provider-neutral normalized shapes.
- Monitoring is read-only. Control actions require a future explicit confirmation boundary.
- The browser receives normalized metadata only. Raw prompts, responses, commands, tool-result content, transcripts, OAuth tokens, and credential contents must not be exposed.
- The monitor is responsible for transcript discovery and parsing, normalization, Git inspection, usage-limit retrieval, and deterministic metrics. Provider transcript schemas do not belong in React components.
- Context means the latest non-zero provider usage snapshot. Context history carries those snapshots forward at bounded bucket boundaries to show actual per-agent levels or an explicitly labeled sum of agent snapshots; it is not throughput, unique shared memory, or spend.
- Request snapshots are a separate bounded chronological view of independent provider usage observations. Each row is one request and is never carried forward, differenced, bucketed, or summed into session throughput.
- Cache events are bounded, monitor-derived, agent-attributed observations from provider-comparable usage evidence. They expose only normalized refill, reuse, and cautious miss-refill metadata; they never expose raw usage records or claim a cause, bill, charge, or savings amount.
- Pomegr does not present cumulative transcript throughput, token-spend totals, or recent token rates.
- Historical views must not expose current plan limits or substitute the current Git working tree for recorded state.
- Efficiency signals and recommendations are deterministic heuristics tied to concrete events, never AI judgments or authoritative measurements.
- Provider failures must degrade independently.
- The current local development environment requires Windows, Node.js 22.13 or newer, Git, and locally persisted Claude Code sessions.

## Brand Commitments

- The product has one provider-neutral name: **Pomegr**. Use `pomegr` for package, repository, and directory identifiers.
- Provider names belong only in adapter-specific configuration, implementation, and documentation.
- Product language must distinguish provider-reported estimates, agent-reported signals, and deterministic Pomegr heuristics from authoritative facts or AI judgments.

## Evidence on Hand

- The working dashboard, monitor, provider adapter, normalized contract, MCP signal server, deterministic report generator, and automated test suite are present in this repository.
- Product and privacy behavior are documented in `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, and `docs/METRICS.md`.
- The current interface is implemented under `app/`.
- No testimonials, customer logos, external benchmarks, pricing claims, or deployment claims are established in the repository and future work must not fabricate them.

## Product Principles

1. Observe without controlling or exposing the underlying work.
2. Preserve provider provenance and recorded historical truth.
3. Make every signal reproducible, explainable, and traceable to concrete events.
4. Keep privileged data and credentials inside the loopback monitor boundary.
5. Maintain one provider-neutral product model while allowing adapters to fail independently.
