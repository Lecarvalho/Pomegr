---
version: 1
slug: "app-layout-tsx"
primary_target: "app/layout.tsx"
related_targets: ["app/components/command-center/CommandCenterShell.tsx","app/components/command-center/CommandViews.tsx","app/HomeDashboard.tsx","app/settings/SettingsPage.tsx","app/globals.css"]
---

# Pomegr Command Center

The approved direction is the Command Center concept in `.impeccable/mocks/decision/pomegr-shell-concepts.html`, selected by the user from the original three shell proposals. The application is one calm monitoring instrument: a compact branded header, persistent route rail, evidence workspace, and non-modal notifications. The production shell has no persistent footer row, and session pages end with their final evidence panel; observer, source, license, version, and similar supporting details belong in Settings or About. The user-approved HTML in `docs/design/pomegr-ui-preview.html` is the code-led authority for this refresh; the production app retains every real route and capability.

## Direction contract

- **Thesis:** one focused Command Center, not a collection of page-local dashboards and drawers.
- **Own world:** charcoal operational surfaces (`#111315`, `#191c20`, `#23272d`) with light neutrals (`#f3f4f5`, `#ffffff`, `#e9edf1`); pomegranate wordmark; green, amber, lavender, and semantic error reserved for truthful evidence; one-pixel rules; Inter for UI and Geist Mono for data.
- **Story:** move from workspace status to sessions, agents, usage, repositories, and settings without losing monitor context.
- **First viewport:** 60px global header, 220px route rail, live workspace, and anchored notification tray without a reserved footer strip. At compact widths the rail becomes an icon rail; at mobile widths it becomes an off-canvas labelled drawer so the workspace keeps the full viewport.
- **Form:** approved Command Center HTML preview; no generated component or seed is required because the user pinned the code-led direction.

## Production commitments

| Element | Production medium | Commitment |
| --- | --- | --- |
| Identity | Compact raster-derived pomegranate mark plus Pomegr name | Use one small pomegranate brush mark beside the Pomegr name on desktop and mobile. On mobile, place this identity directly after the menu control. Use the generated PNG artwork as a mask so the divided and outline forms retain their organic edges while inheriting the application brand color token. |
| Navigation | Semantic Next links and inline SVG icons | Home, Dashboards, Sessions, Agents, Usage limits, Repositories, Settings; current route and live-session count stay visible. |
| Header | HTML/CSS | 60px global destination search, local-monitor state, notification bell, and a local-profile placeholder marked Coming soon. |
| Notifications | Bounded normalized session catalog | Non-modal tray with needs-input and system state only; never conversation, command, credential, or transcript content. |
| Home | Personal browser-local preferences plus bounded destination catalog | Pinned sessions, projects, and views; last-viewed session; What’s new, report discovery, and honest Coming soon previews. Monitoring activity, counters, usage, and polling remain on their dedicated routes. |
| Sessions | Reusable command table | Searchable/filterable real catalog with canonical detail links. |
| Dashboards | Built-in route directory | Real destinations only; custom composition is explicitly unavailable. |
| Agents | Understand model use, roles, recorded work, and delegation | Cached Models & work summaries with evidence drill-downs; hierarchical Live agents roster preserves session provenance. |
| Usage limits | Existing shared usage store | Provider-reported account windows with correlation-not-attribution caveat. |
| Repositories | Session-to-project associations | Association counts only; branch/Git aggregation is explicitly coming soon. |
| Settings | Accessible tab system | Appearance, desktop-notification boundary, existing display preferences, and About; full keyboard tab behavior. The About pane opens with the painted Pomegr mark beside its name and concise product purpose. |
| Responsive layout | CSS grid reflow | Preserve task order and legibility rather than shrinking the desktop composition uniformly. |

The dark prototype is the compositional authority. The warm light theme is an intentional accessibility/user-preference adaptation using the same topology and semantic roles. Missing global agent and repository contracts force honest unavailable states rather than illustrative production data.

Approved provider-status extension: compact fixed status on Home and beside each provider
in Usage limits (mobile headers use a 44px status-icon control with the full wording
in accessible details, leaving room for the account update time); a reusable dismissible yellow notice below the live session header only
for fresh relevant service issues. No global-header indicator, historical-session notice,
or quota/authentication conflation. One shared status store consumes the independently
revisioned cache-only endpoint; official public reports are never guarantees of availability.
