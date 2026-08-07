---
name: restart-threadlight
description: Safely restart the local Threadlight development app in a new standalone PowerShell terminal. Use when the user asks to restart, relaunch, reboot, or replace the running Threadlight server, especially when they are away from the PC and need the process detached from the current Codex session.
---

# Restart Threadlight

Invoke the bundled `scripts/restart-threadlight.ps1` by resolving it relative to the directory containing this `SKILL.md`, then run that absolute path. Do not resolve it from the caller's working directory or from the Threadlight repository root; the script is stored inside this skill package. The caller's working directory may be anywhere.

The script must remain the safety boundary. It:

1. Resolves the Threadlight repository from the skill location.
2. Inspects listeners on ports `3003` and `4317`.
3. Refuses to stop a listener unless its command line belongs to this repository.
4. Stops the validated Threadlight dev-process tree child-first.
5. Starts `npm run dev` in a visible, persistent PowerShell window detached from the current session.
6. Waits for both ports and verifies the monitor and dashboard HTTP responses.

Do not substitute broad process-name termination such as stopping every `node.exe`. If validation fails, report the exact blocker and leave the process untouched.

On success, report that the detached terminal is running and include the monitor and dashboard status codes. Do not close the new terminal.
