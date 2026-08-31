# Public provider service status

Pomegr reads public provider status reporting. It does not probe inference endpoints,
test an account, measure provider availability, or attribute a session failure to an
incident. The pipeline/cadence/cache contract is in `OBSERVATION_CACHE.md`.

## Sources and relevance

| Provider | Source | Relevant scope |
| --- | --- | --- |
| Codex | `https://status.openai.com/api/v2/summary.json` | Codex API and published local-client components; Codex Web-only incidents are excluded. |
| Claude | `https://status.claude.com/api/v2/summary.json` | Claude Code and Claude API; explicitly authentication-related claude.ai incidents may also apply. Cowork-only incidents are excluded. |

Claude documents its public API at `https://status.claude.com/api`. OpenAI's verified
summary currently exposes component status without an incident collection. Pomegr uses
that component evidence and links to the official status page when incident details
are absent. It does not depend on the nonworking OpenAI Statuspage-style unresolved
incident endpoint or infer an active incident from historical RSS entries. Recognized
structured incident data in the summary, when supplied, is filtered by affected component.

Mappings live inside `monitor/providers/provider-service-status.mjs`. New or missing
component identities and unknown statuses cannot silently establish healthy service.
Only active maintenance affects current health. Public status may cover a broader scope
than one account or model, so notices describe reported service issues and possible
impact rather than claiming that the selected session is affected.

## API and presentation

`GET /api/provider-status?revision=<number>` is a same-origin, cache-only proxy to the
loopback monitor. It returns `ProviderStatusSnapshot` from `shared/monitor-contract.ts`.
The response contains both provider rows with independent readiness and freshness.
`checkedAt` is the last successful local check; `updatedAt` is the latest relevant
provider update available from the public source. These are different timestamps.

The frontend's single shared store supplies compact status on Home and Usage limits
and a conditional notice in live session details. No status is added to the global
header, historical session evidence, quota errors, or exported session reports.

Focused checks:

```powershell
node --test tests/provider-service-status.test.mjs tests/provider-status-observation.test.mjs
npx vitest run tests/ui/provider-status-api.test.ts tests/ui/provider-status.test.tsx
```
