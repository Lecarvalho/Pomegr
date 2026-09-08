# Maintainer documentation

This index routes maintainers and coding agents to current contracts, development
guidance, and operating procedures. It is a navigation and authority map; the
linked owners retain their contracts. For user guidance, see the
[documentation index](../README.md).

Internal pages are excluded from documentation website publication. They remain
readable in the repository and must not contain secrets or private session data.

## Choose the authority

| Subject | Owner and authority |
| --- | --- |
| Repository-wide boundaries and change routing | [AGENTS.md](../../AGENTS.md) governs repository changes; [agent workflow](../AGENT-WORKFLOW.md) locates behavior owners and checks. [CLAUDE.md](../../CLAUDE.md) is a thin provider entrypoint. |
| Product purpose and contribution | [PRODUCT.md](../../PRODUCT.md) records product purpose and constraints; [CONTRIBUTING.md](../../CONTRIBUTING.md) governs contribution expectations. Consult the precise runtime contracts for implemented behavior. |
| Runtime structure | [Architecture](../ARCHITECTURE.md) maps the system; the focused contracts below define their respective behavior. |
| Observation phases, cache ownership, serving, readiness, and polling | [Observation cache](../OBSERVATION_CACHE.md) is the canonical operational contract. It and AGENTS.md take precedence over conflicting plans. |
| Provider conformance | [Executable provider contract](../../monitor/providers/provider-contract.mjs) defines catalog, manifest, readiness, evidence, and conformance requirements. Transcript schemas stay in adapters. |
| Metrics and evidence | [Metrics](../METRICS.md) owns deterministic rules; [signal dictionary](../SIGNAL_DICTIONARY.md) defines stable evidence codes and limits. |
| Interface design | [DESIGN.md](../../DESIGN.md) is the written contract. The existing `/design-system` page is the authoritative visual reference, backed by its [examples](../../app/components/design-system/DesignSystemView.tsx) and shared tokens/components. HTML mockups are temporary explorations. |
| Legal terms and rationale | Root [LICENSE](../../LICENSE), [NOTICE](../../NOTICE), [source notice](../../SOURCE.md), and [trademark policy](../../TRADEMARKS.md) retain their legal/packaging homes; [license history](../LICENSE_HISTORY.md) explains the transition. |

Plans describe work or historical reasoning, not runtime authority. The session
status comparison records known gaps alongside implemented rules, and the clean-VM
record concerns a historical candidate; neither implies that pending work passed.

## Architecture and evidence

All links below point to current files. Destinations in code spans are planned
paths relative to `docs/internal/`, not additional authoritative copies.

| Current reference | Scope | Planned destination |
| --- | --- | --- |
| [Architecture](../ARCHITECTURE.md) | Runtime map and data flow | `architecture/overview.md` |
| [Observation cache](../OBSERVATION_CACHE.md) | Operational boundaries and committed evidence | `architecture/observation-cache.md` |
| [Metrics](../METRICS.md) | Deterministic rules and evidence limits | `architecture/metrics.md` |
| [Claude Code session status](../CLAUDE_SESSION_STATUS.md) | Provider lifecycle sources and privacy | `architecture/claude-session-status.md` |
| [Global session statuses](../SESSION_STATUS.md) | Current comparison and known gaps | `architecture/session-status.md` |
| [Provider service status](../PROVIDER_STATUS.md) | Public status sources and interpretation | `architecture/provider-status.md` |
| [Cache timing](../CACHE_TIMING.md) | Cache timestamps, lifetime, and inference limits | `architecture/cache-timing.md` |
| [Signal dictionary](../SIGNAL_DICTIONARY.md) | Stable evidence identifiers | `architecture/signal-dictionary.md` |
| [MCP observation queries](../MCP_QUERIES.md) | Query usage, transport, and privacy | `architecture/mcp-queries.md`, after public guidance is extracted |

## Development

Start changes with the [agent workflow](../AGENT-WORKFLOW.md) to find the behavior
owner, forbidden dependency direction, and focused verification command. Follow
its canonical verification requirements before handing off a change.

| Current reference | Scope | Planned destination |
| --- | --- | --- |
| [Agent workflow](../AGENT-WORKFLOW.md) | Change routing and verification | `development/agent-workflow.md` |
| [Configuration and troubleshooting](../CONFIGURATION.md) | Configuration and generated provider capability reference | `development/configuration.md`, after public guidance is extracted |
| [Pomegr plugins](../PLUGINS.md) | Canonical sources, generation, versioning, and release | `development/plugins.md`, after public guidance is extracted |
| [Command table](../COMMAND_TABLE.md) | Component integration; visual authority remains the design system | `development/command-table.md` |

The shared [style guide](../STYLE_GUIDE.md) owns writing rules, audience profiles,
templates, supported formatting, visual ownership, and artifact lifecycle. The
documentation maintenance workflow (`docs/internal/development/documentation.md`)
is pending DOC-03; the migration checklist still records the placement and
execution sequence.

## Operations and decisions

| Current reference | Scope | Planned destination |
| --- | --- | --- |
| [Pipeline operations](../PIPELINE_OPERATIONS.md) | Passive diagnostics and separately identified future milestones | `operations/pipeline-diagnostics.md` |
| [Desktop releases](../DESKTOP_RELEASES.md) | Packaging, publication, and rollback | `operations/desktop-releases.md` |
| [Desktop beta acceptance](../DESKTOP_BETA_ACCEPTANCE.md) | Candidate acceptance procedure and evidence gates | `operations/desktop-beta-acceptance.md` |
| [Desktop clean-VM checklist](../DESKTOP_CLEAN_VM_CHECKLIST.md) | Historical 0.2.4 acceptance record, still pending | `operations/desktop-clean-vm.md`, after separating procedure from candidate evidence |
| [Website operations](../../landing/OPERATIONS.md) | Landing development and manual deployment; [package entrypoint](../../landing/README.md) | `operations/website.md` |
| [License history](../LICENSE_HISTORY.md) | Enduring licensing rationale | `decisions/license-history.md` |
| [Commercial strategy](../COMMERCIAL_STRATEGY.md) | Working hypotheses, not shipped features or roadmap commitments | Accepted positioning in root `PRODUCT.md`, useful rationale in `decisions/product-positioning.md`, unresolved hypotheses in `plans/commercial-strategy.md` |

## Migration and temporary work

The [documentation migration checklist](plans/documentation-migration.md) owns
the migration sequence and completion record. Existing documents remain at their
current paths until their tasks finish; update this index when each move lands.
Root entrypoints, legal files, package entrypoints, and tool-required files retain
their existing homes.

Older [plans](../plans/) and artifacts in [design](../design/) and
[mockups](../mockups/) await review under that checklist. Their location does not
make them current authority or evidence of shipped features. Active plans will
live in `docs/internal/plans/`; completed or superseded plans and unneeded
attachments are deleted after enduring findings and open work have owners. There
is no archive directory. Needed reusable visual examples belong in the existing
design system.
