---
name: acos
description: Size a task against the project's session limits, compose an ACOS run manifest (or a plan of manifests, one per session), show it, wait for GO, then execute it without further interruptions and record what actually ran. Runs only when the user invokes /acos.
disable-model-invocation: true
---

# ACOS runner

This skill is defined once in the shared agent package, so both harnesses run the same
procedure. Read `.agents/skills/acos/SKILL.md` from the repository root and follow it
exactly.

That folder is the skill folder: its references, scripts, catalog, presets,
`config.yaml`, `calibration.md` and `runs/` all live in `.agents/skills/acos/`.
