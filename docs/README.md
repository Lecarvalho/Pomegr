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
| Install the reporting plugin and set up a repository's reporting policy | [Reporting plugins](public/using-pomegr/reporting-plugins.md) |
| Share Pomegr read-only with a paired phone on your private network | [Phone access](public/using-pomegr/phone-access.md) |
| Let a coding agent query provider health, usage limits, and context | [MCP queries](public/using-pomegr/mcp-queries.md) |
| Choose appearance, provider folders, storage, and display preferences | [Settings](public/using-pomegr/settings.md) |
| Read context, input, output, and cache numbers | [Context and tokens](public/concepts/context-and-tokens.md) |
| Understand cache reuse, possible refills, and cache lifetimes | [Cache reuse](public/concepts/cache-reuse.md) |
| Read the account usage windows and their freshness | [Usage limits](public/concepts/usage-limits.md) |
| Tell recorded values, agent reports, estimates, and signals apart | [Signals and estimates](public/concepts/signals-and-estimates.md) |
| Compare cached and uncached token prices, and API prices with subscriptions | [Token pricing](public/concepts/token-pricing.md) |
| Understand provider and Pomegr limitations | [Limitations](internal/architecture/limitations.md) |
| Configure provider sources or troubleshoot discovery | [Configuration and troubleshooting](CONFIGURATION.md) |

Configuration and troubleshooting still combines user guidance with maintainer
detail; its remaining user-facing sections will move into focused public pages
during the documentation migration. [Pomegr plugins](PLUGINS.md) and
[MCP observation queries](MCP_QUERIES.md) keep the contracts behind their guides.

## Maintain and contribute

The [maintainer index](internal/README.md) maps architecture, development,
operations, and decisions to their current owners. It also identifies which
documents govern behavior and which record proposals or historical evidence.
The [Limitations reference](internal/architecture/limitations.md) owns the
provider-related and Pomegr-specific inventory and generated capability matrix.

Read the [contribution guide](../CONTRIBUTING.md) before proposing changes. Coding
agents follow [AGENTS.md](../AGENTS.md) and the
[agent workflow](AGENT-WORKFLOW.md) for change routing and verification.

For documentation changes, follow the shared [style guide](STYLE_GUIDE.md) for
writing, page templates, visuals, and artifact lifecycle, and the
[maintenance workflow](internal/development/documentation.md) for placement,
migration, publication, checks, and closure.

## Find pages during the migration

The [introduction](public/get-started/introduction.md),
[installation guide](public/get-started/install.md),
[first-session guide](public/get-started/first-session.md), the
[sessions and agents](public/using-pomegr/sessions-and-agents.md),
[repositories](public/using-pomegr/repositories.md),
[reporting plugins](public/using-pomegr/reporting-plugins.md),
[phone access](public/using-pomegr/phone-access.md),
[MCP queries](public/using-pomegr/mcp-queries.md), and
[settings](public/using-pomegr/settings.md) guides, and the
[context and tokens](public/concepts/context-and-tokens.md),
[cache reuse](public/concepts/cache-reuse.md),
[usage limits](public/concepts/usage-limits.md),
[signals and estimates](public/concepts/signals-and-estimates.md), and
[token pricing](public/concepts/token-pricing.md) concept pages are migrated
public pages.
Remaining sources keep their current paths and authority until their
individual migration tasks complete. Follow the working links above; this table
maps the remaining work:

| Current location | Planned home |
| --- | --- |
| User guidance in mixed-audience pages | `docs/public/`, grouped into `get-started/`, `using-pomegr/`, `concepts/`, and `help/` |
| Technical references in `docs/*.md` and website operations | `docs/internal/architecture/`, `development/`, `operations/`, and `decisions/` |
| Existing plans and temporary design artifacts | Active work in `docs/internal/plans/`; completed artifacts retired after their findings are accounted for |

Public guides are intended for website publication. Internal documentation serves
maintainers and is excluded from that publication; “internal” does not mean
confidential in Git. The [publication manifest](site.json) defines ordered public
navigation groups and selects the ready pages. Its
[contract](internal/development/documentation-manifest.md) defines page membership,
routes, and local links/images; website publication tooling is still pending.
This index does not publish content.

The [documentation migration checklist](internal/plans/documentation-migration.md)
tracks individual tasks. The maintainer index lists current technical paths and
their proposed replacements.
