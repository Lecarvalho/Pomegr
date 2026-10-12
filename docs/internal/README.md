# Maintainer documentation

This index gives the owner page for each subject. It holds routes only; each owner page
holds its contract. For user guides, see the [documentation index](../README.md).

Internal pages are not published on the documentation website. They stay readable in
the repository and must not contain secrets or private session data.

| Folder | Holds |
| --- | --- |
| `architecture/` | Current runtime behavior, boundaries, and invariants |
| `architecture/privacy/` | What Pomegr may keep, send, or show, for each subject |
| `development/` | Contributor workflow, configuration, tooling, and verification |
| `operations/` | Release, acceptance, diagnostics, and website runbooks |
| `decisions/` | Accepted rationale. A decision never overrides a contract. |
| `plans/` | Temporary checklists and proposals. A plan never overrides a contract. |

## Choose the authority

When two pages differ, the owner in this section is correct. Repair the other page.

### Repository rules

| Subject | Owner |
| --- | --- |
| Rules for each change, and the list of privacy pages | [AGENTS.md](../../AGENTS.md). [CLAUDE.md](../../CLAUDE.md) only points to it. |
| Behavior owners, forbidden dependency directions, verification commands, CI | [Agent workflow](development/agent-workflow.md) |
| Product purpose, positioning, and principles | [PRODUCT.md](../../PRODUCT.md) |
| Contribution terms | [CONTRIBUTING.md](../../CONTRIBUTING.md) |
| Legal terms | [LICENSE](../../LICENSE), [NOTICE](../../NOTICE), [source notice](../../SOURCE.md), [trademark policy](../../TRADEMARKS.md) |

### Architecture

| Subject | Owner |
| --- | --- |
| Runtime map, data flow, provider boundary | [Architecture](architecture/overview.md) |
| Observation phases, caches, checkpoints, serving, readiness, polling | [Observation cache](architecture/observation-cache.md) |
| Provider adapter conformance | [`server/providers/provider-contract.mjs`](../../server/providers/provider-contract.mjs) |
| Provider and Pomegr limits, capability matrix | [Limitations](architecture/limitations.md) |
| Metric rules, heuristics, and evidence gates | [Metrics](architecture/metrics.md) |
| Stable evidence codes | [Signal dictionary](architecture/signal-dictionary.md) |
| Session status rules and known gaps | [Global session statuses](architecture/session-status.md) |
| Claude Code lifecycle sources and the Remote Control status read | [Claude Code session status](architecture/claude-session-status.md) |
| Public provider status sources | [Provider service status](architecture/provider-status.md) |
| Cache timestamps and lifetime inference | [Cache timing](architecture/cache-timing.md) |
| Tool identities observed for each harness version | [Provider tool inventory](architecture/tool-inventory.md) |
| Task board, queue, start gates, dispatch, agent task tools, task privacy | [Tasks](architecture/tasks.md) |
| The chat with Aril: its provider run, proposals and their approval, saved conversations, and the paired-device route | [Agent chat](architecture/agent-chat.md) |
| MCP query session resolution, evidence semantics, transport | [MCP observation queries](architecture/mcp-queries.md) |
| The list of all Pomegr MCP tools | [MCP tools](../public/using-pomegr/mcp-tools.md) |

### Privacy

| Subject | Owner |
| --- | --- |
| Session, agent, activity, cache, file, and history evidence; checkpoints | [Session evidence privacy](architecture/privacy/session-evidence.md) |
| Notification feed, stores, and settings | [Notification privacy](architecture/privacy/notifications.md) |
| Credentials, account usage, provider processes, plugins | [Provider and account privacy](architecture/privacy/providers-and-accounts.md) |
| Desktop settings, native actions, diagnostics, context inventories | [Desktop settings and diagnostics privacy](architecture/privacy/desktop-and-diagnostics.md) |
| Task board, dispatch, GitHub issues, task images, paired devices | [Tasks: Privacy](architecture/tasks.md#privacy) |
| Agent chat conversations, and what a chat run sends to a provider | [Agent chat: Privacy](architecture/agent-chat.md#privacy) |

### Interface

| Subject | Owner |
| --- | --- |
| Tokens, button roles, chips, fields, panels, tables, shell, navigation | [DESIGN.md](../../DESIGN.md) |
| Settings sections and the storage usage meter | [Settings design](design/settings.md) |
| Home and the What's new card | [Home design](design/home.md) |
| Sessions directory, session header, Overview, Events, Signals | [Sessions design](design/sessions.md) |
| Agents panel, inspector, grid, tree, the Agents route, role tint | [Agents design](design/agents.md) |
| Activities feed and the Requests chart | [Activities design](design/activities.md) |
| Repositories index and detail, file tree, file history | [Repositories design](design/repositories.md) |
| Tasks page, board, cards, queue, session task surfaces | [Task board design](design/task-board.md) |
| Task modal, task fields, Promote issues page | [Task modal design](design/task-modal.md) |
| Aril chat launcher, panel, messages, proposal card, composer, conversations | [Agent chat design](design/agent-chat.md) |
| Visual reference | The `/design-system` page and its [samples](../../app/components/design-system/). No HTML preview or mockup is an authority. |
| Command table integration | [Command table](development/command-table.md) |

### Development

| Subject | Owner |
| --- | --- |
| Environment variables, provider setup, troubleshooting contracts | [Configuration and troubleshooting](development/configuration.md) |
| Plugin sources, generation, versioning, and release | [Pomegr plugins](development/plugins.md) |
| Writing rules, templates, visuals, artifact lifecycle | [Style guide](../STYLE_GUIDE.md) |
| Page placement, migration, publication, documentation checks | [Maintenance workflow](development/documentation.md) |
| Format of [docs/site.json](../site.json), routes, and public links | [Publication manifest contract](development/documentation-manifest.md) |

### Operations

| Subject | Owner |
| --- | --- |
| Development JSONL diagnostics and passive analysis | [Pipeline operations](operations/pipeline-diagnostics.md) |
| Desktop packaging, signing, publication, rollback | [Desktop releases](operations/desktop-releases.md) |
| Beta-candidate acceptance and desktop milestone IDs | [Desktop beta acceptance](operations/desktop-beta-acceptance.md) |
| Clean-VM checks | [Desktop clean-VM checklist](operations/desktop-clean-vm.md) |
| Landing site and documentation publication | [Website operations](operations/website.md); [package entrypoint](../../landing/README.md) |

### Decisions

| Decision | Page |
| --- | --- |
| Licensing | [License history](decisions/license-history.md) |
| Open-source core and non-evaluator positioning | [Product positioning](decisions/product-positioning.md) |
| Ranking and labels of Codex liveness evidence | [Codex Windows presence](decisions/codex-windows-presence.md) |

## Plans and temporary work

Each plan states its own status, owner, next decision, and deletion rule at its top.
This table gives only the subject. Nothing in a plan is a shipped feature or a
commitment. Delete a plan in the change that completes, cancels, or replaces it. There
is no archive directory.

| Plan | Subject |
| --- | --- |
| [Provider observers and notifications](plans/provider-notifications.md) | One notification subsystem in five parts |
| [Session Activity panel](plans/session-activity-panel.md) | The Activity panel; keep until the user approves deletion |
| [Information architecture redesign](plans/ia-redesign.md) | Navigation, session tabs, file history, and transport, with prototype artboards |
| [Overview sparse state and link rule](plans/overview-sparse-and-links.md) | Session Overview and Signals tab changes |
| [Session allowance](plans/session-allowance.md) | Account-window movement for each session |
| [Product expansion](plans/product-expansion.md) | Directions from the owner's review of 2026-09-30 |
| [Durable session store](plans/durable-session-store.md) | Normalized session evidence in the monitor SQLite store |
| [Session receipt](plans/session-receipt.md) | A picture of one session that a user can copy or save |
| [Guidance impact](plans/guidance-impact.md) | Sessions tagged with the guidance revision they ran under |
| [Commercial strategy](plans/commercial-strategy.md) | Editions, pricing, and buyer hypotheses |
| [Remote platform](plans/remote-platform-and-orgs.md) | Remote and organization features; nothing is built |
| [Mobile pairing](plans/mobile-pairing-cloudflare.md) | Relay pairing; the only shipped phone feature is same-network [phone access](../public/using-pomegr/phone-access.md) |
| [Design system gaps](plans/design-system-gaps.md) | Accepted patterns that have no `/design-system` sample |
