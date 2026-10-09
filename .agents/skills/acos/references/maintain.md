# Init, calibrate, save-preset

## Init: derive `config.yaml`

Never overwrite an existing `config.yaml` without asking. Shape:
`config.example.yaml`.

1. **verify.** The command the repo's docs tell contributors to run.
   Look in `package.json` scripts (`test`, `check`, `verify`, `lint`),
   `Makefile`, `pyproject.toml`/`tox.ini`/`pytest.ini`, `Cargo.toml`,
   `go.mod`, `build.gradle`, `*.csproj`, CLAUDE.md, README. Several:
   chain with `&&`, lint, build, test.
2. **shot.** `node <skill folder>/scripts/shot.mjs` for a web interface,
   the project's own capture command for another visible surface, no key
   when there is none.
3. **provider.** The one whose `harness` in `catalog/providers.yaml` is
   the harness this session runs in. No model ids, no `stages`
   overrides. The other providers are reachable only as `external`, and
   only those whose CLI (`claude`, `codex`, `gemini`, `ollama`) exists.
   Say which alias each tier maps to.
4. **Defaults.** No `preset`. `gates.go: required`. `limits`:
   `orchestrator_tokens: 120000`, `worker_context_tokens: 200000`,
   unless the user gave others.
5. **startup**, what a session holds before reading any code:
   - Measured: ask the user to run `/context` (or the harness's
     equivalent) in a fresh session and paste the total and breakdown.
   - Otherwise estimated: characters / 4 over CLAUDE.md and its imports,
     listed skill descriptions, agent definitions and configured MCP tool
     schemas, plus 20000 for the harness. `subagent`: the same minus
     conversation, MCP and skill list; 25000 when unknown.
   - Write `orchestrator`, `subagent` and `basis` (date and method). Tell
     the user to re-run init after adding an MCP server, skill or memory
     file.
6. **Report** one line per field. Ask only when verify is a guess or
   startup needs a paste, both in one message.

## Calibrate: learn from past runs

Own session, never during a task. Fewer than two runs: say so and stop.

1. **Collect** every `runs/*/` with `manifest.yaml`: the manifest,
   `log.yaml`, `plan.yaml` for plans (each part is a run). No log: planned
   only.
2. **Fill tokens only from measurement**, e.g. a session monitor's usage
   query over the log's `sessions` and stage times. Never read an
   estimate as an actual.
3. **Derive per run:** size (log `actual`), stages planned vs executed,
   tiers and efforts planned vs used (delegated only), iterations,
   adapters and agents, reserved vs measured tokens by lane and class,
   lanes over their limit, workers suggested by the plan vs settled at
   the start (the `strategy` drift entries), measured worker tokens
   against the 170k target, wall time per stage and part, gaps between
   parts. For plans: how many parts, and whether they came out too big or
   too small.
4. **Find patterns across runs:**
   - stages usually dropped or added, checks changed the same way;
   - estimate misses; the same miss on every part, same direction, means
     `startup` is stale: in Recurring drift, name its `basis` date and
     say re-run init;
   - files owned by two parts or read by three: the cut ran along layers,
     and what the re-reads cost;
   - per-unit figures sizing needs: tokens per file inline, fixed + per
     file per worker, review cost, first-time review failure rate;
   - per model id, not only per tier: when a tier's id changed, say so in
     Cost, keep the current id's figures and mark older ones, never
     average across;
   - how often `balanced` implementers pass first time and how often you
     finished a slice; worse than one in three means `strong`
     implementers or smaller slices;
   - one more part vs one more worker, and whether fan-out and parallel
     parts saved time.
5. **Write `calibration.md`**, under 40 lines, overwriting: a header
   (run count, date range, today), then **Shape**, **Cost**, **Recurring
   drift** (each config fix names its file), **Notes** (keep old entries
   still true).
6. **Report** the path and one line per section. Change nothing else;
   suggest config, block or preset changes under Recurring drift.

## Save-preset

Take the last run (this session's, or the newest under `runs/`): its
manifest with the log's drift applied. Strip `id`, `intent`, `part`,
`scope`, `estimate`, `outputs` and every concrete `model` (keep `tier`).
Verify command becomes `{{ project.verify }}`. Keep adapters, checks,
`on_fail`, escalation, loop, gates, and effort on delegated stages only.
Add `name` and a one-line `description`. Write `presets/<name>.yaml`
(never overwrite without asking); report the path and stage list in one
line.
