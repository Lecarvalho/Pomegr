---
name: restart-pomegr
description: Start or restart the local Pomegr development app by running npm run dev in a new standalone PowerShell terminal. Use when the user asks to restart, relaunch, reboot, or replace the running Pomegr server.
---

# Restart Pomegr

Invoke the bundled `scripts/restart-pomegr.ps1` by resolving it relative to the directory containing this `SKILL.md`, then run that absolute path. The caller's working directory may be anywhere.

The helper resolves the repository from the skill package and opens a new visible, persistent PowerShell terminal running `npm run dev`. Do not close that terminal.

Do not inspect or stop listeners before launching. Pomegr's `npm run dev` command owns process replacement: `scripts/dev.mjs` invokes the repository's guarded stop helper, which replaces recognized Pomegr development services and refuses an unrecognized process on ports `3003` or `4317`.

Report the detached terminal process ID returned by the helper. If `npm run dev` reports a startup or ownership error in that terminal, leave it open for inspection; do not substitute broad process-name termination.
