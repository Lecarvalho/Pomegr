---
name: improve-codebase-architecture
description: Scan Pomegr for deepening opportunities, present them as a visual HTML report, then grill through whichever one the user picks. Informed by Pomegr's architecture map, behavior contracts, and product-owner decisions. Use only when explicitly invoked to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make the codebase more testable and agent-navigable.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities**: refactors that turn shallow modules into deep ones. The aim is testability and agent-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point; don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Module**: anything with an interface and an implementation (function, file, package, slice).
- **Interface**: everything a caller must know to use the module: types, invariants, error modes, ordering, config. Not just the type signature.
- **Implementation**: the code inside.
- **Depth**: leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam**: where an interface lives; a place behaviour can be altered without editing in place. (Use this, not "boundary.")
- **Adapter**: a concrete thing satisfying an interface at a seam.
- **Leverage**: what callers get from depth.
- **Locality**: what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

Pomegr's word "boundary" in existing docs (for example "desktop shell security boundary") names a privacy or trust rule, not a seam. Keep the glossary term **seam** for architecture and leave the project's boundary names untouched when quoting them.

## Pomegr sources

Pomegr has no single domain glossary or ADR folder. Its domain language and settled decisions live in these files; read the ones for the area you touch before exploring.

| Need | Source |
| --- | --- |
| Domain vocabulary | [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) (runtime map, normalized state), [docs/OBSERVATION_CACHE.md](../../../docs/OBSERVATION_CACHE.md) (U1 Acquisition, U2 Normalization, C Commit, D Derivation, P Persistence, S Serving, F Presentation), [docs/METRICS.md](../../../docs/METRICS.md), [docs/SIGNAL_DICTIONARY.md](../../../docs/SIGNAL_DICTIONARY.md), and [PRODUCT.md](../../../PRODUCT.md) |
| Behavior owners and forbidden dependency directions | [docs/AGENT-WORKFLOW.md](../../../docs/AGENT-WORKFLOW.md), `.dependency-cruiser.cjs`, and `scripts/check-architecture.mjs` |
| Settled decisions (the equivalent of ADRs) | [AGENTS.md](../../../AGENTS.md) security, privacy, and metric invariants, including dated product-owner decisions; [docs/OBSERVATION_CACHE.md](../../../docs/OBSERVATION_CACHE.md); the executable [provider contract](../../../server/providers/provider-contract.mjs); [DESIGN.md](../../../DESIGN.md) for UI; and [limitations](../../../docs/internal/architecture/limitations.md) for accepted gaps |
| Where authority sits when sources conflict | [docs/internal/README.md](../../../docs/internal/README.md). Plans in `docs/internal/plans/` or `docs/plans/` are work records, not decisions |

## Process

### 1. Explore

**Scope before you scan: YAGNI.** Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed. Decide *where* to look before you look:

- If the user named a direction (a module, a subsystem, a pain point), take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline --stat`) to find the hot spots: the files and areas that keep coming up. Let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.

Read the Pomegr sources above for the area you're touching. Use `docs/AGENT-WORKFLOW.md` to find the behavior owner and focused test command for each hot spot.

Then spawn exploration sub-agents to walk the codebase, on the cheapest capable model as `AGENTS.md` requires. Split independent areas (for example `server/providers/`, the observation runtime, `app/`, `desktop/`) across parallel agents. Don't follow rigid heuristics; explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow**, with an interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams? In Pomegr, watch especially for provider transcript schemas escaping `server/providers/`, serving handlers doing acquisition or normalization, and React code reaching past the normalized API.
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML file outside the repository so nothing lands in the working tree. Use the harness scratchpad directory when one is provided; otherwise resolve the OS temp dir (`%TEMP%` on Windows, `$TMPDIR` or `/tmp` elsewhere). Write to `<dir>/architecture-review-<timestamp>.html` so each run gets a fresh file. Open it for the user (`start <path>` on Windows, `open <path>` on macOS, `xdg-open <path>` on Linux) and tell them the absolute path.

The report describes code structure only. Never include session data, transcript paths or content, credentials, or anything else `AGENTS.md` keeps out of browser state.

The report uses **Tailwind via CDN** for layout and styling, and **Mermaid via CDN** for diagrams where a graph/flow/sequence reliably communicates the structure. Mix Mermaid with hand-crafted CSS/SVG visuals: use Mermaid when relationships are graph-shaped (call graphs, dependencies, sequences), and hand-built divs/SVG when you want something more editorial (mass diagrams, cross-sections, collapse animations). Each candidate gets a **before/after visualisation**. Be visual.

For each candidate, render a card with:

- **Files**: which files/modules are involved
- **Problem**: why the current architecture is causing friction
- **Solution**: plain English description of what would change
- **Benefits**: explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram**: side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength**: one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use Pomegr's domain vocabulary for the domain, and [LANGUAGE.md](LANGUAGE.md) vocabulary for the architecture.** Name modules after the concepts in the sources above: "the Codex liveness module," "the session catalog serving module," "the Normalization phase," not "the FooBarHandler," and not "the liveness service."

**Decision conflicts**: if a candidate contradicts an invariant in `AGENTS.md`, a rule in `docs/OBSERVATION_CACHE.md`, the provider contract, or a dated product-owner decision, only surface it when the friction is real enough to warrant reopening the decision. Mark it clearly in the card (e.g. a warning callout: _"contradicts the cache-only GET rule in AGENTS.md, but worth reopening because…"_). Don't list every theoretical refactor a decision forbids. Never propose weakening a security or privacy invariant as a refactor; that is a product-owner decision, not an architecture one.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them, one question at a time, each with your recommended answer: constraints, dependencies (see [DEEPENING.md](DEEPENING.md)), the shape of the deepened module, what sits behind the seam, which tests survive, and which focused verification command from `docs/AGENT-WORKFLOW.md` proves the change.

Side effects happen inline as decisions crystallize. Follow the [documentation maintenance workflow](../../../docs/internal/development/documentation.md) and [style guide](../../../docs/STYLE_GUIDE.md) for every doc edit:

- **Naming a deepened module after a concept the docs don't define?** Add the term to the doc that owns that area (`docs/ARCHITECTURE.md` for runtime structure, `docs/OBSERVATION_CACHE.md` for observation phases and cache ownership, `docs/METRICS.md` for deterministic rules). Don't create a separate glossary file.
- **Sharpening a fuzzy term during the conversation?** Update the owning doc right there.
- **Moving a behavior owner or dependency direction?** Update the routing table in `docs/AGENT-WORKFLOW.md`, and `.dependency-cruiser.cjs` or `scripts/check-architecture.mjs` when the rule is enforced there.
- **User rejects the candidate with a load-bearing reason?** Offer to record it, framed as: _"Want me to record this so future architecture reviews don't re-suggest it?"_ Record it in the owning contract doc (or `AGENTS.md` for repository-wide rules) as a dated product-owner decision, matching the existing "as decided by the product owner on YYYY-MM-DD" style. Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing; skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).
- **Ready to implement?** Stop and let the user ask for it. The change then follows the `AGENTS.md` change checklist.
