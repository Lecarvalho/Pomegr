# AGENTS.md

## Product identity

- The product has one name: **Threadlight**.
- Use `threadlight` for package, repository, and directory identifiers.
- Keep the name provider-neutral. Provider names belong only in adapter-specific configuration and documentation.

## Purpose

Threadlight is a local-first, read-only observer for coding-agent sessions. It presents real execution metadata and deterministic efficiency signals. Never imply that a heuristic is an AI judgment or authoritative measurement.

## Architecture

- `monitor/server.mjs` owns discovery, transcript parsing, normalization, Git inspection, usage-limit retrieval, and deterministic metrics.
- `app/Dashboard.tsx` renders normalized state and must not access credentials or raw session files.
- `app/api/state/route.ts` is the same-origin proxy to the loopback monitor.
- `scripts/dev.mjs` starts the monitor and web application together.
- Keep provider transcript schemas out of React components.

## Security and privacy invariants

- Never return raw prompts, responses, tool-result content, OAuth tokens, or credential-file contents to the browser.
- Keep the monitor bound to loopback.
- Send OAuth credentials only to the provider's authenticated usage endpoint.
- Use `execFileSync`/`spawn` with argument arrays; do not interpolate session-derived paths into shell commands.
- Keep monitoring read-only. Future control actions require an explicit confirmation boundary.
- Cache external usage requests and sanitize failures.

## Metric conventions

- “Context” means the latest non-zero usage snapshot, not historical throughput.
- “All-agent context” is the sum of each visible agent's latest context snapshot.
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
