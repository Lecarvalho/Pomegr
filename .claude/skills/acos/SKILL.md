---
name: acos
description: Size a task against the project's session limits, compose an ACOS run manifest (or a plan of manifests, one per session), show it, wait for GO, then execute it without further interruptions and record what actually ran. Use when the user invokes /acos, asks to "run this through acos", or the project has a .acos.yaml and the user asks for a non-trivial code change.
---

# ACOS runner

This skill is defined once in the shared agent package, so both harnesses run the same
procedure. Read `.agents/skills/acos/SKILL.md` from the repository root and follow it
exactly.

That file refers to its adapter and workflow references relative to its own directory,
which is `.agents/skills/acos/references/` from the repository root.
