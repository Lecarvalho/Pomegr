# Documentation style guide

> Scope: shared writing, formatting, visual ownership, and artifact lifecycle for
> Pomegr documentation.
> Authority: maintained editorial contract for public and internal pages. Runtime
> behavior and privacy remain governed by [AGENTS.md](../AGENTS.md) and the
> [current technical contracts](internal/README.md#choose-the-authority).

Write each page to help a reader complete one task or understand one subject.
Apply these rules to new pages and pages as they migrate; existing documents keep
their current homes and authority until their migration task completes. This
guide defines authoring conventions, not an already-implemented website renderer
or validation command.

## Write for a clear purpose

- Lead with the answer, outcome, or responsibility. Give prerequisites before
  steps, and put limitations beside the claims they qualify.
- Use descriptive headings, short paragraphs, active voice, and familiar words.
  Explain necessary technical terms on first use. Address the reader as “you” in
  procedures; name the responsible component in contracts.
- Use numbered steps for an ordered procedure, bullets for independent items,
  and tables for comparisons or mappings. Each step should state an action and
  its expected result where the result is not obvious.
- Aim for 3–5 focused sections and roughly 200–600 words for ordinary guides.
  These are editorial defaults, not limits on contracts or reference material.
  Preserve required invariants when shortening or splitting a page.
- Link to canonical detail instead of copying policy, configuration tables, or
  procedures. Keep one maintained owner for each rule. Preserve inbound anchors
  or repair their references when reorganizing headings.
- Write **Pomegr** for the product and `pomegr` for package, repository, and
  directory identifiers. Use provider names only where the distinction matters.
  Match interface labels exactly, such as **Repositories** and **Setup**.
- Distinguish recorded evidence, provider estimates, agent reports, and
  deterministic inferences. Missing evidence is not proof of inactivity or
  success. Do not describe heuristics as AI judgments, billing, or confirmed
  causes. Link to [Metrics](METRICS.md) for precise definitions.
- Keep “context” tied to latest snapshots; label elapsed duration as wall time.
  A worked example must not turn independent requests into cumulative token
  spend. Mark invented example values as illustrative.
- Separate shipped behavior from proposals and known gaps. Date facts that age,
  such as version-specific behavior or prices, and cite their primary source
  beside the claim. Verify them when revising the page.

## Choose the audience

| | Public pages | Internal pages |
| --- | --- | --- |
| Reader's question | What can I do, and what does this label mean? | What owns this behavior, and what must remain true? |
| Include | Prerequisites, steps, expected results, examples, limitations, recovery | Scope, authority, data flow, invariants, code owners, failure behavior, verification |
| Useful visuals | Explanatory screenshots and worked examples | Dependency, data-flow, and state diagrams |
| Avoid | Maintainer-only build detail, raw provider schemas, speculative features | Repeated global policy, transcript dumps, finished investigation diaries |
| Home | `docs/public/` | `docs/internal/` |

Split mixed-audience pages when each resulting page has a clear purpose and
owner. Public instructions should stand on their own without requiring an
internal contract to complete the task. Internal pages may link to public usage
instructions and focus on the implementation behind them.

“Internal” means excluded from the documentation website, not confidential in
Git. Use synthetic or sanitized examples in both profiles. Never include private
session content, credentials, or real provider transcript paths in prose, code
examples, screenshots, or attachments.

## Use a small Markdown vocabulary

Use plain Markdown with headings, paragraphs, emphasis, inline code, links, lists,
tables, fenced code, images, and blockquotes. Task lists are for plans and
checklists. Arbitrary HTML, MDX/React, embedded scripts, and custom layout syntax
are outside this vocabulary; tool-required files retain their required formats.

Use one `#` page title, then `##` sections and `###` subsections without skipping
levels. Put blank lines around headings, lists, tables, and fences. Use **bold**
for exact UI labels and code spans for identifiers, paths, and literal values.
Keep table cells short; move long procedures into prose. Escape a literal pipe in
a table cell as `\|`.

Links use descriptive labels and repository-relative Markdown paths. Link to an
existing heading when it narrows the reader's destination. Show proposed paths
as code spans, not broken links. Public-to-public links should remain within the
selected public content; website route and asset validation belong to the
publication contract once implemented.

Code fences name their language, such as `powershell`, `json`, or `text`. State
the working directory and prerequisites before commands. Keep commands separate
from sample output, explain placeholders, and omit shell prompt prefixes so the
block can be copied. Do not pass example output off as a verification result.

Use only these callout labels, written as ordinary blockquotes so no special
renderer is required:

```markdown
> **Note:** Context is the latest observed snapshot.

> **Caution:** Explain a concrete consequence before the affected step.
```

Use **Note** for a short qualification and **Caution** for a consequence the
reader needs before acting. Keep essential steps in the main procedure; do not
turn every paragraph into a callout. Scope and lifecycle metadata use ordinary
blockquotes as shown in the templates below.

### Page templates

Adapt these starting points to the subject and remove unused sections. Replace
all placeholder text before publication. Public front matter begins with
`title` and `description`; use a short plain-text title and a one-sentence
description, with the same title in the H1. Do not invent additional publication
fields before the manifest contract defines them.

Public task or explanation:

```markdown
---
title: "Task or concept title"
description: "What the reader can do or understand after reading this page."
---

# Task or concept title

State the outcome or answer and its main limitation.

## Before you start

List only the prerequisites needed for this task.

## Complete the task

1. Describe the first action using the exact UI label.
2. Describe the next action and expected result.

## Understand the result

Explain the visible evidence with an illustrative example and its limits.

## If the result is missing

Describe the symptom, supported recovery, and a relevant next guide.
```

For a concept page, replace the prerequisite and procedure sections with
definitions and a worked example. For troubleshooting, lead with the observable
symptom, then checks and recovery; do not assert a cause without evidence.

Internal contract or runbook:

```markdown
# Behavior or procedure title

> Scope: the behavior this page covers and its boundary.
> Authority: canonical contract, operating procedure, or reference; name the
> governing contract if this page is subordinate.
> Related code and checks: link the behavior owner and focused verification.

State the component's responsibility or the procedure's outcome.

## Behavior and boundaries

Explain inputs, outputs, ownership, and the data flow or ordered procedure.

## Invariants and failure behavior

State what must remain true and what happens when evidence is unavailable.

## Change and verify

Identify where to edit, the relevant checks, and the expected evidence of success.
Separate automated checks from any required manual acceptance.
```

Accepted decision:

```markdown
# Decision title

> Status: accepted.
> Decided: YYYY-MM-DD.
> Scope and owner: affected area and maintainer responsible for continuation.
> Authority: rationale; link the contract that owns current behavior.

## Decision and context

State what was accepted and the concrete constraint it addresses.

## Alternatives and consequences

Record useful tradeoffs, limitations, and implications for future changes.
Link a replacement decision if superseded.
```

Temporary plan:

```markdown
# Work title

> Status: active or paused; state the current checkpoint.
> Created: YYYY-MM-DD.
> Scope: the intended outcome and boundaries.
> Continuation owner: a named maintainer or explicitly assigned role.
> Authority: working checklist; current runtime contracts govern behavior.
> Next task or decision: a concrete action, including what unblocks paused work.
> Completion criteria: observable conditions that close this work.
> Permanent destinations: name the contracts, guides, decisions, or design-system
> examples that will own enduring findings.
> Lifetime: temporary; delete on completion, cancellation, or supersession after
> applying the closure steps in the style guide.

## Work and verification

- [ ] Describe a bounded task and its acceptance evidence.

## Continuation checkpoint

Record completed work, remaining obligations, and the next action.
```

## Give visuals an owner

Add a visual only when it explains something more clearly than text. Public
screenshots should show the relevant control or evidence with enough surrounding
context to locate it. Diagrams should explain a flow, boundary, or state change.
Keep essential meaning in nearby text, and do not rely on color alone.

Use Markdown image syntax with meaningful alt text describing the information
the image conveys. For example, in a future public concept page:

```markdown
![Context drops after compaction, then stays level at later observations.](../images/context-and-tokens/context-compaction-drop.png)
```

That path is an authoring example, not an already-migrated asset. Store maintained
public images under `docs/public/images/<topic>/`; keep internal explanatory
assets beside their owning page in a topic directory. Use a maintained image
for diagrams that need rendering beyond ordinary Markdown; keep editable source
with its owner where useful. No Mermaid or other diagram runtime is assumed by
the documentation publication pipeline.

The existing `/design-system` page on the web development server is the
authoritative visual reference. [DESIGN.md](../DESIGN.md) is the written contract;
the [design-system examples](../app/components/design-system/DesignSystemView.tsx)
use the actual shared tokens and components. Documentation and HTML previews must
not become a second visual authority or component gallery.

Before retiring a design exploration, compare it with the live examples. Promote
missing accepted reusable patterns through the shared implementation and page,
updating DESIGN.md and its contract tests together where required. Already
represented or rejected alternatives need no duplicate promotion. Record
unresolved feature work in an active plan. Preserve the design-system page's
static-data-only, web-development-only access contract; do not add it to public,
desktop, or phone navigation.

## Maintain or retire the artifact

Permanent means maintained while the subject remains relevant. Purpose determines
lifetime: a screenshot explaining a supported feature is maintained with its
guide; a screenshot recording a finished exploration is temporary.

| Material | Home and lifetime |
| --- | --- |
| User guide, current contract, runbook | Public or internal documentation; update with behavior and retire with its subject |
| Accepted decision | `docs/internal/decisions/`; retain useful rationale and link a replacement if superseded |
| Plan or research proposal | `docs/internal/plans/`; delete when completed, cancelled, or superseded |
| HTML mockup or design review image | Attachment under its active plan's topic directory; promote needed patterns, then delete |
| Explanatory screenshot or diagram | With its maintained page; update or remove together |
| One-session notes or scripts | Ignored `work/<topic>/`; remove when the investigation closes |
| Generated review reports, screenshots, or logs | Ignored `outputs/<topic>/` or external artifacts; remove when review closes |
| Required release evidence | Designated artifact store under explicit release retention; keep reusable procedures in documentation |

New topic names use lowercase kebab-case. Create a directory only when its first
page or asset needs it. Retain conventional entrypoint and tool-required names
such as `README.md`, `STYLE_GUIDE.md`, `AGENTS.md`, and `SKILL.md`. Preserve root
legal and package/tool ownership; placement details follow the
[maintainer index](internal/README.md) during migration.

Close temporary work in the same change that fulfills or retires it:

1. Transfer current behavior and invariants to the permanent contract.
2. Transfer useful accepted rationale to a concise decision record. Put reusable
   visual rules and examples into the existing design system.
3. Give unfinished obligations a named active plan or existing issue and an owner.
4. Repair references that treat the temporary artifact as current authority,
   including indexes, anchors, agent routes, and hidden tool references.
5. Preserve explicitly required release evidence outside the temporary plan,
   following the [release](DESKTOP_RELEASES.md) and
   [acceptance](DESKTOP_BETA_ACCEPTANCE.md) procedures.
6. Delete the plan and unneeded attachments. Git history retains prior tracked
   versions; do not create a checked-in archive copy.

Paused work must state its next decision and continuation owner. It is not an
indefinite artifact store. Verify changed links, anchors, images, and affected
consumers, and follow the [agent workflow](AGENT-WORKFLOW.md#focused-verification)
for the applicable canonical checks.
