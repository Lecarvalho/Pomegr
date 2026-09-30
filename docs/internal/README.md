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
| Repository-wide boundaries and change routing | [AGENTS.md](../../AGENTS.md) governs repository changes; [agent workflow](development/agent-workflow.md) locates behavior owners and checks. [CLAUDE.md](../../CLAUDE.md) is a thin provider entrypoint. |
| Product purpose and contribution | [PRODUCT.md](../../PRODUCT.md) records product purpose and constraints; [CONTRIBUTING.md](../../CONTRIBUTING.md) governs contribution expectations. Consult the precise runtime contracts for implemented behavior. |
| Runtime structure | [Architecture](architecture/overview.md) maps the system; the focused contracts below define their respective behavior. |
| Observation phases, cache ownership, serving, readiness, and polling | [Observation cache](architecture/observation-cache.md) is the canonical operational contract. It and AGENTS.md take precedence over conflicting plans. |
| Provider conformance | [Executable provider contract](../../server/providers/provider-contract.mjs) defines catalog, manifest, readiness, evidence, and conformance requirements. Transcript schemas stay in adapters. |
| Provider and Pomegr limitations | [Limitations](architecture/limitations.md) owns the current inventory and generated capability matrix; executable manifests own capability declarations and behavior contracts own exact rules. |
| Metrics and evidence | [Metrics](architecture/metrics.md) owns deterministic rules; [signal dictionary](architecture/signal-dictionary.md) defines stable evidence codes and limits. |
| Interface design | [DESIGN.md](../../DESIGN.md) is the written contract. The existing `/design-system` page is the authoritative visual reference, backed by its [examples](../../app/components/design-system/DesignSystemView.tsx) and shared tokens/components. No HTML preview or mockup is an authority; [design system gaps](plans/design-system-gaps.md) lists the accepted patterns the page still lacks. |
| Legal terms and rationale | Root [LICENSE](../../LICENSE), [NOTICE](../../NOTICE), [source notice](../../SOURCE.md), and [trademark policy](../../TRADEMARKS.md) retain their legal/packaging homes; the [license history](decisions/license-history.md) decision explains the transition. |
| Accepted decisions | The [`decisions/`](decisions/) pages record why a choice was made: [license history](decisions/license-history.md), [product positioning](decisions/product-positioning.md), and [Codex Windows presence](decisions/codex-windows-presence.md). They are rationale only; the contracts above own current behavior, and a decision page names any replacement. |
| Unshipped proposals and temporary work | The [`plans/`](plans/) pages are working checklists with an owner, next decision, and deletion rule. The [commercial strategy](plans/commercial-strategy.md), [remote platform](plans/remote-platform-and-orgs.md), and [mobile pairing](plans/mobile-pairing-cloudflare.md) plans are unvalidated or unimplemented; none is a shipped feature or a roadmap commitment. |

Plans describe work or historical reasoning, not runtime authority. The session
status comparison records known gaps alongside implemented rules, and the desktop beta
acceptance page lists open acceptance items; neither implies that pending work passed.

## Architecture and evidence

All links below point to current files. Destinations in code spans are planned
paths relative to `docs/internal/`, not additional authoritative copies.

| Current reference | Scope | Planned destination |
| --- | --- | --- |
| [Architecture](architecture/overview.md) | Runtime map and data flow | Maintained at this path |
| [Limitations](architecture/limitations.md) | Provider-related and Pomegr-specific gaps; capability availability | Maintained at this path |
| [Observation cache](architecture/observation-cache.md) | Operational boundaries and committed evidence; the canonical operational contract, with a contents list at its top | Maintained at this path |
| [Metrics](architecture/metrics.md) | Deterministic rules and evidence limits | Maintained at this path |
| [Claude Code session status](architecture/claude-session-status.md) | Provider lifecycle sources, request boundary, and privacy | Maintained at this path |
| [Global session statuses](architecture/session-status.md) | Current status rules and known gaps, with unresolved proposals in a labeled final section | Maintained at this path |
| [Provider service status](architecture/provider-status.md) | Public status sources and interpretation | Maintained at this path |
| [Cache timing](architecture/cache-timing.md) | Cache timestamps, lifetime indication, and inference limits; the public explanation is [Cache reuse](../public/concepts/cache-reuse.md) | Maintained at this path |
| [Signal dictionary](architecture/signal-dictionary.md) | Stable evidence identifiers | Maintained at this path |
| [MCP observation queries](architecture/mcp-queries.md) | Session resolution, evidence semantics, transport, and privacy; usage guidance is the public [MCP queries guide](../public/using-pomegr/mcp-queries.md) | Maintained at this path |

## Development

Start changes with the [agent workflow](development/agent-workflow.md) to find the behavior
owner, forbidden dependency direction, and focused verification command. Follow
its canonical verification requirements before handing off a change.

| Current reference | Scope | Planned destination |
| --- | --- | --- |
| [Agent workflow](development/agent-workflow.md) | Change routing and verification | Maintained at this path |
| [Configuration and troubleshooting](development/configuration.md) | Environment variables, provider setup, and the technical contracts behind the public help pages; links the provider capability reference | Maintained at this path |
| [Pomegr plugins](development/plugins.md) | Canonical sources, generation, versioning, and release; usage guidance is the public [Reporting plugins guide](../public/using-pomegr/reporting-plugins.md) | Maintained at this path |
| [Command table](development/command-table.md) | Component integration; visual authority remains the design system | Maintained at this path |

The shared [style guide](../STYLE_GUIDE.md) owns writing rules, audience profiles,
templates, supported formatting, visual ownership, and artifact lifecycle. The
[documentation maintenance workflow](development/documentation.md) owns placement,
migration, publication, checks, and closure. Both are maintained authorities;
the migration checklist records only the remaining task sequence and progress.

The [publication manifest contract](development/documentation-manifest.md) defines
the format of [docs/site.json](../site.json), page membership, navigation order,
unique routes, and local link/image handling. The manifest selects ready public
pages in reading order, starting with the
[introduction to Pomegr](../public/get-started/introduction.md); build-time
publication and validation tooling remain pending.

## Operations and decisions

| Current reference | Scope | Planned destination |
| --- | --- | --- |
| [Pipeline operations](operations/pipeline-diagnostics.md) | Continuous development JSONL diagnostics, passive analysis, and the auxiliary snapshot | Maintained at this path |
| [Desktop releases](operations/desktop-releases.md) | Packaging, signing, publication, and rollback | Maintained at this path |
| [Desktop beta acceptance](operations/desktop-beta-acceptance.md) | Candidate acceptance procedure, evidence gates and retention, the open `POMEGR-DT-08` to `POMEGR-DT-10` items, and the desktop milestone IDs | Maintained at this path |
| [Desktop clean-VM checklist](operations/desktop-clean-vm.md) | Reusable clean-VM checks, with the recorded alpha run and the pending 0.2.4 candidate under Recorded acceptance runs | Maintained at this path |
| [Website operations](operations/website.md) | Landing development, provisioning, manual deployment, and rollback; [package entrypoint](../../landing/README.md) | Maintained at this path |
| [License history](decisions/license-history.md) | Accepted licensing decision and rationale | Maintained at this path |
| [Product positioning](decisions/product-positioning.md) | Accepted open-source-core, bounded-visibility, and non-evaluator positioning; current wording lives in root [PRODUCT.md](../../PRODUCT.md) | Maintained at this path |
| [Codex Windows presence](decisions/codex-windows-presence.md) | Why Codex liveness evidence is ranked and labeled as it is, and which earlier proposals shipped, were superseded, or were rejected; the contract is in the [observation cache](architecture/observation-cache.md) | Maintained at this path |

## Migration and temporary work

The progressive Activity/Request publication contract is maintained in
[Observation cache](architecture/observation-cache.md). Continuous JSONL diagnostics and passive
analysis are maintained in [Pipeline operations](operations/pipeline-diagnostics.md).

The [documentation migration checklist](plans/documentation-migration.md) owns
the migration sequence and completion record. Existing documents remain at their
current paths until their tasks finish; update this index when each move lands.
Root entrypoints, legal files, package entrypoints, and tool-required files retain
their existing homes.

The [session Activity panel plan](plans/session-activity-panel.md) is under
implementation review after a reported request/activity highlighting failure.
Keep the plan until the user explicitly approves deletion. Runtime rules are
recorded in [Activity events](architecture/metrics.md#activity-events) and the
[Activity feed contract](architecture/observation-cache.md#activity-feed).

The [information architecture redesign plan](plans/ia-redesign.md) holds the
approved navigation, session tab, agent detail, file history, and transport
redesign with its prototype artboards. Implementation is active: Sessions 1–3 are
complete, and Session 4 (persistence and storage) is next. The plan remains a
working checklist, not runtime authority; [DESIGN.md](../../DESIGN.md),
[Observation cache](architecture/observation-cache.md), and [Metrics](architecture/metrics.md) own
shipped behavior.

The [overview sparse state and link rule plan](plans/overview-sparse-and-links.md)
is an approved, not yet implemented UI change to the session Overview and Signals
tabs. It reuses the redesign prototype artboards and moves its rules into
[DESIGN.md](../../DESIGN.md) as its tasks complete.

The [guidance impact plan](plans/guidance-impact.md) is a design-approved plan (2026-09-22,
no code yet) to tag sessions with the repository guidance revision they ran under
(skills, `AGENTS.md`, hooks, reporting policy), compare friction, outcome, and
compliance signals across cohorts, and run opt-in randomized experiments. Nothing
in it is shipped or authoritative.

The [commercial strategy plan](plans/commercial-strategy.md) holds the unvalidated
editions, pricing, buyer, and validation-path hypotheses; its accepted statements
are in [PRODUCT.md](../../PRODUCT.md) and the
[product positioning decision](decisions/product-positioning.md). The
[remote platform plan](plans/remote-platform-and-orgs.md) and the
[mobile pairing plan](plans/mobile-pairing-cloudflare.md) are proposals with no
backend, relay, or mobile app implemented; the only shipped phone feature is the
same-network [phone access](../public/using-pomegr/phone-access.md). Each plan
declares its owner, next decision, exit criteria, and deletion rule.

The [design system gaps plan](plans/design-system-gaps.md) lists the accepted
reusable patterns that still have no static sample on `/design-system`, and two
critique findings carried over from the retired Impeccable reports. The HTML
previews and mockups that once lived in `docs/design/` and `docs/mockups/` were
reviewed against the design promotion gate and deleted.

Active plans live in `docs/internal/plans/`; completed or superseded plans and
unneeded attachments are deleted after enduring findings and open work have
owners. There is no archive directory. Needed reusable visual examples belong in
the existing design system.
