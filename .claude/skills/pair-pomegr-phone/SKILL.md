---
name: pair-pomegr-phone
description: Make the running Pomegr desktop app available to the owner's phone as a paired device. Reuse the app by default, start the development desktop if absent, and optionally rebuild or restart when requested or needed for recovery.
---

# Pair a phone with Pomegr

Read `.agents/skills/pair-pomegr-phone/SKILL.md` from the repository root and follow
that shared procedure. Phone access is the goal; restarting is optional.

Resolve the launch helper relative to the shared skill directory, not this pointer:
`.agents/skills/pair-pomegr-phone/scripts/launch-desktop.ps1`.
