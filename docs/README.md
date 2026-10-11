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
| See each tool that the plugin gives a coding agent | [MCP tools](public/using-pomegr/mcp-tools.md) |
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

## Maintain and contribute

- The [maintainer index](internal/README.md) gives the owner page for each contract,
  workflow, runbook, decision, and plan.
- The [contribution guide](../CONTRIBUTING.md) tells you how to propose a change.
- Coding agents follow [AGENTS.md](../AGENTS.md).
- For a documentation change, follow the [style guide](STYLE_GUIDE.md) and the
  [maintenance workflow](internal/development/documentation.md).

## Publication

Pages in `docs/public/` are for the website. Pages in `docs/internal/` are for
maintainers and are not published; “internal” does not mean confidential in Git. The
[publication manifest contract](internal/development/documentation-manifest.md) owns
page selection, routes, and links. This index does not publish content.
