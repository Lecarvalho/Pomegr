---
title: "Claude Code local usage"
description: "Turn on local usage so Pomegr can show Claude Code's five-hour and seven-day usage when account checks fail, and see what Pomegr keeps."
---

# Claude Code local usage

Local usage lets Pomegr read the usage that Claude Code itself reports in its
status line, so **Usage limits** can show Claude Code's five-hour and seven-day
windows when Pomegr's own account check fails. It also records Claude Code's
session cost estimate for the Overview **Cost** panel. Figures are Claude Code's
reports for your whole account, so they can lag activity elsewhere on it.

## Before you start

- Use Claude Code with a Claude Pro or Max subscription. Claude Code's status
  line reports these windows only for those subscribers, and only after the
  first response in a session
  ([status-line documentation](https://code.claude.com/docs/en/statusline#rate-limit-usage),
  checked October 1, 2026).
- Local usage is optional. Pomegr's own account check uses the sign-in Claude
  Code saved, so enable local usage when that check fails; see
  [Usage limits](../concepts/usage-limits.md).

## Enable it in the desktop app

The installed Windows app offers the setup. The portable app does not, because
its runtime path is temporary.

1. Open **Usage limits**. When Claude Code usage is unavailable, **Usage
   connection help** opens under the Claude Code card.
2. Select **Enable local usage**.
3. Review the confirmation dialog, which says Pomegr will update the Claude Code
   profile's status-line setting, and confirm.

Pomegr reports "Local usage feed enabled." Figures appear after Claude Code
reports usage in a supported session, labeled **Last observed**. Setup keeps your
existing status-line command and its other settings, runs no sign-in or model
request, and needs no separate Node.js installation. If Claude Code's settings
are malformed or change during setup, Pomegr refuses and leaves them as they
were. Cancelling also changes nothing.

## Set it up in a browser

A browser-only installation has no **Enable local usage** button, so edit Claude
Code's settings yourself. You need Node.js and a copy of the Pomegr repository.

1. In `~/.claude/settings.json`, set `statusLine.command` to run Pomegr's script,
   then `--`, then your existing status-line command:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"<repo>/scripts/claude-statusline-bridge.mjs\" -- <existing status-line command>"
     }
   }
   ```

   `<repo>` is your copy of the Pomegr repository. Use forward slashes in
   Windows paths. Pass the existing executable and its arguments after `--`; a
   shell expression needs an explicit shell executable and its arguments. With no
   existing status line, omit `--` and the command after it.
2. Keep the script as the outermost command. It passes Claude Code's input to
   your command unchanged, so the visible status line keeps working, but
   replacing it with a direct call stops the captures.
3. Make sure Pomegr and the script use the same snapshot folder. If you set
   `POMEGR_USAGE_SNAPSHOTS_DIR` (or `POMEGR_DATA_DIR`), give both the same value.

Each setup observes one Claude Code profile. Use separate folders for separate
accounts or profiles.

## What Pomegr keeps

- **Usage:** a version number, the observation time, and the two usage
  percentages with their reset times. It holds no account, session, prompt,
  response, token, or sign-in data.
- **Cost estimate:** the session ID, a non-negative dollar amount, the estimate
  type, and the observation time. It is Claude Code's estimate, not a bill.

Repeated identical values keep their original time, so an unchanged reading does
not look newer. Local usage has no Fable window; Pomegr shows that separately,
as described in [Usage limits](../concepts/usage-limits.md#provider-differences).
To stop capture, restore your previous status-line command in that profile's
Claude Code settings.

## If no usage appears

- Confirm a Pro or Max account and at least one response in a session.
- Project or managed Claude Code settings can override your user status line, and
  enabling local usage does not override them. Check Claude Code's status-line
  and workspace-trust settings.
- For sign-in problems and provider cooldowns, see
  [If a window is missing](../concepts/usage-limits.md#if-a-window-is-missing).
