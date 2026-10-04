# Guidance impact: did a skill or instruction change help?

> Status: design approved by the user on 2026-09-22 (task 0 done); no code written. Created 2026-09-22.
> Scope: let a user see whether new sessions in a repository moved forward or backward after they added or changed a skill, `AGENTS.md`, `CLAUDE.md`, hooks, or the Pomegr reporting policy, and let them run an opt-in randomized experiment between instruction variants. Monitor, store, plugin hook, API, desktop, and UI work; no content reading. Pomegr already injects context through the plugin hooks (policy rows, usage guard, progress reminder); the new boundary is user-authored text chosen at random per session, approved by the user on 2026-09-22.
> Design canvas: https://claude.ai/artifact/S6AjnMM87n6zbQrwtqvrfa (artboards 1 Guidance tab, 2 Session Overview, 3 New experiment, 3b Blank template). The drawings are the approved reference for tasks 5 to 7; the rules below win where a drawing differs.
> Continuation owner: the agent that picks up this plan in a fresh session.
> Authority: working proposal. `AGENTS.md`, `docs/internal/architecture/observation-cache.md`, and `docs/internal/architecture/metrics.md` stay authoritative and gain the enduring rules as tasks complete.
> Next task or decision: the owner decides on the staging proposed in [Review of 2026-09-30](#review-of-2026-09-30). If it is rejected, task 1, guidance revision fingerprinting, is next as before.
> Completion criteria: every task ticked with its verification recorded, contracts updated, `npm run build` and `npm test` pass, and the feature is documented in `docs/public/`.
> Permanent destinations: `docs/internal/architecture/observation-cache.md` (guidance revision domain, cohort serving), `docs/internal/architecture/metrics.md` (friction, outcome, compliance signals and comparison rules), `docs/internal/architecture/signal-dictionary.md` (new evidence codes), `docs/public/using-pomegr/` (user guide).
> Lifetime: temporary; delete this file in the change that completes the last task.

## Review of 2026-09-30

The owner said on 2026-09-30 that they are not sure this plan should go ahead as written: it looks like a long shot to build without knowing it is worth it. This section records the assessment made that day. It is a proposal; the tasks below are unchanged until the owner decides.

The plan bundles parts of very different value:

| Part | Assessment |
| --- | --- |
| Per-session friction and outcome signals (task 3) and compliance checks (task 2) | Worth building. Both are useful for one session with no statistics, and they feed the [session receipt](session-receipt.md) and a weekly digest. |
| Guidance revision tag on each session (task 1) | Cheap and time-sensitive. It cannot be backfilled, so collecting it early keeps a later comparison possible. |
| Cohort comparison and the regression flag (task 4) | Doubtful. One developer runs perhaps 5 to 20 sessions a week in a repository, on very different tasks. With cohorts of five, noise will usually win. |
| Randomized experiments (tasks 2b and 2c) | The long shot. It is the largest build, needs 15 sessions per arm, and is the first time Pomegr changes what the model sees, which breaks "read-only observer". |

Proposed staging:

1. Before any build, run a throwaway script over the existing recorded sessions: compute the friction signals and group them by the dates `AGENTS.md` and the skills changed. Keep it under the ignored `work/guidance-impact/` and remove it afterward.
2. If the owner's own heavy usage shows a difference they believe, continue with cohorts. If it shows none, stop after the first two parts in the table and close the rest of this plan.
3. Leave experiments parked until cohorts have proved useful.

Acceptance for step 1: the result, with the number of sessions and revisions it covered, is recorded under this heading with the owner's decision.

## The problem

A user edits a skill or an instruction file and hopes the next sessions get better.
Nothing measures that today. Some changes make sessions quietly worse: more
re-prompting, more failed commands, more edit churn, more compactions. The user
notices weeks later, if at all, and cannot tell which change caused it.

There is no ground truth for “good session”. Tasks differ, users differ, and the
provider changes models without notice. So Pomegr cannot score quality. It can do
something narrower and honest: tag every session with the instruction set it ran
under, record deterministic friction and outcome signals it already observes, and
show cohorts side by side so a regression stops being silent.

## Design principles

- Cohort comparison, not a quality score. Pomegr never says a session was good; it
  says sessions under revision B re-prompted more per turn than sessions under
  revision A, with the sample size beside the claim.
- Structural evidence only. Every signal comes from metadata Pomegr already
  normalizes or from counts of recognized events. No prompt, response, or tool-result
  text is read to detect “corrections” or “frustration”.
- Same limits as every other Pomegr heuristic: deterministic, traceable to concrete
  events, labeled as an inference, degrades to unavailable when evidence is
  incomplete. Missing friction is not proof of quality; a fast wrong session looks
  smooth.
- No causation claims. Cohorts are sequential, never randomized. Model changes,
  task mix, and user habits confound everything; the UI must carry that.
- Observation stays read-only. Pomegr never edits instruction files, never suggests
  reverting a change, and never runs a session to test one. The one deliberate
  exception is the opt-in experiment arm (section 7): the plugin's SessionStart hook
  injects repository-authored arm text as additional context, verbatim and without
  any marker, and the UI shows the arm on every session. Installing an experiment
  from the desktop writes only `.pomegr/experiments.yaml`. Pomegr never writes
  `AGENTS.md`, `CLAUDE.md`, skills, hooks, or provider configuration.
- The observation layer (revisions, cohorts, checks, ratings, regression flag) needs
  no plugin: the monitor hashes the guidance files and reads the checks table itself.
  Only experiments need the plugin hook, and the Guidance tab says so.

## Mechanism

### 1. Guidance revision: the cohort key

At session start the monitor fingerprints the repository's guidance surface for the
session's provider:

| Provider | Files hashed |
| --- | --- |
| Claude Code | `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/skills/**`, `.agents/skills/**`, `.claude/settings.json` hooks section, `.claude/agents/**`, `.pomegr/signals.md` |
| Codex | `AGENTS.md`, `.codex/skills/**`, `.agents/skills/**`, `.codex/hooks.json`, `.pomegr/signals.md` |

The fingerprint hashes normalized content, not paths or timestamps, so a
reformatting commit still creates a new revision but a `git checkout` of the same
content does not. A new fingerprint creates a new guidance revision for that
repository and provider. The record holds only: opaque revision ID, repository
identity, provider ID, first-seen timestamp, the Git commit that contained it when
the worktree was clean, a bounded list of safe repository-relative paths whose hash
changed from the previous revision (same validator as file-change history), and a
per-path change kind (`created`, `edited`, `deleted`). Hashes stay monitor-private.

Each session binds once to the revision current at its start, using the same
future-only, immutable binding rule as repository context inventories. A guidance
change mid-session does not retag the session. Sessions that predate the feature
receive an explicit no-binding decision.

### 2. Signals per session

All values are counts, medians, or booleans from evidence Pomegr already commits.
Each is normalized per user turn or per request so task size is not the whole
story, and the raw count is kept beside it.

Friction:

| Signal | Source | Note |
| --- | --- | --- |
| Re-prompts per turn | User turns that arrive when the agent stopped without a pending question | Structural; a turn after an `AskUserQuestion` is an answer, not a re-prompt |
| Interruptions | Execution tasks with lifecycle status `stopped` and cancelled tool calls | Already recognized by the execution-task normalizer |
| Execution-task failures | Failed tasks by bounded failure category | From execution-task metadata |
| Retry loops | Same work kind failing then rerun within a bounded window | Test-fail-then-rerun, build-fail-then-rerun |
| Repeated calls | Existing `repeatedCalls` count from the repetition rule | Already committed; see [Repetition](../architecture/metrics.md#repetition) |
| Edit churn | Files edited three or more times in one session | Needs the file-change history contract |
| Compactions per session and requests to first compaction | Context boundaries | Already committed |
| Requests per turn, wall time per turn | Request numbers and activity timestamps | Wall time includes idle gaps |
| Cost estimate per turn | Claude status-line estimate | Labeled as an estimate, Claude only |
| Subagents spawned, permission denials, questions asked | Agent catalog and activity kinds | Counts only |

Outcome:

| Signal | Source |
| --- | --- |
| Session ended with a passing test or build task as its last execution task | Execution tasks |
| Commit created during the session | Git state |
| Files changed, net lines | Git state, bounded |
| Agent-reported session outcome | Existing session-signal channel, with configured labels such as **Task complete** or **Blocked** |
| User rating | New, see below |

Compliance, defined per repository in `.pomegr/signals.md` next to the reporting
policy:

```markdown
## Guidance checks

| Check | Expect | When |
| --- | --- | --- |
| design-test | Execution task `test:ui` runs | A file under `app/styles/` was edited |
| build-before-end | Execution task `npm run build` runs | Any file under `monitor/` was edited |
| impeccable-skill | Skill `impeccable` invoked | A file under `app/components/` was edited |
```

The monitor reads this table directly from the repository root at session start,
so checks work without the plugin; `pomegr:doctor` only validates it. The monitor
evaluates each check from recognized work kinds, the existing
[skill usage](../architecture/metrics.md#skill-usage) evidence (validated canonical skill
name, count, latest timestamp), and file-change paths. A check reports `met`,
`unmet`, or `not applicable`. `.pomegr/signals.md` stays Markdown for now and
migrates to YAML in its own later change, so both policy files share one format. Compliance answers a different question from
friction: did the new instruction change behavior at all? A skill that is never
invoked after it was added is a result on its own, before any outcome number.

Checks come only from the structured table in `.pomegr/signals.md`. Pomegr keeps
its existing rule: it never parses `AGENTS.md`, `CLAUDE.md`, or skill prose to infer
what an agent should have done. Guidance files are hashed for the revision key,
never read for meaning.

### 3. Comparison rules

- Group sessions by guidance revision within one repository and provider. The
  default pair is the newest revision against the previous two; the user can pick
  any two revisions, or two repositories (for example two worktrees that differ
  only in the change under test), to compare instead.
- Show median and interquartile range per signal with the cohort's session count.
  A cohort with fewer than five sessions shows its numbers but no comparison verdict.
- Split cohorts by the model recorded on their requests. When the model mix differs
  between two cohorts by more than a bounded share, the comparison is labeled
  **model mix changed** and no direction is stated.
- Show each cohort's work-kind mix as a coarse task fingerprint. The comparison is
  labeled **task mix differs** when the mixes diverge; this does not hide the numbers.
- State direction only: **more**, **fewer**, **similar**, with a fixed margin per
  signal. No p-values, no effect sizes, no composite score.
- Never sum tokens across requests or sessions. Cohort numbers are medians of
  per-session values that are themselves derived from latest snapshots or counts.

### 4. Ground truth: user rating

One control on the session page: **How did this session go?** with three values,
**good**, **mixed**, **bad**, stored locally in the monitor store with the session
ID and timestamp. A rating is optional and can be changed. It is the only
judgment in the feature, and it is the user's. Once a cohort has ratings, the
comparison view shows the rating distribution beside the friction signals so the
user can see which signals track their own opinion in their own repository.

### 5. Regression flag

When a new revision reaches five sessions, the monitor compares it with the union
of the previous two revisions. If two or more friction signals moved in the worse
direction beyond their margins, and the model mix did not change, the repository
page shows one line: **Possible regression after changes to `AGENTS.md`,
`.claude/skills/foo`**, linking to the comparison and the changed paths. The flag
is labeled as an inference and clears when the next revision replaces the cohort.
There is no notification, no severity, and no suggested revert.

### 6. Presentation

- Repository page gains a **Guidance** tab: revision timeline (first-seen date,
  changed paths, session count), the cohort comparison table, and the compliance
  check grid. The two most recent revisions are compared by default.
- Session Overview shows the revision it ran under, the rating control, and any
  unmet compliance checks as a quiet line.
- Copy follows the [popover rule](../../STYLE_GUIDE.md): one or two short sentences,
  and every comparison carries its sample size and the confound labels above.
- Design goes through `DESIGN.md` and `/design-system`; no new button roles.

### 7. Randomized experiments (opt-in)

Sequential cohorts cannot separate a guidance change from time, model updates, and
task mix. An experiment randomizes the change per session.

- The experiment lives in `.pomegr/experiments.yaml` next to the reporting policy:
  one experiment at a time per repository. Fields: `id` (validated like the custom
  agent identifier, at most 64 characters), `status` (`running` or `stopped`),
  optional `providers` (omitted means every installed provider; Claude Code and
  Codex both work today because the plugin hook and the monitor's
  `additional_context` reader already cover both), `hypothesis` (free text for the
  user, never injected), and `arms`: two to four entries, identifier to text block
  of at most 4 KiB, where an empty string is the control arm. `pomegr:doctor`
  validates the file.
- Composer (canvas artboards 3 and 3b): **Repository › Guidance › New experiment**
  opens with six preset cards in the style of a marketplace grid (Blank, Test before
  done, Build before done, Ask before wide changes, Report progress, Concise final
  answers), each with a category icon (Verification, Conversation, Reporting, Style)
  and arm count. Presets are Pomegr-authored samples labeled as such, not
  recommendations; six only, no carousel. Selecting a card fills a full-width YAML
  editor with line numbers and a validity chip (`valid` with arm count and byte
  budget, or `incomplete` with the missing requirement). Blank fills the fields
  empty with one short comment per line as the hint. The user edits the YAML
  directly; there is no form.
- Install is a desktop native action with the same boundary as plugin install and
  status-line setup: native confirmation naming the repository and the file,
  writes only `.pomegr/experiments.yaml` into the working tree, never commits.
  Browser and LAN views can draft and copy the text but cannot install. Stop and
  edit go through the same path.
- At SessionStart on a `startup` matcher only (not resume, clear, or compact), the
  plugin hook validates the file, picks an arm with a cryptographic random choice
  and equal allocation, and emits the arm text as additional context **verbatim**:
  no marker line, no preamble, nothing that tells the model it is being measured.
  The control arm emits nothing. A resumed session keeps the arm it started with;
  it never re-rolls.
- Binding without a marker: the hook writes one bounded record to Pomegr's own data
  directory (never the repository, never provider configuration): normalized
  session ID from the hook's stdin, experiment ID, arm ID, arm content hash, and
  the local timestamp. The monitor matches the record by normalized session ID and
  binds the session once. It never reads the arm text and never persists it. A
  record for an unknown session, an unrecognized experiment, or a hash that does
  not match the revision's file is ignored.
- The Guidance tab shows the running experiment with its arms and session counts
  and splits the same friction, outcome, compliance, and rating signals by arm.
  Direction needs at least 15 sessions per arm; below that the numbers show with no
  direction. Stopping the experiment freezes its cohorts; they stay comparable to
  later revisions only as history.
- Every session under an experiment shows an **Experiment `<id>` · arm `<arm>`** chip
  in its header and Overview. Transparency lives in the UI, not in the model
  context.

Limits to state in the UI, in one quiet line: only additive instructions can be
tested, since the base files load in every arm; injected context sits after
`AGENTS.md`, so an arm is not identical to editing the file; subagents inherit the
session's arm through context, not through a second roll; compaction may drop the
injected text, and the session still counts in its arm; the model still sees the
text arrive as hook context rather than as a file.

## Privacy and contract invariants

- Guidance hashes, file contents, and absolute paths stay monitor-private. The
  browser receives the opaque revision ID, first-seen time, commit hash when known,
  and safe repository-relative changed paths validated by the repository-path
  validator. Provider configuration and transcript locations are rejected by that
  validator and never appear as changed paths.
- Skill names are bounded identifiers; skill arguments, skill file contents, hook
  commands, and policy content are never exposed.
- Compliance checks expose only the check name from the repository's own policy
  file and a three-value result. Matched command text never leaves the monitor.
- Ratings are user-authored local state. They never leave the machine, never enter
  reports, and are not agent signals.
- GETs serve committed cohort revisions only. Fingerprinting, binding, and cohort
  derivation run in the background under the existing observation phases.
- Nothing here is an AI judgment. The UI never uses the words score, quality, or
  performance for these numbers.
- Experiment bindings expose only the experiment identifier and arm identifier
  (both validated like the custom agent identifier). Arm text, the experiments
  file, arm hashes, allocation seeds, and the binding records stay in the plugin
  hook and the monitor and are never sent to the browser. Nothing about the
  experiment enters the model context except the arm text itself.
- `AGENTS.md` changes in task 2b: "Keep monitoring read-only" gains the sentence
  that the plugin SessionStart hook may inject repository-authored experiment arm
  text declared in `.pomegr/experiments.yaml`, verbatim and without a marker, that
  the desktop may write that one file after a native confirmation, and that the
  monitor and desktop still never write provider files or instruction files.

## Prerequisites

1. File-change history shipped per its approved contract (edit churn, compliance
   paths). Without it, those two signals stay unavailable and the rest still works.
2. Monitor SQLite store contributors for guidance revisions, session bindings,
   ratings, and cohort aggregates (Session 4 of the information architecture
   redesign plan).
3. Existing skill-usage evidence extended with per-invocation timestamps if the
   compliance evaluator needs ordering against file edits; the current count and
   latest timestamp may be enough for a first version.

## Work and verification

- [x] Task 0 — Design approval. Done 2026-09-22 on the design canvas. Decisions:
      Guidance is its own repository tab; default comparison is the newest
      revision against the previous two, any two selectable; rating lives on the
      session Overview; experiments use `.pomegr/experiments.yaml`, the card-plus-YAML
      composer, desktop native install, verbatim injection with no marker, and
      sidecar binding by session ID; both providers ship in the first version;
      the observation layer needs no plugin. See section 7 and the resolved
      decisions at the end.
- [ ] Task 1 — Guidance revision fingerprinting and session binding in the
      monitor, with checkpoint persistence and privacy tests. Update
      `docs/internal/architecture/observation-cache.md`. Verify: `npm run test:node`.
- [ ] Task 2 — Compliance-check table in `.pomegr/signals.md` (policy version
      bump, `pomegr:init` and `pomegr:doctor` awareness) and its evaluator over
      existing skill-usage, work-kind, and file-change evidence. Update
      `docs/internal/architecture/metrics.md` and the signal dictionary.
      Verify: `npm run test:node`, `/api/state` privacy serialization check.
- [ ] Task 2b — Experiments: `.pomegr/experiments.yaml` schema and validator in
      the plugin policy script, SessionStart arm selection and verbatim injection
      for Claude Code and Codex, binding record written to Pomegr's data directory,
      monitor record recognition and session binding, `pomegr:doctor` support,
      `AGENTS.md` boundary sentence, plugin policy version bump. Verify:
      `npm run test:node`, `claude plugin test ./plugins/claude-code`, tests that the injected context
      contains only the arm text, that the control arm emits nothing, and that
      unknown or hash-mismatched binding records are ignored.
- [ ] Task 2c — Composer and install: preset catalog (six Pomegr-authored samples
      with category), YAML editor with validity chip, desktop native install/stop
      action writing only `.pomegr/experiments.yaml` after confirmation, browser and
      LAN draft-only state. Verify: `npm run test:ui`, install unavailable from
      browser and LAN routes, no other file written.
- [ ] Task 3 — Per-session friction and outcome signals, computed at session
      commit and stored in the monitor store. Verify: `npm run test:node`.
- [ ] Task 4 — Cohort aggregation, comparison rules, any-two selector, per-arm
      split, regression flag, and the `/api/repository-guidance` committed GET. Verify: cache-only GET behavior,
      last-known-good retention, revision handling.
- [ ] Task 5 — User rating: monitor store table, same-origin write route limited
      to the three values and a normalized session ID, session page control.
      Verify: `npm run test:ui`, LAN write denied without pairing.
- [ ] Task 6 — Repository **Guidance** tab and session Overview line, design
      system samples, `DESIGN.md` update. Verify: `npm run test:ui`, contract test.
- [ ] Task 7 — Public guide in `docs/public/using-pomegr/`, index updates, delete
      this plan.

## Decisions

Resolved 2026-09-22 with the design approval:

1. Codex ships in the first version for revisions, checks, and experiments.
2. A dirty worktree still binds the session to a revision, with a null commit and
   the label "uncommitted when first seen".
3. Minimum cohort size of five is fixed.
4. Ratings live in the monitor store.
6. One running experiment per repository.

Still open, to settle during implementation without blocking task 1:

5. Whether a guidance change while a session is running is surfaced on that session
   as **guidance changed mid-session**, with no retagging. Proposal: yes, one quiet
   line on Details.
7. Phone layout for the Guidance tab and the composer; the composer is desktop-only
   for install, so phone may show the drawings' read-only state.
