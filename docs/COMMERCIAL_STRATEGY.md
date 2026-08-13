# Pomegr commercial strategy

> Working document: these are business hypotheses to validate, not shipped features or public roadmap commitments.

## Product thesis

Pomegr can become the privacy-first operations console for teams using coding agents. Its commercial advantage is not generic AI tracing. It is useful execution visibility without collecting raw prompts, responses, commands, tool output, or source code.

The local, single-user observer should remain useful and open source. Revenue should come from convenience, coordination, governance, and support around the open-source core.

Current licensing decision: future Pomegr development uses `AGPL-3.0-only`, with the option to offer separate commercial terms. Previously published MIT revisions remain MIT. The Pomegr name and visual identity are governed separately by the repository's trademark policy.

## Target customer

The initial buyer hypothesis is an engineering manager, developer-platform lead, or AI-enablement lead at a team that:

- has roughly 5–50 developers using one or more coding-agent providers;
- wants to understand agent activity, attention states, context pressure, and repository outcomes;
- cannot send private transcripts or source code to another observability service; and
- is willing to pay for team-wide visibility, alerts, retention, or governance.

## Potential editions

### Community

The open-source, local observer: live sessions, local history, deterministic metrics, reports, and provider adapters.

### Pro

A convenience product for individual developers. Possible value includes a signed installer, automatic updates, background startup, desktop notifications, scheduled reports, and extended local history.

Initial pricing hypothesis: USD 9 per month or USD 79 per year.

### Teams

A shared view built from bounded, normalized metadata produced on developer machines. Raw transcripts and credentials remain local. Possible value includes a team session catalog, attention and stuck-session alerts, shared reports, retention controls, budget signals, and repository integrations.

Initial pricing hypothesis: USD 15–25 per developer per month, possibly with an organization minimum.

### Enterprise

A self-hosted or privately managed coordination layer with SSO, role-based access, audit logs, configurable retention, deployment support, and an SLA.

Initial pricing hypothesis: annual contracts starting around USD 10,000, subject to customer discovery.

## Recommended validation path

Do not build billing or a multi-tenant service before validating the buyer and pain.

1. Package Pomegr so a new user can install and see value quickly.
2. Publish a short demo centered on concurrent sessions, attention state, context, and Git changes.
3. Interview at least 15 teams already using coding agents.
4. Offer three paid, four-week design-partner engagements.
5. Manually provide a weekly privacy-bounded agent-operations report.
6. Record which requests repeat across paying partners before committing to a Teams architecture.

A possible pilot price is USD 500–1,500 per company. The purpose is learning, not services revenue at scale.

## Evidence to seek

Strong buying signals include repeated requests to:

- see agent activity across the whole team;
- receive an alert when a session needs attention or appears stuck;
- compare projects or providers without reading transcripts;
- retain safe operational metadata for later review;
- enforce or demonstrate privacy boundaries; or
- obtain SSO, access controls, auditability, or deployment support.

The first meaningful validation milestone is three organizations paying for a pilot and using the output repeatedly. Stars, downloads, and compliments are useful distribution signals but do not validate the commercial buyer by themselves.

## Positioning

Working category: **privacy-first operations for coding agents**.

Working one-liner:

> See what your coding agents are doing without collecting prompts or source code.

Pomegr should not position itself as an authoritative evaluator of developer or agent quality. Metrics and recommendations remain deterministic signals tied to concrete execution evidence.

## Open questions

- Is the first paying buyer an individual developer, engineering manager, platform team, or security team?
- Is packaging alone valuable enough for Pro, or is team coordination the first durable paid product?
- Which normalized fields can organizations safely aggregate while preserving Pomegr's privacy promise?
- Is hosted coordination acceptable, or do target customers require self-hosting from the beginning?
- Which notification or repository integration creates the strongest recurring use?
- What usage or outcome should pricing track: developers, active machines, retained sessions, or organization size?

## Non-goals

- Selling raw transcript storage or prompt surveillance.
- Presenting heuristics as AI judgments or authoritative performance scores.
- Competing broadly with application-level LLM tracing platforms.
- Building bespoke provider integrations that do not strengthen the normalized core.
