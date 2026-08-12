# AGENTS.md

## Product identity

- The product has one name: **Threadlight**.
- Use `threadlight` for package, repository, and directory identifiers.
- Keep the name provider-neutral. Provider names belong only in adapter-specific configuration and documentation.

## Purpose

Threadlight is a local-first, read-only observer for coding-agent sessions. It presents real execution metadata and deterministic efficiency signals. Never imply that a heuristic is an AI judgment or authoritative measurement.

## Architecture

- `monitor/server.mjs` owns discovery, transcript history indexing, parsing, normalization, Git inspection, usage-limit retrieval, and deterministic metrics.
- `app/Dashboard.tsx` renders normalized state and must not access credentials or raw session files.
- `app/api/state/route.ts` and `app/api/sessions/route.ts` are same-origin proxies to the loopback monitor.
- `scripts/dev.mjs` starts the monitor and web application together.
- Keep provider transcript schemas out of React components.

## Security and privacy invariants

- Never return raw prompts, responses, tool-result content, OAuth tokens, or credential-file contents to the browser.
- Claude status-line cost capture may persist and expose only the normalized session ID, non-negative `total_cost_usd`, USD currency label, estimate type, and local observation timestamp. Never persist other status-line fields, and always present the value as a Claude Code estimate rather than authoritative billing.
- Execution-task metadata may expose only normalized tool/background IDs, the Bash description, shell kind, lifecycle status, timestamps, background flag, and exit code. Never expose commands, stdout, stderr, or task-notification output.
- Plan-task metadata may expose only normalized task ID, subject, status, and dependency IDs from the structured task store. Never expose task descriptions or active-form text, and always label the checklist as agent-maintained and potentially stale.
- Session- and agent-signal metadata may expose only a bounded plain-text label, semantic tone, transcript-derived timestamp, and optional bounded, one-line plain-text description from a recognized Threadlight MCP tool call. Never expose other MCP arguments or tool-result content, and present signals as agent-reported rather than Threadlight judgments.
- Task-signal metadata may attach the same bounded fields only to a matching normalized execution task resolved monitor-side from a safe tool-use or background-task ID. Never expose the MCP-supplied target separately or include unmatched task signals in the browser API.
- Keep the monitor bound to loopback.
- Send OAuth credentials only to the provider's authenticated usage endpoint.
- Use `execFileSync`/`spawn` with argument arrays; do not interpolate session-derived paths into shell commands.
- Keep monitoring read-only. Future control actions require an explicit confirmation boundary.
- Cache external usage requests and sanitize failures.
- Historical views must never expose current plan limits or substitute the current Git working tree for recorded session state.

## Metric conventions

- “Context” means the latest non-zero usage snapshot, not historical throughput.
- “All-agent context” is the sum of each visible agent's latest context snapshot.
- Present only latest context snapshots or sums derived from them. Never derive or present cumulative transcript throughput, token-spend totals, or recent token rates. A provider-reported cumulative session-cost estimate captured from Claude Code's status-line feed is the sole exception and must remain explicitly labeled as an estimate.
- Context-growth timelines must carry each agent's latest snapshot to each bucket boundary and plot only the positive change from the preceding boundary. Repeated snapshots contribute zero; never sum full usage snapshots or label the result as token spend.
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

The dashboard binds to `0.0.0.0:3003` and is reachable at `http://<LAN-IP>:3003`; the private monitor listens on `127.0.0.1:4317`.

## Change checklist

1. Preserve the normalized API contract or update frontend and docs together.
2. Verify `/api/state` serializes no prompt, response, or credential values.
3. Run `npm run build` for implementation changes.
4. Run `npm test` for rendering, metric, parser, or structure changes.
5. Never commit `.env`, transcripts, credentials, build output, or Wrangler state.
