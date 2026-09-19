# Compiling an ACOS manifest to a Claude Code Workflow script

This reference is Claude Code only. Use it only when the active harness is
Claude and the active provider is Anthropic. Codex does not support Workflow:
the runner composes equivalent independent native subagent stages instead, and
rejects a pre-existing Codex manifest that names `adapter: workflow` before GO.
Load the `workflow-authoring` skill before writing the script; its API
reference wins over anything here if they disagree.

## Opt-in

The Workflow tool runs only on explicit user opt-in. In ACOS that opt-in
is the GO reply on a manifest that shows `adapter: workflow`. The stage
summary printed before GO names the adapter and the script path, so the
user has seen and approved the workflow. If the user changes a stage away from `workflow` before GO,
no workflow runs. Never switch a stage *to* `workflow` after GO.

## When to compile

1. Confirm the active profile is Claude/Anthropic. Then walk the stage list.
   Group maximal runs of consecutive stages whose
   adapter is `workflow`. Each group becomes one **segment**.
2. A stage with `gate: true`, or `gates.per_stage: true`, ends the
   segment before it. Gates need the orchestrator, not the script.
3. A stage whose `on_fail` is `ask` may sit inside a segment; the script
   returns early with `status: "ask"` and the orchestrator takes over.
4. Stages with other adapters run by the orchestrator between segments,
   as usual.

Write each segment to `runs/<id>/workflow-<n>.js` **before** presenting
the manifest, so the user can open it. Mention the path in the header
above the manifest. Do not run it until GO.

## Mapping

| Manifest | Script |
|----------|--------|
| segment | one script, `meta.phases` = one entry per stage in it |
| stage | `agent(prompt, {label: stage.name, phase: stage.name, ...})` |
| `provider` / `model` | `model` option, harness alias (`opus`, `sonnet`, `haiku`). Omit when the model equals the session model. Non-native providers cannot run in a workflow: compose error before GO. |
| `effort` | `effort` option: low, medium, high, max, unchanged |
| `inputs` | previous agents' return values, interpolated into the prompt |
| `outputs` | the agent's return value, kept in a `artifacts` object and returned at the end |
| `check.kind: command` | one extra low-effort agent per iteration: runs the command, returns `{pass, output}` via schema. The script has no shell access itself. |
| `check.kind: review` | schema on the review agent: `{verdict: "PASS" \| "FAIL", findings}` |
| `check.kind: none` | no check agent |
| `on_fail: retry` + `max_iterations` | `for` loop around the stage agent, check output appended to the prompt |
| `on_fail: escalate` + `escalation` | same loop; `model`/`effort` taken from `escalation[i-1]`, last entry reused when exhausted |
| `on_fail: ask` | `return {status: "ask", stage, output, artifacts}` |
| `on_fail: stop` | `return {status: "failed", stage, output, artifacts}` |
| stages with no input dependency on each other | `parallel([...])` in one phase. Each gets its own `phase` option. |
| `gate: true` | segment boundary, never inside a script |
| `scope.notes`, `intent` | passed in via `args`, interpolated into every prompt |

Concrete artifacts from earlier non-workflow stages go in via `args`
too. Keep `args` small; if an artifact is over about 400 lines, write it
to `runs/<id>/artifacts/<name>.md` and pass the path.

## Template: plan-build-review as one segment

Invocation from the orchestrator, after GO:

```
Workflow({
  scriptPath: "runs/<id>/workflow-1.js",
  args: {
    intent: "<intent>",
    scopeNotes: "<scope.notes or empty>",
    verify: "pnpm build && pnpm test",
    artifacts: {}            // outputs of earlier inline/subagent stages
  }
})
```

Script:

```js
export const meta = {
  name: 'acos-plan-build-review',
  description: 'ACOS run: explore, plan, implement with escalation, review',
  phases: [
    { title: 'explore' },
    { title: 'plan' },
    { title: 'implement' },
    { title: 'review' },
  ],
}

// ---- constants compiled from the manifest ---------------------------
const INTENT = args.intent
const SCOPE = args.scopeNotes || ''
const VERIFY = args.verify
const artifacts = { ...(args.artifacts || {}) }

const IMPLEMENT_MAX = 3
const IMPLEMENT_ESCALATION = [
  { model: 'sonnet', effort: 'medium' },   // iteration 1: manifest model
  { model: 'opus',   effort: 'high'   },   // iteration 2+: escalation[0]
]

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    output: { type: 'string', description: 'shortest decisive lines' },
  },
  required: ['pass', 'output'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'findings'],
}

const header = (role) => `${role}

Intent: ${INTENT}
${SCOPE ? 'Scope notes: ' + SCOPE : ''}
`

// ---- explore --------------------------------------------------------
artifacts.context = await agent(header(`You are the explorer. Do not modify any file.
Find what the intent touches: relevant files, conventions, verify command, risks.
Under 40 lines. No code dumps.`), { label: 'explore', phase: 'explore', model: 'haiku', effort: 'low' })

// ---- plan -----------------------------------------------------------
artifacts.plan = await agent(header(`You are the planner. Do not modify any file.
Produce numbered steps naming files, what done means per step, the verify
command, and what is out of scope.

Context from explore:
${artifacts.context}`), { label: 'plan', phase: 'plan', effort: 'high' })

// ---- implement, loop with escalation --------------------------------
let implementPassed = false
let lastCheck = ''
for (let i = 0; i < IMPLEMENT_MAX; i++) {
  const ref = IMPLEMENT_ESCALATION[Math.min(i, IMPLEMENT_ESCALATION.length - 1)]
  log(`implement iteration ${i + 1}/${IMPLEMENT_MAX} on ${ref.model}/${ref.effort}`)

  artifacts.diff = await agent(header(`You are the implementer. Follow the plan exactly.
Touch only the files the plan names. Run \`${VERIFY}\` before finishing.
Do not commit. End with: files changed, what changed, verify summary.

Plan:
${artifacts.plan}
${lastCheck ? '\nPrevious attempt failed the check with:\n' + lastCheck : ''}`),
    { label: `implement#${i + 1}`, phase: 'implement', model: ref.model, effort: ref.effort })

  const check = await agent(`Run exactly this command from the repo root and report:
\`${VERIFY}\`
pass = exit code 0. output = the shortest lines that decide it.`,
    { label: `check#${i + 1}`, phase: 'implement', effort: 'low', schema: CHECK_SCHEMA })

  if (check && check.pass) { implementPassed = true; break }
  lastCheck = check ? check.output : 'check agent returned nothing'
}
if (!implementPassed) {
  return { status: 'failed', stage: 'implement', output: lastCheck, artifacts }
}

// ---- review ---------------------------------------------------------
const review = await agent(header(`You are the reviewer. Do not modify any file.
Compare the working tree diff against the plan and the intent.
verdict FAIL only for blockers. Findings one line each, severity-tagged.

Plan:
${artifacts.plan}

Implementer report:
${artifacts.diff}`), { label: 'review', phase: 'review', model: 'opus', effort: 'high', schema: REVIEW_SCHEMA })

artifacts.review = review
if (!review || review.verdict !== 'PASS') {
  // manifest on_fail: ask -> hand back to the orchestrator
  return { status: 'ask', stage: 'review', output: review ? review.findings.join('\n') : 'no review', artifacts }
}

return { status: 'success', artifacts }
```

## After the script returns

The orchestrator reads `status`:

| status | action |
|--------|--------|
| `success` | log each stage from `artifacts`, continue to the next segment or stage |
| `failed` | run ends, report the stage and output |
| `ask` | show `output`, ask the user: retry (re-invoke with `resumeFromRunId` after editing the script or prompt), skip, stop |

Log one stage record per stage in the segment. Token counts come from
the workflow result if it reports them; otherwise leave them out. Record
`adapter_used: workflow` and the run id the tool returned.

## Constraints to remember

- No `Date.now()`, `Math.random()`, `new Date()` in scripts. Timestamps
  go in the log after the script returns.
- No filesystem access from the script. Anything that must read or run
  goes through an agent.
- `parallel()` never rejects; failed thunks come back `null`. Filter.
- Concurrency is capped by the harness. Passing many items is fine.
- The script is JavaScript, not TypeScript.
