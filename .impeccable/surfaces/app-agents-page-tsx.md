---
version: 1
slug: "app-agents-page-tsx"
mode: operate
primary_target: "app/agents/page.tsx"
related_targets:
  - "app/components/agents/AgentsView.tsx"
  - "app/components/agents/AgentsModelPanels.tsx"
  - "app/components/agents/AgentsRosterPanel.tsx"
  - "app/components/agents/AgentEvidencePanel.tsx"
  - "app/components/agents/AgentsView.module.css"
---

# Agents

## Purpose

The Agents route presents cached, normalized activity evidence for a selected project, period, and scope. Its approved visual reference is [docs/design/agents-preview.html](../../docs/design/agents-preview.html).

## Structure

Use two tabs: **Models & work** for the model ranking, role matrix, recorded-work panel, selection patterns, and counting disclosure; **Live agents** for the roster. Keep the model, matrix, roster, and evidence drawer as reusable Agents components instead of folding the surface into the route.

## Evidence and state

Render only the cached snapshot returned for the active filter set. A retained snapshot may remain visible while it refreshes; a disconnected retained snapshot is stale. Model labels describe the latest reported model for each run. Recorded work is attributable execution-task evidence: show unavailable or partial evidence when counts are missing, and distinguish that from a known zero count. Pattern drill-downs and roster evidence lead to the actual parent session.

## Roster

Use the shared `CommandTable` without sortable columns. Preserve the backend's stable parent-first order and show assignment depth with indentation and branch treatment. Do not locally regroup or reorder the hierarchy.

Project, Period, and Agent state filters reuse the shared `CommandSelect` primitive for native behavior and consistent inset chevrons.

## Responsive behavior

On narrow screens, project and period controls keep useful half-row widths in Models & work; Live agents gives its project control a full row before scope and About. The roster remains a horizontally scrollable table with enough assignment width for nested labels; do not compress its hierarchy into overlapping cells.
