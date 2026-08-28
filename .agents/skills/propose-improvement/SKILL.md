---
name: propose-improvement
description: Propose how to extend existing implementation logic using findings from a prior diagnosis. Use only when explicitly invoked after an investigation identifies additional behavior to support.
---

# Propose Improvement

Inspect the current implementation and its tests, then propose a concrete way to incorporate the relevant diagnostic finding into the existing logic.

Keep this phase read-only. Explain:

- how the current behavior works;
- the smallest rule or design change that covers the diagnosed case;
- the safeguards and fallback behavior needed to avoid unsupported conclusions;
- the files and tests that would likely change; and
- any privacy, compatibility, or API-contract implications.

Ground the proposal in repository evidence and the prior diagnosis. Distinguish confirmed facts from assumptions, and call out meaningful tradeoffs or unresolved decisions. Do not implement the change unless the user separately asks for implementation.
