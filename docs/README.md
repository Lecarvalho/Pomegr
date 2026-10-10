# Pomegr documentation

Use this index to find help with Pomegr or the contracts and workflows for changing
it. Start with the [product overview](../README.md) for downloads and running from
source.

## Use and understand Pomegr

| I want to… | Read |
| --- | --- |
| Understand what the dashboard observes | [Introduction to Pomegr](public/get-started/introduction.md) |
| Download and launch the Windows app | [Install Pomegr](public/get-started/install.md) |
| Find a session and understand the first results | [Follow your first session](public/get-started/first-session.md) |
| Read session states and inspect a session's agents | [Sessions and agents](public/using-pomegr/sessions-and-agents.md) |
| Browse repositories and the files their sessions changed | [Repositories](public/using-pomegr/repositories.md) |
| Plan a repository's work on a task board and have the desktop app start sessions for it | [Tasks](public/using-pomegr/tasks.md) |
| Connect GitHub, promote an open issue into a task, or create an issue from a task | [GitHub issues](public/using-pomegr/github-issues.md) |
| Install the reporting plugin and set up a repository's reporting policy | [Reporting plugins](public/using-pomegr/reporting-plugins.md) |
| Share Pomegr read-only with a paired phone on your private network | [Phone access](public/using-pomegr/phone-access.md) |
| Let a coding agent query provider health, usage limits, and context | [MCP queries](public/using-pomegr/mcp-queries.md) |
| Choose appearance, provider folders, storage, and display preferences | [Settings](public/using-pomegr/settings.md) |
| Read context, input, output, and cache numbers | [Context and tokens](public/concepts/context-and-tokens.md) |
| Understand cache reuse, possible refills, and cache lifetimes | [Cache reuse](public/concepts/cache-reuse.md) |
| Read the account usage windows and their freshness | [Usage limits](public/concepts/usage-limits.md) |
| Tell recorded values, agent reports, estimates, and signals apart | [Signals and estimates](public/concepts/signals-and-estimates.md) |
| Compare cached and uncached token prices, and API prices with subscriptions | [Token pricing](public/concepts/token-pricing.md) |
| Recover when the session list is empty or a session is missing | [Missing sessions](public/help/missing-sessions.md) |
| Read a dash, an "unavailable" message, or a provider status without assuming a cause | [Unavailable data](public/help/unavailable-data.md) |
| Recover from Monitor offline, a paused dashboard, or an app that does not open | [Connection problems](public/help/connection-problems.md) |
| Show Claude Code usage when account checks fail, and see what Pomegr keeps | [Claude Code local usage](public/help/claude-local-usage.md) |
| Understand provider and Pomegr limitations | [Limitations](internal/architecture/limitations.md) |
| Look up environment variables, provider setup, and the technical contracts behind troubleshooting | [Configuration and troubleshooting](internal/development/configuration.md) |

Configuration and troubleshooting keeps the environment variables, provider setup,
and technical contracts behind the guides above. [Pomegr plugins](internal/development/plugins.md) and
[MCP observation queries](internal/architecture/mcp-queries.md) keep the contracts behind their guides.

## Maintain and contribute

The [maintainer index](internal/README.md) maps architecture, development,
operations, and decisions to their current owners. It also identifies which
documents govern behavior and which record proposals or historical evidence.
The [Limitations reference](internal/architecture/limitations.md) owns the
provider-related and Pomegr-specific inventory and generated capability matrix.
The [architecture overview](internal/architecture/overview.md),
[observation cache](internal/architecture/observation-cache.md),
[metrics](internal/architecture/metrics.md),
[session status](internal/architecture/session-status.md),
[Claude session status](internal/architecture/claude-session-status.md),
[provider status](internal/architecture/provider-status.md),
[cache timing](internal/architecture/cache-timing.md), and
[signal dictionary](internal/architecture/signal-dictionary.md) contracts live beside it.
The [configuration](internal/development/configuration.md), [plugins](internal/development/plugins.md),
and [command table](internal/development/command-table.md) references, and the
[pipeline diagnostics](internal/operations/pipeline-diagnostics.md),
[desktop releases](internal/operations/desktop-releases.md),
[desktop beta acceptance](internal/operations/desktop-beta-acceptance.md),
[desktop clean-VM](internal/operations/desktop-clean-vm.md), and
[website operations](internal/operations/website.md) runbooks, and the
[license history](internal/decisions/license-history.md),
[product positioning](internal/decisions/product-positioning.md), and
[Codex Windows presence](internal/decisions/codex-windows-presence.md) decisions, serve
maintainers changing those areas. Unshipped proposals live in
[`docs/internal/plans/`](internal/plans/): the
[commercial strategy](internal/plans/commercial-strategy.md),
[remote platform](internal/plans/remote-platform-and-orgs.md), and
[mobile pairing](internal/plans/mobile-pairing-cloudflare.md) hypotheses are not
shipped features.

Read the [contribution guide](../CONTRIBUTING.md) before proposing changes. Coding
agents follow [AGENTS.md](../AGENTS.md) and the
[agent workflow](internal/development/agent-workflow.md) for change routing and verification.

For documentation changes, follow the shared [style guide](STYLE_GUIDE.md) for
writing, page templates, visuals, and artifact lifecycle, and the
[maintenance workflow](internal/development/documentation.md) for placement,
migration, publication, checks, and closure.

## Publication

Public guides live in `docs/public/`, grouped into `get-started/`, `using-pomegr/`,
`concepts/`, and `help/`; the table at the top of this page links each one.

Public guides are intended for website publication. Internal documentation serves
maintainers and is excluded from that publication; “internal” does not mean
confidential in Git. The [publication manifest](site.json) defines ordered public
navigation groups and selects the ready pages. Its
[contract](internal/development/documentation-manifest.md) defines page membership,
routes, and local links/images. The build-time loader, the `/docs` site, and
`npm run check:docs` are implemented; publishing is a manual website deployment (see
[website operations](internal/operations/website.md#6-publish-documentation)). This
index does not publish content.

The maintainer index lists the current technical authorities.
