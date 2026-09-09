---
name: restart-pomegr
description: Start or restart the local Pomegr development app in a visible PowerShell terminal independent of Codex. Use when the user asks to restart, relaunch, reboot, or replace the running Pomegr server.
---

# Restart Pomegr

Invoke the bundled `scripts/restart-pomegr.ps1` by resolving it relative to the directory containing this `SKILL.md`, then run that absolute path in the host environment. The caller's working directory may be anywhere.

The helper resolves the repository from the skill package and asks the existing Windows Explorer desktop to open one visible PowerShell terminal running `npm run dev`. This avoids inheriting Codex's Windows process job. Plain `Start-Process` or calling `ShellExecute` on a newly created `Shell.Application` object does not establish that independence. Do not close the launched terminal. If Explorer is unavailable, report the failure instead of silently using a Codex-owned launcher.

Do not inspect or stop listeners before launching. Pomegr's `npm run dev` command owns process replacement: `scripts/dev.mjs` invokes the repository's guarded stop helper, which replaces recognized Pomegr development services and refuses an unrecognized process on ports `3003` or `4317`.

The returned terminal process ID confirms launch, not application readiness. After launching, verify both local `/api/state` endpoints respond successfully and that the listeners on ports `3003` and `4317` descend from that terminal. When confirming independence, check its Explorer ancestry and Windows job membership. Report the terminal process ID and the checks actually completed.

If `npm run dev` reports that ownership changed during cleanup, retry the helper once and verify again. For another failure or an unrecognized port owner, leave the terminal open for inspection and report the error; do not substitute broad process-name termination.
