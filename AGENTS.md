# AGENTS.md

This file holds the rules that apply to every change. Each other subject has one owner
page. Read the owner page before you change its subject, and link to it instead of
copying it here.

## Product

- The product name is **Pomegr**. Use `pomegr` for package, repository, and directory
  identifiers.
- Keep the name provider-neutral. Provider names belong only in adapter-specific
  configuration and documentation.
- Pomegr is a local-first observer for coding-agent sessions. Observation is read-only.
- In the desktop app only, Pomegr is also an opt-in dispatcher that starts sessions for
  repository tasks. Tasks and dispatch are a separate control plane. Observation does not
  depend on it.
- In the desktop app and on a paired device, Pomegr also has an agent chat. The owner
  talks to Aril, an agent that reads the task board and Pomegr's observations and
  proposes board changes and, when the owner asks, the start of one task's session. Aril
  changes and starts nothing: the owner applies a proposal.
- Describe a capability as available only when its contract says that it is built.
- Never describe a heuristic as an AI judgment or an authoritative measurement.

[PRODUCT.md](PRODUCT.md) owns product purpose, positioning, and principles.

## Collaboration

- The user gives standing permission to use subagents for repository work. Do not ask
  again.
- Give subagents and workflow workers the cheapest capable model, such as Sonnet or Haiku
  (Claude), Terra or Luna (Codex). Use a larger model only for a stage that needs stronger
  reasoning. Never leave a probe agent on the session's default model by accident.
- You may start a real provider session (`codex exec`, `claude`, a Codex app-server) only
  when a fix needs live evidence. Let the run finish; a killed run leaves an unfinished
  turn in the user's catalog. Delete the probe when the fix is done. Never keep one as a
  script, a test, or an automated step.
- Durable tests use synthetic transcripts or an isolated temporary provider home, as in
  `tests/server/providers/codex/native-lock-acceptance.test.mjs`.

## Find the owner

| Subject | Owner |
| --- | --- |
| Behavior owner, focused test command, forbidden dependency direction | [Agent workflow](docs/internal/development/agent-workflow.md) |
| Which page is the authority for a subject | [Maintainer index](docs/internal/README.md) |
| User guides | [Documentation index](docs/README.md) |
| Runtime structure and provider boundary | [Architecture](docs/internal/architecture/overview.md) |
| Observation phases, caches, checkpoints, serving, readiness, polling | [Observation cache](docs/internal/architecture/observation-cache.md) |
| Metric definitions and heuristics | [Metrics](docs/internal/architecture/metrics.md) |
| Task board, queue, dispatch, agent task tools, and their privacy rules | [Tasks](docs/internal/architecture/tasks.md) |
| Agent chat: its provider run, proposals, saved conversations, and privacy rules | [Agent chat](docs/internal/architecture/agent-chat.md) |
| Provider adapter conformance | `server/providers/provider-contract.mjs` |
| Controls, tokens, and styles | [DESIGN.md](DESIGN.md) |
| How one surface looks and how the user operates it | Its page in `docs/internal/design/`, listed in [DESIGN.md](DESIGN.md#find-the-page) |
| Pomegr MCP tools | [MCP tools](docs/public/using-pomegr/mcp-tools.md) |
| Writing and placing documentation | [Style guide](docs/STYLE_GUIDE.md) and [maintenance workflow](docs/internal/development/documentation.md) |

Plans in `docs/internal/plans/` describe work, not runtime authority. Delete a plan and
its unneeded attachments in the change that completes, cancels, or replaces it. Follow
the maintenance workflow, and do not make an archive copy.

## Architecture rules

- The monitor (`server/`) owns discovery, parsing, normalization, Git inspection,
  usage-limit retrieval, and metrics.
- The web application (`app/`) renders normalized state. It must not read credentials,
  raw session files, or provider transcript schemas.
- Routes in `app/api/` are same-origin proxies to the loopback monitor.
- A production GET serves only committed response caches. It may queue asynchronous
  hydration. It must never acquire, parse, or normalize provider data.
- A source read bound controls acquisition cost only. It must never control how long
  normalized evidence lives. Keep the last known-good revision until a complete
  replacement validates and commits atomically.
- Each provider adapter lives in `server/providers/<provider>/` and builds on
  `server/providers/kernel/` and `server/normalize/`. Adapters never import each other.
- Every adapter produces the same normalized session, agent, activity, token, repository,
  and insight shapes. Provider failures degrade independently.

## Security and privacy

These rules always apply:

- Never return raw prompts, responses, tool-result content, OAuth tokens, or
  credential-file contents to the browser. The one exception is the agent chat's own
  conversation, which its owner page lists. It is never a session's.
- A value may cross a boundary only when the owner page lists it. A value that no page
  lists is private.
- Keep the monitor bound to loopback.
- Keep observation read-only. Task dispatch is the only control surface. It starts new
  sessions and never stops, attaches to, answers, or approves work in a running session.
  Each other control action needs an explicit confirmation boundary.
- The agent chat starts only its own read-only provider run, which Pomegr may stop. It
  changes the board only through the fixed task actions, after the owner applies a
  proposal. It starts a task's session only through the manual start and its
  confirmation, after the owner applies a start proposal in the desktop app.
- Start processes with `execFile` or `spawn` and an argument array. Never put
  session-derived text into a command line or a path.
- Never commit `.env`, transcripts, credentials, build output, or Wrangler state.

Each subject has one page that lists exactly what Pomegr may keep, send, or show. Read it
before you change that subject. A change that widens exposure changes that page in the
same pull request.

| Subject | Privacy invariants |
| --- | --- |
| Session, agent, activity, cache, file, and history evidence; checkpoints | [Session evidence](docs/internal/architecture/privacy/session-evidence.md) |
| Notifications and their stores | [Notifications](docs/internal/architecture/privacy/notifications.md) |
| Credentials, account usage, provider processes, plugins | [Providers and accounts](docs/internal/architecture/privacy/providers-and-accounts.md) |
| Desktop settings, native actions, diagnostics, context inventories | [Desktop and diagnostics](docs/internal/architecture/privacy/desktop-and-diagnostics.md) |
| Task board, dispatch, GitHub issues, task images, paired devices | [Tasks: Privacy](docs/internal/architecture/tasks.md#privacy) |
| Agent chat conversations, and what a chat run sends to a provider | [Agent chat: Privacy](docs/internal/architecture/agent-chat.md#privacy) |

## User interface

- Read [DESIGN.md](DESIGN.md) before you add or style a control. It owns the button
  roles, the chip contract, and the tokens.
- Put a rule for one surface in the page of that surface in `docs/internal/design/`, not
  in `DESIGN.md`. Write one fact for each bullet or table row, on one line.
- Use no literal color, off-scale radius, or off-ramp font size in `app/styles/`. For an
  intended exception, add it to `DESIGN.md` first. Then persist it with
  `.agents/skills/impeccable/scripts/hook-admin.mjs ignore-value`.
- Add a sample to `/design-system` for each new shared control. Change `DESIGN.md`
  or the surface page, `tests/ui/pomegr-design-contract.test.tsx`, and the samples in
  `app/components/design-system/` together.

## Commands

```powershell
npm ci
npm run dev
npm run build
npm test
npm run lint
```

The dashboard binds to `0.0.0.0:3003`. The private monitor listens on `127.0.0.1:4317`.
The [agent workflow](docs/internal/development/agent-workflow.md#focused-verification)
owns the focused and full verification commands.

### Git and GitHub from Codex

- Run Git and GitHub CLI operations in the user's host environment, outside the managed
  Codex sandbox. The user's keyring, credential helpers, SSH configuration, and `gh`
  session are available only there.
- Never diagnose GitHub authentication from a sandboxed `gh` result. Try again through
  the host environment first.

### Codex on Windows

- In a managed Codex filesystem sandbox, run `npm run build` and `npm run verify` with
  escalated permissions. They overwrite the generated plugin bundles in
  `plugins/claude-code` and `plugins/pomegr`.
- A sandboxed build can report `Access is denied` or `EPERM` for a bundle when no process
  holds the file. Do not call that a process lock without independent handle evidence.
- `npm test` does not build, so it can stay sandboxed.
- Do not run `npm run build` and `npm run verify` at the same time.

## Change checklist

1. Keep the normalized API contract, or change the frontend and the documentation in the
   same change.
2. Make sure that `/api/state` serializes no prompt, response, credential, or task-board
   value.
3. Run `npm run build` for an implementation change.
4. Run `npm test` for a rendering, metric, parser, or structure change.
5. Record a heuristic change in [Metrics](docs/internal/architecture/metrics.md).
6. For an observation, cache, readiness, or polling change, update the
   [observation cache](docs/internal/architecture/observation-cache.md) contract. Verify
   cache-only GETs, last known-good retention, revision handling, and checkpoint and
   browser privacy.
