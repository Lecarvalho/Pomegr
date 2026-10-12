---
name: pair-pomegr-phone
description: Make the running Pomegr desktop app available to the owner's phone as a paired device. Reuse the app by default, start the development desktop if absent, and optionally rebuild or restart when requested or needed for recovery.
---

# Pair a phone with Pomegr

The main goal is phone access, not restarting the app. Reuse a healthy running Pomegr desktop and its existing sharing whenever possible. Creating or editing this skill alone does not request app or pairing changes.

Use the repository containing this skill only when a start, build or update is needed. Resolve the checkout root three directories above this skill directory. New desktop launches must remain available after this chat ends.

## Choose the smallest needed action

- Locate the running Pomegr desktop using the available Computer Use plugin. Read that plugin's skill before native UI actions. Read the checkout's current `docs/public/using-pomegr/phone-access.md`; the task boundary is `docs/internal/architecture/tasks.md#paired-devices`.
- If the desktop is healthy, go directly to **Phone access**. Do not pull, build, quit, restart, regenerate a code or revoke pairings merely to reconnect a phone.
- If the owner can already open the dashboard on the paired phone, return its current address. The paired count alone cannot identify the owner's browser or prove it is connected.
- If the request does not establish whether this phone is paired, provide the current dashboard address first. If it asks the owner to pair or reports expired access, create a fresh pairing link. Do not infer phone identity from the count or restart to resolve this uncertainty.
- If pairing is needed, follow **Pair or reconnect the phone** below. If the app is absent, prepare and launch it using the optional desktop workflow.
- Restart only when the owner requests it, requests running an updated version, or recovery requires it. A Git pull alone does not imply a runtime restart. Explain that any needed restart expires existing pairings. If the need is uncertain, diagnose it before interrupting a healthy app.

## Optional: prepare the requested desktop version

- Read the checkout's `AGENTS.md` before repository operations.
- Pull or change branches only when requested. For a pull, inspect branch, dirty state, pending Git operations and upstream divergence first. Preserve work and fast-forward a clean main when possible. Use the host environment for Git and builds.
- Run `npm run desktop:prepare` in the checkout and require success before closing the working app. It builds the web assets, plugin bundles, legal notices and desktop workers. Use `npm ci` only when dependencies require it. Do not run builds concurrently.
- To restart the development desktop during phone pairing, use this skill's Electron workflow and `launch-desktop.ps1`. The `restart-pomegr` skill runs `npm run dev`, which provides different services. It cannot replace the desktop's pairing and task dispatcher.

## Optional: restart or launch independently

For a needed restart, identify the Pomegr window by its returned app/window identity and the checkout's Electron executable. Close that window and select **Quit Pomegr** if the tray-choice dialog appears. Keep the user's remembered close behavior unchanged. Confirm that the identified main Electron process exits; do not kill all Electron, Node, PowerShell or provider sessions. Skip shutdown when the app is absent.

If closing appears to do nothing, refresh window state and inspect for the tray-choice dialog before retrying. A failed Quit click leaves the app running. If the launch helper refuses an existing desktop, return to that app's quit flow. Confirm process exit before launching again.

Run the bundled helper in the host environment, resolving its absolute path relative to this skill:

```powershell
& '<skill-directory>\scripts\launch-desktop.ps1' -RepositoryPath '<checkout-root>'
```

The helper refuses an existing Electron process from this checkout. It asks the existing Explorer desktop to open a visible PowerShell terminal running `electron.cmd .`. It verifies Explorer parentage and Windows job independence. Leave that terminal open. If Explorer is unavailable, report that failure instead of falling back to a Codex-owned launcher. `-CheckOnly` validates prerequisites and reports existing processes without opening or stopping anything.

The returned PID proves terminal launch, not app readiness. Locate the new Electron window and verify that the dashboard loads and its local monitor is available. Confirm the Electron process descends from the returned terminal. Desktop ports are dynamic: discover current listeners rather than assuming development ports 3003/4317. Unauthenticated private `/api/state` calls can correctly return 401; do not misreport them as an outage or extract a private token to bypass authentication. The monitor must remain loopback-only.

## Pair or reconnect the phone

- Open **Settings > Phone access** in the running desktop. Keep **Sharing started** intact. Otherwise enable sharing on the intended private network as part of the requested pairing. Do not change firewall or Windows network policy to overcome a refusal; report the concrete blocker.
- A restart revokes previous pairings. For a phone that needs pairing, reuse a visible unexpired code or select **Create pairing code** when none exists. A code is single-use and expires after five minutes; the address can change on each restart. Regenerate only when the existing code is expired, consumed or unusable.
- When the owner is away from the PC, provide the QR's actual pairing URL as a clickable link in this chat. Its fragment is essential. Obtain it from the displayed QR through local decoding; do not reconstruct it, read process memory, alter the pairing store or redeem it in your own browser.
- Use an available local QR decoder against the captured QR pixels. If a decoder is needed, install it in a temporary tool directory, not the repository's dependencies. Temporary screenshots must stay local and be removed after decoding. Never send the QR to an external decoding service or persist its secret in the skill, Git, logs or reports. The link is shared only with the requesting owner.
- The owner must open the link in the phone browser on the same private network. Providing a link is not proof of pairing. Once the owner opens it, check the desktop's paired-phone count; that count confirms redeemed browser pairings, not current connectivity. Avoid routine polling. If no phone reply arrives, finish with the link and clearly state that opening it completes pairing.
- Read the displayed expiry before sharing a visible code. If the app or phone reports that the code expired or could not be used, generate another on request. Never redeem a code yourself to test whether it was consumed. Keep **Start on a private network** unchanged unless the owner asks to change it.

Report whether the app was reused or started, and either verified pairing or the fresh link with its expiry. Include the commit only after a Git update and the terminal PID only after a launch. For task starts, the owner opens a task and confirms **Start session** on the phone; this workflow does not itself launch a task.

## Desktop automation recovery

- With `@oai/sky`, initialize the runtime in the current JavaScript session before using it; bindings from a previous turn may no longer exist.
- Capture screenshot-backed state before clicking desktop controls. Accessibility text can expose an element index without usable input geometry. If an index is unavailable or geometry is missing, capture fresh state and use the visible control's coordinates with that screenshot's ID.
- Refresh state after each input. If the immediate observation shows the previous page, window, or a loading message, observe again before retrying. Verify the intended transition instead of repeating a click against stale state.
- Do not automate terminals through the UI. Use the host shell for builds, launch helpers, process ancestry, and listener checks.
