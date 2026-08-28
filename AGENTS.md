# AGENTS.md

## Product identity

- The product has one name: **Pomegr**.
- Use `pomegr` for package, repository, and directory identifiers.
- Keep the name provider-neutral. Provider names belong only in adapter-specific configuration and documentation.

## Purpose

Pomegr is a local-first, read-only observer for coding-agent sessions. It presents real execution metadata and deterministic efficiency signals. Never imply that a heuristic is an AI judgment or authoritative measurement.

## Collaboration

- The user grants standing permission to use subagents for repository work whenever parallel or independent assessment would improve the result. Do not ask for subagent permission again.
- Default subagents and workflow workers to the cheapest capable model, such as Sonnet, Haiku (Claude), Terra, Luna (Codex). Reserve larger models for stages that genuinely need stronger reasoning, and never leave investigative or probe agents on the session's default model by accident.

## Change routing

- Use `docs/AGENT-WORKFLOW.md` to locate the behavior owner, focused test command, and forbidden dependency direction for monitor, provider, UI, desktop, landing, or generated-plugin work.
- Treat `docs/OBSERVATION_CACHE.md` as the canonical operational contract for provider observation phases, cache ownership and bounds, checkpoint cadence, endpoint serving, revision semantics, readiness, UI polling, and skeleton behavior. Plans under `docs/plans/` are historical records, not runtime authority.
- Provider adapters must satisfy the executable catalog, manifest, readiness, evidence, and conformance rules in `monitor/providers/provider-contract.mjs`; provider-specific transcript schemas stay inside their adapter modules.

## Architecture

- `monitor/server.mjs` owns discovery, transcript history indexing, parsing, normalization, Git inspection, usage-limit retrieval, and deterministic metrics.
- `app/Dashboard.tsx` renders normalized state and must not access credentials or raw session files.
- `app/api/state/route.ts`, `app/api/sessions/route.ts`, `app/api/home/route.ts`, and `app/api/usage-limits/route.ts` are same-origin proxies to the loopback monitor.
- `scripts/dev.mjs` starts the monitor and web application together.
- Keep provider transcript schemas out of React components.
- Production session, catalog, Home, and usage-limit GETs serve only committed response caches. A request may queue asynchronous hydration, but it must never synchronously acquire, parse, or normalize provider data.
- Source read/chunk bounds control upstream acquisition cost only; they must never control the lifetime of already-normalized evidence. Preserve the last known-good revision until a complete replacement validates and commits atomically.
- Keep U1 Acquisition, U2 Normalization, C Commit, D Derivation, P Persistence, S Serving, and F Presentation ownership aligned with `docs/OBSERVATION_CACHE.md`.

## Security and privacy invariants

- Never return raw prompts, responses, tool-result content, OAuth tokens, or credential-file contents to the browser.
- Local transcript paths may be disclosed only through the one-shot same-origin transcript-path endpoint after an explicit user copy action. Never include them in state, session catalogs, reports, logs, or error text.
- Provider-native agent kinds and repository role-map contents are monitor-private. The browser may receive only the bounded normalized `Agent.role` enum; it must never receive or reinterpret a provider kind.
- Claude status-line cost capture may persist and expose only the normalized session ID, non-negative `total_cost_usd`, USD currency label, estimate type, and local observation timestamp. Never persist other status-line fields, and always present the value as a Claude Code estimate rather than authoritative billing.
- Claude five-hour rejection metadata may expose only the earliest normalized local rejection timestamp matched monitor-side to the current reset window. Never expose raw quota payloads or describe that timestamp as the authoritative instant the provider exhausted the account.
- Execution-task metadata may expose only normalized tool/background IDs, the Bash description, shell kind, lifecycle status, timestamps, background flag, exit code, and a bounded enum-based failure category derived monitor-side. Never expose commands, stdout, stderr, matched source text, or task-notification output.
- Plan-task metadata may expose only normalized task ID, subject, status, and dependency IDs from the structured task store. Never expose task descriptions or active-form text, and always label the checklist as agent-maintained and potentially stale.
- Session- and agent-signal metadata may expose only a bounded plain-text label, semantic tone, transcript-derived timestamp, and optional bounded, one-line plain-text description from a recognized Pomegr MCP tool call. Never expose other MCP arguments or tool-result content, and present signals as agent-reported rather than Pomegr judgments.
- Pomegr plugin metadata may expose only an exact bounded plugin version, recognized policy status and version, and transcript-derived observation timestamp from a provider-owned SessionStart hook marker. Never accept user-authored lookalikes, expose surrounding hook or policy content, or treat an absent observation as proof that the plugin is uninstalled. Historical views must preserve the session-observed values.
- Task-signal metadata may attach the same bounded fields only to a matching normalized execution task resolved monitor-side from a safe tool-use or background-task ID. Never expose the MCP-supplied target separately or include unmatched task signals in the browser API.
- Context-history metadata may expose only bounded bucket timestamps, actual context totals, normalized visible-agent IDs with their actual context totals, and bounded normalized boundaries containing an opaque ID, normalized agent ID, timestamp, fixed automatic-compaction/manual-compaction/snapshot-drop kind, and optional prior context total. Never expose raw usage records, provider message IDs, compaction summaries or content, unrecognized provider metadata, or cache-category history through this surface.
- Agent cache-lifetime metadata may expose only the authoritative aggregate `5m`, `1h`, `mixed`, or `null` derived from every retained, resolved request lifetime for that normalized agent. The aggregate is per agent, never session-wide or latest-only. Raw provider cache-control blocks and token breakdowns remain monitor-private.
- Cache-event metadata may expose only a bounded normalized event ID, normalized agent ID, recognized event kind, observation timestamp, prompt-input token count, cache-read percentages, cache-write token count, elapsed gap, a normalized related-event ID, bounded per-agent possible-full-refill counts, bounded counts of recognized provider-diagnosed request-divergence categories, the provider-neutral `previous_cache_entry_unavailable` status, a bounded lifetime-expiry inference containing only `5m`/`1h`/`mixed` plus elapsed milliseconds, and bounded fixed tool-definition labels/change kinds from a recognized monitor-side lifecycle attribution. Inferences must be explicitly labeled as inferences and require complete structural evidence; never expose raw lifecycle records, diagnostics, diagnostic token estimates, usage records, provider message/session/bridge IDs, model identifiers, comparison groups, cache keys, prompts, schemas, raw cache-lifetime token breakdowns, or inferred cost and savings.
- Request-snapshot metadata may expose only a bounded opaque ID, normalized agent ID, observation timestamp, the resolved `5m`/`1h`/`mixed` cache lifetime or `null`, normalized request-local uncached-input, cache-write, cache-read, and output counts, and their recomputed request-local total. Never expose raw usage records, provider cache-control blocks or lifetime token breakdowns, provider message/session/event IDs, model identifiers, comparison groups, dedupe keys, provider totals, cumulative totals, prompts, or billing fields.
- Keep the monitor bound to loopback.
- Send OAuth credentials only to the provider's authenticated usage endpoint.
- Use `execFileSync`/`spawn` with argument arrays; do not interpolate session-derived paths into shell commands.
- Keep monitoring read-only. Future control actions require an explicit confirmation boundary.
- Cache external usage requests and sanitize failures.
- Historical views must never expose current plan limits or substitute the current Git working tree for recorded session state.
- Observation checkpoints may persist only contract-valid normalized evidence, bounded source fingerprints and complete-record offsets, readiness, revision, and observation timestamps. Never persist raw provider records, incomplete fragments, transcript paths, or other browser-forbidden content.

## Metric conventions

- “Context” means the latest non-zero usage snapshot, not historical throughput.
- “All-agent context” is the sum of each visible agent's latest context snapshot.
- Present context only as latest snapshots or sums derived from them. A bounded request-snapshot feed may present independent request-local observations, but must never bucket, carry forward, delta, or sum them across requests or agents. Never derive or present cumulative transcript throughput, token-spend totals, or recent token rates. A provider-reported cumulative session-cost estimate captured from Claude Code's status-line feed is the sole exception and must remain explicitly labeled as an estimate.
- Context-history timelines must carry each visible agent's latest non-zero snapshot to each bucket boundary and plot the bounded actual context level for the selected agent or the explicit sum of agent snapshots. Repeated snapshots stay flat and context reductions remain visible; never reinterpret the series as throughput, unique shared memory, token spend, or cumulative usage.
- Cache-event views must be built monitor-side from bounded, provider-comparable usage observations and expose only recognized refill, reuse, cautious miss-refill evidence, a cache-expiry inference supported by a preceding resolved request lifetime and matching provider-neutral unavailable-entry status, or a fixed tool-definition attribution supported by a documented structural lifecycle rule. Rules operate independently within each normalized agent, including subagents and forks after they have comparable prior evidence. Missing, malformed, incomplete, incomparable, ambiguous, or unsupported evidence must degrade to unavailable; never infer an unsupported cause, bill, charge, or savings amount.
- Label elapsed duration as wall time because it includes idle gaps.
- Document heuristic changes in `docs/METRICS.md`.
- Rule-generated recommendations must trace to concrete events.

## Provider support

- Claude Code is the current adapter.
- Codex support must produce the same normalized session, agent, activity, token, repository, and insight shapes.
- Extract provider code into `monitor/providers/<provider>.mjs` before adding a second transcript format.
- Provider failures must degrade independently.

## Commands

```powershell
npm ci
npm run dev
npm run build
npm test
npm run lint
```

### Git and GitHub from Codex

- Run Git and GitHub CLI operations for this repository in the user's host environment,
  outside the managed Codex sandbox. This includes authentication checks, branch and index
  mutations, commits, pushes, and pull-request operations, so the user's keyring,
  credential helpers, SSH configuration, and `gh` session are available.
- Never diagnose GitHub authentication from a sandboxed `gh` result. Retry through the
  host environment before reporting an authentication problem or asking the user to sign
  in again.

### Codex on Windows

- In a managed Codex filesystem sandbox, run `npm run build` with escalated sandbox permissions because it overwrites the generated plugin bundles under `plugins/claude-code` and `plugins/pomegr`. A sandboxed run can report `Access is denied` or `EPERM` for a bundle even when Windows has no open handle or ACL restriction; do not diagnose that message as a process lock without independent handle evidence.
- `npm test` invokes `npm run build`, so it needs the same escalation when run as the full wrapper. The individual `test:plugin`, `test:node`, and `test:ui` scripts can remain sandboxed.
- Do not run `npm run build` and `npm test` concurrently. Both regenerate the same plugin bundles, and `npm test` already includes the build.

The dashboard binds to `0.0.0.0:3003` and is reachable at `http://<LAN-IP>:3003`; the private monitor listens on `127.0.0.1:4317`.

## Change checklist

1. Preserve the normalized API contract or update frontend and docs together.
2. Verify `/api/state` serializes no prompt, response, or credential values.
3. Run `npm run build` for implementation changes.
4. Run `npm test` for rendering, metric, parser, or structure changes.
5. Never commit `.env`, transcripts, credentials, build output, or Wrangler state.
6. For observation, cache, API-readiness, or polling changes, update `docs/OBSERVATION_CACHE.md` and verify cache-only GET behavior, last-known-good retention, revision handling, and checkpoint/browser privacy.
