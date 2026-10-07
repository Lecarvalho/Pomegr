# Maintainer documentation

This index routes maintainers and coding agents to current contracts, development
guidance, and operating procedures. It is a navigation and authority map; the
linked owners retain their contracts. For user guidance, see the
[documentation index](../README.md).

Internal pages are excluded from documentation website publication. They remain
readable in the repository and must not contain secrets or private session data.

## Where internal pages live

| Folder | Holds |
| --- | --- |
| [`architecture/`](architecture/overview.md) | Current runtime behavior, boundaries, and invariants: the contracts in [Architecture and evidence](#architecture-and-evidence) |
| [`development/`](development/agent-workflow.md) | Contributor workflow, configuration, tooling, and verification: see [Development](#development) |
| [`operations/`](operations/desktop-releases.md) | Release, acceptance, diagnostics, and website runbooks: see [Operations and decisions](#operations-and-decisions) |
| [`decisions/`](decisions/license-history.md) | Accepted rationale with continuing relevance; it never overrides a contract |
| [`plans/`](plans/provider-notifications.md) | Temporary checklists and proposals, each with an owner and a deletion rule: see [Plans and temporary work](#plans-and-temporary-work) |

Public user guides live in [`docs/public/`](../public/get-started/introduction.md) and are
indexed in the [documentation index](../README.md).

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
| Interface design | [DESIGN.md](../../DESIGN.md) is the written contract. The existing `/design-system` page is the authoritative visual reference, backed by its [samples](../../app/components/design-system/) and shared tokens/components. No HTML preview or mockup is an authority; [design system gaps](plans/design-system-gaps.md) lists the accepted patterns the page still lacks. |
| Release, acceptance, diagnostics, and website procedures | The [`operations/`](operations/desktop-releases.md) runbooks are the procedures of record: [desktop releases](operations/desktop-releases.md), [beta acceptance](operations/desktop-beta-acceptance.md), [clean-VM checklist](operations/desktop-clean-vm.md), [pipeline diagnostics](operations/pipeline-diagnostics.md), and [website operations](operations/website.md). The contracts above own behavior. |
| Legal terms and rationale | Root [LICENSE](../../LICENSE), [NOTICE](../../NOTICE), [source notice](../../SOURCE.md), and [trademark policy](../../TRADEMARKS.md) retain their legal/packaging homes; the [license history](decisions/license-history.md) decision explains the transition. |
| Accepted decisions | The [`decisions/`](decisions/) pages record why a choice was made: [license history](decisions/license-history.md), [product positioning](decisions/product-positioning.md), and [Codex Windows presence](decisions/codex-windows-presence.md). They are rationale only; the contracts above own current behavior, and a decision page names any replacement. |
| Unshipped proposals and temporary work | The [`plans/`](plans/) pages are working checklists with an owner, next decision, and deletion rule. The [commercial strategy](plans/commercial-strategy.md), [remote platform](plans/remote-platform-and-orgs.md), and [mobile pairing](plans/mobile-pairing-cloudflare.md) plans are unvalidated or unimplemented; none is a shipped feature or a roadmap commitment. |

Plans describe work or historical reasoning, not runtime authority. The session
status comparison records known gaps alongside implemented rules and does not imply
that pending work passed.

## Architecture and evidence

Each page below is maintained at its current path.

| Reference | Scope |
| --- | --- |
| [Architecture](architecture/overview.md) | Runtime map and data flow |
| [Limitations](architecture/limitations.md) | Provider-related and Pomegr-specific gaps; capability availability |
| [Observation cache](architecture/observation-cache.md) | Operational boundaries and committed evidence; the canonical operational contract, with a contents list at its top |
| [Metrics](architecture/metrics.md) | Deterministic rules and evidence limits |
| [Claude Code session status](architecture/claude-session-status.md) | Provider lifecycle sources, request boundary, and privacy |
| [Global session statuses](architecture/session-status.md) | Current status rules and known gaps, with unresolved proposals in a labeled final section |
| [Provider service status](architecture/provider-status.md) | Public status sources and interpretation |
| [Cache timing](architecture/cache-timing.md) | Cache timestamps, lifetime indication, and inference limits; the public explanation is [Cache reuse](../public/concepts/cache-reuse.md) |
| [Signal dictionary](architecture/signal-dictionary.md) | Stable evidence identifiers |
| [Provider tool inventory](architecture/tool-inventory.md) | Tool identities and rollout items observed per harness version, their work kinds, and what is not read |
| [MCP observation queries](architecture/mcp-queries.md) | Session resolution, evidence semantics, transport, and privacy; usage guidance is the public [MCP queries guide](../public/using-pomegr/mcp-queries.md) |

## Development

Start changes with the [agent workflow](development/agent-workflow.md) to find the behavior
owner, forbidden dependency direction, and focused verification command. Follow
its canonical verification requirements before handing off a change.

| Reference | Scope |
| --- | --- |
| [Agent workflow](development/agent-workflow.md) | Change routing and verification |
| [Configuration and troubleshooting](development/configuration.md) | Environment variables, provider setup, and the technical contracts behind the public help pages; links the provider capability reference |
| [Pomegr plugins](development/plugins.md) | Canonical sources, generation, versioning, and release; usage guidance is the public [Reporting plugins guide](../public/using-pomegr/reporting-plugins.md) |
| [Command table](development/command-table.md) | Component integration; visual authority remains the design system |

The shared [style guide](../STYLE_GUIDE.md) owns writing rules, audience profiles,
templates, supported formatting, visual ownership, and artifact lifecycle. The
[documentation maintenance workflow](development/documentation.md) owns placement,
migration, publication, checks, and closure. Both are maintained authorities.

The [publication manifest contract](development/documentation-manifest.md) defines
the format of [docs/site.json](../site.json), page membership, navigation order,
unique routes, and local link/image handling. The manifest selects ready public
pages in reading order, starting with the
[introduction to Pomegr](../public/get-started/introduction.md). The build-time
loader, the `/docs` site, and `npm run check:docs` are implemented; publishing is a
manual website deployment ([website operations](operations/website.md#6-publish-documentation)).

## Operations and decisions

| Reference | Scope |
| --- | --- |
| [Pipeline operations](operations/pipeline-diagnostics.md) | Continuous development JSONL diagnostics, passive analysis, and the auxiliary snapshot |
| [Desktop releases](operations/desktop-releases.md) | Packaging, signing, publication, and rollback |
| [Desktop beta acceptance](operations/desktop-beta-acceptance.md) | Optional beta-candidate acceptance procedure, evidence gates and retention (owner and store), and the desktop milestone IDs, including the `POMEGR-DT-08` to `POMEGR-DT-10` items retired on 2026-10-01 |
| [Desktop clean-VM checklist](operations/desktop-clean-vm.md) | Reusable clean-VM checks, with the recorded alpha run under Recorded acceptance runs |
| [Website operations](operations/website.md) | Landing development, provisioning, manual deployment, and rollback; [package entrypoint](../../landing/README.md) |
| [License history](decisions/license-history.md) | Accepted licensing decision and rationale |
| [Product positioning](decisions/product-positioning.md) | Accepted open-source-core and non-evaluator positioning; current wording lives in root [PRODUCT.md](../../PRODUCT.md) |
| [Codex Windows presence](decisions/codex-windows-presence.md) | Why Codex liveness evidence is ranked and labeled as it is, and which earlier proposals shipped, were superseded, or were rejected; the contract is in the [observation cache](architecture/observation-cache.md) |

## Plans and temporary work

The [provider observers and notifications plan](plans/provider-notifications.md)
defines five approved sequential parts for one notification subsystem, including
Needs input, usage availability, provider/plugin releases, and model news. It is
in active implementation; each part has its own validated PR. Later source
availability and notification contracts remain proposed until their implementation
and checks pass.

The progressive Activity/Request publication contract is maintained in
[Observation cache](architecture/observation-cache.md). Continuous JSONL diagnostics and passive
analysis are maintained in [Pipeline operations](operations/pipeline-diagnostics.md).

Root entrypoints, legal files, package entrypoints, and tool-required
files retain their existing homes.

The [session Activity panel plan](plans/session-activity-panel.md) is implemented and
verified and awaits the user's review. Keep the plan until the user explicitly approves
deletion. Runtime rules are
recorded in [Activity events](architecture/metrics.md#activity-events) and the
[Activity feed contract](architecture/observation-cache.md#activity-feed).

The [information architecture redesign plan](plans/ia-redesign.md) holds the
approved navigation, session tab, agent detail, file history, and transport
redesign with its prototype artboards. Implementation is active; the plan's status
line names the next session. The plan remains a
working checklist, not runtime authority; [DESIGN.md](../../DESIGN.md),
[Observation cache](architecture/observation-cache.md), and [Metrics](architecture/metrics.md) own
shipped behavior.

The [overview sparse state and link rule plan](plans/overview-sparse-and-links.md)
is an approved, not yet implemented UI change to the session Overview and Signals
tabs. It reuses the redesign prototype artboards and moves its rules into
[DESIGN.md](../../DESIGN.md) as its tasks complete.

The [session allowance plan](plans/session-allowance.md) is a design-approved plan
(2026-09-21, revised 2026-09-30, no code yet) to record how many percentage points of
each provider account window moved while a session was sending requests, with the
observed account tier, in the monitor SQLite store. Nothing in it is shipped or
authoritative.

The [product expansion plan](plans/product-expansion.md) records the owner's review of
2026-09-30: the directions discussed for making Pomegr more attractive to developers,
what each needs first, and the decisions only the owner can make. It indexes two
proposals written that day, the [durable session store plan](plans/durable-session-store.md)
(normalized session evidence in the monitor SQLite store, so a restart does not re-read
transcripts) and the [session receipt plan](plans/session-receipt.md) (a picture of one
session that a user can copy or save, made on their own computer). Nothing in the three
is shipped or authoritative.

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

The [monitor performance plan](plans/monitor-performance.md) records a measured baseline
of monitor startup, opening a session, live-update latency, and background cost, three
planned fixes that target them, and the comparison to make after the fixes. Its
[measurement script](plans/monitor-performance/measure.mjs) is passive and is repeated
unchanged. The plan is working evidence, not runtime authority; the
[observation cache](architecture/observation-cache.md) owns the contracts.

The [design system gaps plan](plans/design-system-gaps.md) lists the accepted
reusable patterns that still have no static sample on `/design-system`, and two
critique findings carried over from the retired Impeccable reports. The HTML
previews and mockups of earlier design explorations were
reviewed against the design promotion gate and deleted.

Active plans live in `docs/internal/plans/`; completed or superseded plans and
unneeded attachments are deleted after enduring findings and open work have
owners. There is no archive directory. Needed reusable visual examples belong in
the existing design system.
