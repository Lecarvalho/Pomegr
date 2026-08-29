---
version: 1
slug: "app-layout-tsx"
primary_target: "app/layout.tsx"
related_targets: ["app/components/command-center/CommandCenterShell.tsx","app/components/command-center/CommandViews.tsx","app/HomeDashboard.tsx","app/settings/SettingsPage.tsx","app/globals.css"]
---

# Pomegr Command Center

The approved direction is the Command Center concept in `.impeccable/mocks/decision/pomegr-shell-concepts.html`, selected by the user from the original three shell proposals. The application is one calm monitoring instrument: a compact wordmark-only header, persistent route rail, evidence workspace, non-modal notifications, and a quiet read-only footer. The app defaults to the near-black operational world while retaining a complete warm light theme.

## Direction contract

- **Thesis:** one focused Command Center, not a collection of page-local dashboards and drawers.
- **Own world:** near-black operational surfaces; pomegranate wordmark; green, amber, and lavender reserved for semantic evidence; one-pixel rules; Rokkitt, Inter, and Geist Mono in distinct roles.
- **Story:** move from workspace status to sessions, agents, usage, repositories, and settings without losing monitor context.
- **First viewport:** 58px global header, 220px route rail, live workspace, anchored notification tray, and 38px read-only footer. At compact widths the rail becomes 54px and labels yield to recognizable icons; at mobile widths it becomes an off-canvas labelled drawer so the workspace keeps the full viewport.
- **Form:** approved Command Center, seed `f4dae4f2`.

## Production commitments

| Element | Production medium | Commitment |
| --- | --- | --- |
| Identity | Existing SVG wordmark component | Wordmark only in the application shell; no product-mark icon. |
| Navigation | Semantic Next links and inline SVG icons | Home, Dashboards, Sessions, Agents, Usage limits, Repositories, Settings; current route and live-session count stay visible. |
| Header | HTML/CSS | Global destination search, local-monitor state, notification bell, and a local-profile placeholder marked Coming soon. |
| Notifications | Bounded normalized session catalog | Non-modal tray with needs-input and system state only; never conversation, command, credential, or transcript content. |
| Home | Existing normalized catalog and usage clients | Current live-session, active-agent, context-snapshot, provider-window, and activity evidence. |
| Sessions | Reusable command table | Searchable/filterable real catalog with canonical detail links. |
| Dashboards | Built-in route directory | Real destinations only; custom composition is explicitly unavailable. |
| Agents | Aggregate live-session evidence | Counts where known; global roster is explicitly coming soon and never inferred. |
| Usage limits | Existing shared usage store | Provider-reported account windows with correlation-not-attribution caveat. |
| Repositories | Session-to-project associations | Association counts only; branch/Git aggregation is explicitly coming soon. |
| Settings | Accessible tab system | Appearance, desktop-notification boundary, existing display preferences, and About; full keyboard tab behavior. |
| Responsive layout | CSS grid reflow | Preserve task order and legibility rather than shrinking the desktop composition uniformly. |

The dark prototype is the compositional authority. The warm light theme is an intentional accessibility/user-preference adaptation using the same topology and semantic roles. Missing global agent and repository contracts force honest unavailable states rather than illustrative production data.
