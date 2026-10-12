# Usage limits design

> Scope: provider account windows and connection help on Usage limits.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md) owns shared controls and tokens.
> Related code and checks: `app/components/command-center/CommandViews.tsx`, `app/components/CodexUsageHelp.tsx`, and `tests/ui/codex-usage-help.test.tsx`.

## Connection help

- Each provider keeps its account windows and expanded connection help in the same section.
- Retained usage values remain visible after a failed refresh.
- Reconnect controls use the shared Secondary role beside the Setup guide.
- **Reconnect Claude Code** follows the existing authentication-failure availability rule.
- **Reconnect Codex** appears on desktop for authentication, generic unavailable, missing-runtime, or empty-window evidence.
- Generic unavailable evidence does not establish that authentication failed.
- Browser and paired-device views show manual login guidance without a reconnect control.
- Rate-limited evidence shows cooldown guidance without a reconnect control.
- Pending sign-in disables reconnect and shows **Waiting for sign-in…**.
- A polite status line shows fixed completion, cancellation, missing-CLI, launch-failure, busy, and timeout messages.
- Completion requests a usage refresh without changing observed usage or provider health in the renderer.
- Recovered usage removes connection help.
- Native confirmation and login data rules belong to [Provider and account privacy](../architecture/privacy/providers-and-accounts.md#desktop-account-sign-in).
