# Threadlight

Threadlight is a lightweight, local-first dashboard for observing live coding-agent sessions. It illuminates agents, context usage, model settings, tool activity, Git changes, usage limits, and deterministic efficiency signals in real time.

The current adapter supports Claude Code. Codex is the next planned integration; the product and normalized data model remain provider-neutral.

## What it shows

- Session title, project, elapsed wall time, and last activity
- Primary-agent and all-agent current context usage
- Parent-child agent hierarchy with descriptions, model IDs, effort levels, status, and tool counts
- Current Git branch and every uncommitted path
- Plan limits for the five-hour session, all models, and Fable
- Recent tool activity without displaying prompts or responses
- Deterministic loop and agent-overlap warnings

Threadlight does not currently call an AI model. Its analysis and recommendations are rule-based and reproducible.

## Run locally

Requirements:

- Windows with Node.js 22.13 or newer
- Claude Code with local session persistence enabled
- Git on `PATH`

```powershell
npm ci
npm run dev
```

Open `http://<YOUR-LAN-IP>:3003` from another device on the same network. For
example, if this computer's IPv4 address is `192.168.1.25`, open
`http://192.168.1.25:3003` on your phone.

The development command starts:

- Web dashboard on `0.0.0.0:3003`
- Private monitor API on `127.0.0.1:4317`

The web server proxies `/api/state` to the loopback-only monitor, so private credentials and raw transcripts are never sent to the browser.

## Configuration

The monitor automatically selects the most recently modified primary session under `%USERPROFILE%\.claude\projects`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `CLAUDE_PROJECTS_DIR` | Override the current provider's project/session root | `%USERPROFILE%\.claude\projects` |
| `CLAUDE_SESSION_FILE` | Pin one primary JSONL session | Latest primary session |
| `SESSION_PULSE_PORT` | Change the private monitor API port | `4317` |

Example:

```powershell
$env:CLAUDE_SESSION_FILE='C:\path\to\session.jsonl'
npm run dev
```

## Metrics

The prominent context numbers use the same latest-snapshot concept shown by the provider UI:

- **Agent context:** latest non-zero usage snapshot for that agent
- **Primary context:** current context of the primary agent
- **All-agent context:** sum of the latest context snapshot for every visible agent

Historical cache reads are not shown as the headline metric. See [docs/METRICS.md](docs/METRICS.md) for formulas and thresholds.

## Privacy and security

- Raw prompt and response text is not returned by the monitor API.
- Agent launch text is used only to derive a concise fallback label.
- Session transcripts and Git state are read-only.
- Git commands use argument arrays rather than shell interpolation.
- OAuth credentials remain in the monitor process.
- Credentials are sent only to the provider's own usage endpoint and never enter browser state.
- Usage polling is cached for 60 seconds.

Anyone who can reach port 3003 on the local network can view dashboard metadata. The development server accepts any hostname so it can be reached by IP; bind the web server to localhost if that is inappropriate for your network. Your firewall may prompt you to allow Node.js on private networks.

## Development

```powershell
npm run dev       # web dashboard and monitor
npm run dev:web   # web dashboard only
npm run monitor   # monitor API only
npm run build     # production build
npm test          # build and rendered-output checks
npm run lint      # static linting
```

Important source files:

- `monitor/server.mjs` — discovery, parsing, metrics, Git, and plan usage
- `app/Dashboard.tsx` — live React dashboard
- `app/api/state/route.ts` — same-origin proxy to the private monitor
- `scripts/dev.mjs` — local process orchestration

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and provider-extension plan.

## Current limitations

- The monitor currently supports Claude Code session files only.
- Session duration is elapsed wall time and includes idle periods.
- Agent state is inferred from transcript modification time.
- Efficiency warnings are heuristics, not authoritative judgments.
- Transcript parsing reads a bounded tail of each file.

## License

No license has been selected. The source repository is publicly viewable, but
that does not grant permission to copy, modify, or redistribute the code.
