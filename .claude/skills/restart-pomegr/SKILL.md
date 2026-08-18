---
name: restart-pomegr
description: Safely restart the local Pomegr development app in a new standalone PowerShell terminal. Use when the user asks to restart, relaunch, reboot, or replace the running Pomegr server, especially when they are away from the PC and need the process detached from the current agent session.
---

# Restart Pomegr

This skill is defined once, in the Codex package, so both harnesses run the same
procedure. Read `.codex/skills/restart-pomegr/SKILL.md` from the repository root and follow
it exactly.

That file resolves its script relative to its own directory, which is
`.codex/skills/restart-pomegr/scripts/restart-pomegr.ps1` from the repository root. Run
that absolute path. The script is the safety boundary: do not reimplement its listener
ownership checks and do not substitute a broad process-name termination.
