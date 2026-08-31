---
version: 1
slug: "app-homedashboard-tsx"
primary_target: "app/HomeDashboard.tsx"
related_targets: ["app/HomeDashboard.module.css","app/hooks/useHomePreferences.ts"]
---

# Personal Home

Mode: Operate, with a small Read discovery area. The user approved the personal-starting-point direction and the integrated Session coach preview in this task; no new visual identity is introduced.

Home lets returning users revisit chosen destinations and their last-viewed session. It must remain useful for first-time users and when the monitor is unavailable. Six browser-local pins resolve session, project, or view identities using the existing catalog. An inline searchable picker supports selection and removal; project pins open an exact Sessions filter. No activity lists, usage charts, session counts, context counters, or Home-owned fetches belong here. The page follows the app token system: Inter title/section/UI/control hierarchy, 12px metadata, Geist Mono for data, 4px controls, and 6px panels.

Composition: a bounded Welcome to Pomegr header; a primary Sessions panel grouping Browse sessions, last-viewed navigation, and subordinate pinned destinations; a narrower Understand your sessions panel with concrete context-history and report guidance. All Coming soon previews share one delimited background, with Session coach prominent. What’s new is a prominent dismissible panel directly below the welcome header. Dismissal is remembered in browser-local preferences for the current update only. On mobile these sections retain reading order in one column. Preserve the 60px shell header, wordmark-only provider-neutral identity, semantic color roles, dark/light themes, keyboard focus, and 44px touch controls.

Coming soon means unavailable: no fake metrics, pretend chat input, disabled primary actions, model calls, or session control. Coach copy distinguishes planned evidence-based suggestions from facts and requires future explicit opt-in before transmission. What’s new describes this implemented Home update without inventing a release date.

Verification: persistent pin/unpin, bounded identity-only storage, last-viewed navigation, exact project filtering, unavailable/missing catalog handling, independent static content, no Home data polling, and desktop/mobile inspection.

Approved provider-status extension: show a compact fixed service-status panel using the
shared `/api/provider-status` client. This is the sole external-service status region;
Home still owns no fetch loop and does not consume Home aggregates or account usage.
The ordinary state says No reported issues. Unknown/stale observations stay neutral.
No service-status content is added to the global header.
The Home status panel sits directly below Sessions in the left column, before the guides
on mobile. It shares the other panels' h2 title style, border, radius, surface, and inline
padding, with compact 12px block padding and aligned provider/status rows without extra
row gaps. Keep 44px touch controls; it must not appear as an unboxed divider strip.
