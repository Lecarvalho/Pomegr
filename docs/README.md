# Pomegr documentation

Use this index to find help with Pomegr or the contracts and workflows for changing
it. Start with the [product overview](../README.md) for downloads and running from
source.

## Use and understand Pomegr

| I want to… | Read |
| --- | --- |
| Understand what the dashboard observes | [User guide](user-guide/README.md) |
| Read context, input, output, and cache numbers | [Understanding tokens and cache](user-guide/tokens-and-cache.md) |
| Configure the app, use phone access, or troubleshoot discovery | [Configuration and troubleshooting](CONFIGURATION.md) |
| Set up reporting for a repository | [Pomegr plugins](PLUGINS.md) |
| Query already-observed state through MCP | [MCP observation queries](MCP_QUERIES.md) |

Configuration, plugins, and MCP queries currently combine user guidance with
maintainer detail. Their user-facing sections will move into focused public pages
during the documentation migration.

## Maintain and contribute

The [maintainer index](internal/README.md) maps architecture, development,
operations, and decisions to their current owners. It also identifies which
documents govern behavior and which record proposals or historical evidence.

Read the [contribution guide](../CONTRIBUTING.md) before proposing changes. Coding
agents follow [AGENTS.md](../AGENTS.md) and the
[agent workflow](AGENT-WORKFLOW.md) for change routing and verification.

## Find pages during the migration

Existing pages keep their current paths and authority until their individual
migration task completes. Follow the working links above; these planned homes are
not yet published pages:

| Current location | Planned home |
| --- | --- |
| `docs/user-guide/` and user guidance in mixed-audience pages | `docs/public/`, grouped into `get-started/`, `using-pomegr/`, `concepts/`, and `help/` |
| Technical references in `docs/*.md` and website operations | `docs/internal/architecture/`, `development/`, `operations/`, and `decisions/` |
| Existing plans and temporary design artifacts | Active work in `docs/internal/plans/`; completed artifacts retired after their findings are accounted for |

Public guides are intended for website publication. Internal documentation serves
maintainers and is excluded from that publication; “internal” does not mean
confidential in Git. The planned `docs/site.json` manifest will explicitly select
public pages. This index does not publish content.

The [documentation migration checklist](internal/plans/documentation-migration.md)
tracks individual tasks. The maintainer index lists current technical paths and
their proposed replacements.
