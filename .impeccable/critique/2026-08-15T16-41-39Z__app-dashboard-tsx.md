---
target: Full dashboard context/cache audit
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-15T16-41-39Z
slug: app-dashboard-tsx
---
Method: dual-agent (A: /root/dashboard_design_review · B: /root/dashboard_detector_review)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 4 | Connection, refresh, pause, historical, attention, and agent states are clear. |
| 2 | Match system / real world | 3 | Developer language fits, but “context” names multiple unlike measurements. |
| 3 | User control and freedom | 3 | Disclosures, popovers, session switching, pause, refresh, and series toggles are strong; analytical scope controls are absent. |
| 4 | Consistency and standards | 4 | Panels, statuses, disclosures, and provenance language are cohesive. |
| 5 | Error prevention | 3 | Read-only behavior prevents operational mistakes; chart semantics can still produce false conclusions. |
| 6 | Recognition rather than recall | 3 | Most session evidence is visible, but cache events and loaded-context meaning require discovery or memory. |
| 7 | Flexibility and efficiency | 2 | Strong basic keyboard behavior, but no agent/time filters or analytical accelerators. |
| 8 | Aesthetic and minimalist design | 3 | Dense and restrained, but repeated rollups and equal-weight panels weaken hierarchy. |
| 9 | Error recognition and recovery | 3 | Unavailable and collecting states are clear; unsupported or unobserved cost is silent. |
| 10 | Help and documentation | 2 | Method copy exists, but snapshot, growth, cache, loaded inventory, and cost relationships are not explained in place. |
| **Total** |  | **30/40** | **Good foundation; information architecture needs clarification.** |

## Design Specificity Verdict

Pomegr feels credible and purpose-built in its agent tree, provider provenance, privacy boundaries, deterministic signals, and live/historical distinctions. The dark operations-wall surface is polished. The overall dashboard structure is still moderately category-interchangeable, however, because Pomegr's defining subject—multi-agent execution and context—is not the organizing hierarchy of the page.

The deterministic scan reported 246 findings, all in `app/globals.css`: one `layout-transition` warning, 129 color-token advisories, 91 font-size advisories, and 25 radius advisories. Most advisories are noisy because the scanner does not resolve cascade overrides, route-specific selectors, allowed 8–12px label typography, semantic circles, or tonal alpha variants. The `transition: width` warning is genuine but low impact. The volume still indicates token/documentation drift worth auditing separately.

No user-visible detector overlay was produced. Mutable browser injection was blocked by the read-only evaluation scope, so the evidence fallback was fresh-tab screenshots, DOM/ARIA snapshots, computed layout and contrast, and control-state tests across live Codex, live Claude, historical Codex, desktop, and 390×844 mobile.

## Overall Impression

The dashboard is strong at answering “what is running, what needs attention, and what state did each agent reach?” It becomes unclear when answering “what happened to context and cache over time?” The principal problem is not missing per-agent context—the Agent activity panel already solves that. The problem is that the large context panel combines current all-agent state, derived net growth, request cache classifications, and conditional cost copy in one visual grammar.

## What's Working

- Agent activity is the canonical context-now view: hierarchy, per-agent context, wall time, status, freshness, model/effort, tasks, and skills are compact and privacy-safe.
- System truth is handled carefully: live versus historical state, provider attribution, read-only posture, estimates, unsupported states, and deterministic heuristics are consistently qualified.
- The interaction foundation is solid: semantic controls, disclosure state, popover dismissal, chart bucket labels, resource-chart keyboard inspection, visible focus, responsive reflow, and no mobile horizontal overflow.

## Priority Issues

### [P1] Current-state and change metrics share one context chart

The 431K-style headline and legend are latest all-agent snapshots, while the plotted series are positive net changes between bucket-boundary snapshots. The chart can therefore hide large within-bucket cache writes and invites users to read unlike measures as one metric.

**Recommendation:** remove the latest snapshot totals and conditional cost estimate from the growth plot. If context history remains, scope it explicitly to one agent or “all-agent snapshot sum,” plot actual context level or label positive change unambiguously, and keep a stable scale during filtering.

### [P1] Cost-relevant cache events are not visible for Claude

Raw provider snapshots contain the exact cold-refill-to-hit sequence, but the UI retains only the latest composition and bucket-end growth. Pomegr already has a deterministic “Prompt cache miss after idle gap” signal for Codex, but Claude disables cache-usage classification, so the inspected 146K and 151K Claude refill events produced no signal.

**Recommendation:** treat important cache transitions as bounded, per-request, agent-attributed events. Extend the existing cautious signal model to Claude only after provider-comparable evidence is defined. Do not infer cumulative cost or expose raw content.

### [P1] Three meanings of context are insufficiently distinguished

Agent rows show latest/final request context, the chart shows an all-agent sum plus derived growth, and Loaded context is a provider `/context` machinery estimate. These are valid but unlike measurements.

**Recommendation:** reserve “Agent context” for request snapshots, “Context history” for temporal change, and “Loaded context inventory” for `/context` machinery. Keep their provenance visible and never present the all-agent sum as unique shared memory.

### [P2] The all-agent headline is mathematically valid but operationally weak

It sums overlapping primary and subagent snapshots, including idle/finished agents. It may exceed one model window and does not represent active memory, unique tokens, or spend. The Agent activity panel already provides the decision-useful breakdown.

**Recommendation:** demote the all-agent total or label it “Sum of agent snapshots.” Do not use it as the dominant context fact.

### [P2] Cost has no stable session-level home

The provider-reported estimate appears only as conditional copy inside the context chart. When absent, the interface does not distinguish unsupported from not observed.

**Recommendation:** place provider-reported cost estimate at session scope, with provider provenance, observation time, and explicit unsupported/not-observed states. Keep it separate from token-derived charts.

### [P2] Dense chart interaction is expensive on keyboard and mobile

The context chart creates one focus stop per bucket plus four series switches. On mobile, 31 of 35 measured interactive targets were below 44px in one dimension; chart buckets, agent chips, text actions, and footer links contribute. Two controls also share the accessible name “Close session navigation.”

**Recommendation:** use one keyboard-inspectable chart surface with arrow navigation rather than focusable bucket-by-bucket traversal, enlarge genuine controls, and remove the redundant drawer-close stop.

## Persona Red Flags

**Alex — power user:** can identify agents and context immediately, but cannot scope temporal evidence by agent, compare cache transitions, or keep chart magnitude stable while filtering. Large tool-pattern lists have no search or grouping controls.

**Sam — accessibility-dependent user:** benefits from strong semantics, contrast, focus, and live regions, but faces excessive chart tab stops, many sub-44px controls, small secondary labels, color-dominant series tracing, and duplicate drawer-close names.

**Morgan — developer observing agents:** can answer “which agents ran?” and “what final context did each have?” but cannot answer “which request caused this refill?” or “why did cost rise?” without leaving the UI and inspecting normalized evidence manually.

## Minor Observations

- Flow score reassurance and the healthy Efficiency signal partially duplicate each other.
- Historical “Agents observed” repeats the Agent activity count; live active/total remains useful.
- Loaded context is correctly optional but is buried under a generic disclosure and could be confused with request context when present.
- Resource use is well executed but receives similar visual authority to the more product-specific agent/context evidence.
- The current session report repeats all-agent context and per-agent snapshots but intentionally omits cache-event history, so the same explanatory gap exists in exports.

## Decision Recommendation

Do not add another context-now panel or separate full graph per agent. Keep Agent activity as the canonical current/final context surface.

Replace the current context panel's mixed responsibility with two clearly separated analytical jobs:

1. **Context history:** selected agent by default (Primary), with an explicit optional all-agent snapshot sum. Show one context-level series and compaction/reset boundaries. Do not color context history by cache-write/read classification.
2. **Cache events:** a bounded chronological view of meaningful raw request snapshots, attributed to agents, preserving transitions such as “146K write, 0 read” followed by “759 write, 146K read.” Label deterministic cold-refill/miss observations cautiously and never convert them into inferred spend.

Move the provider-reported estimated session cost out of the chart. Keep Loaded context inventory as a separate provider-specific diagnostic. This preserves everything Pomegr already does well while making each surface answer one question.

Questions skipped: the evidence is decisive for the requested context/cache decision; no additional product intent is required before choosing the information architecture.
