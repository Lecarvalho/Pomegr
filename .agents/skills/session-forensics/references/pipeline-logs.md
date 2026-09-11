# Diagnose live delays from continuous logs

The [pipeline contract](../../../../docs/PIPELINE_OPERATIONS.md) owns record fields,
privacy, rotation, units, and limitations. Development automatically appends JSONL
under ignored `outputs/pipeline-logs/`; files survive restart until bounded rotation.

For a reported past delay, analyze the retained interval immediately:

```powershell
npm run diagnostics:logs -- --since 5m --json
```

Use ISO `--since`/`--until` timestamps to narrow a known interval. `--input` accepts a
particular file and `--directory` a locally preserved set. Preserve relevant files
before rotation when an investigation requires stable evidence. No capture, save
command, viewer installation, native processor, or monitor connection is required.
Use `--follow` to watch new validated records, including across file rotation.

Read coverage before timings: oldest/newest observations, malformed or partial lines,
gaps, pending starts, and bounded aggregation. Missing prior history is unavailable;
do not reconstruct it from a later snapshot or infer a successful completion.

Start with health failures for stalled readiness: fixed publication/acquisition stage,
failure reason, validation field, and rejection/publication counters. For latency,
inspect queue ages, acquisition, history, derivation, publication, and renderer spans.
Follow recorded anonymous correlations, never an invented association to a named session.

Durations overlap. Quantiles are bounded estimates; state sample counts and limitations.
Clock-bounded renderer durations do not prove paint or source-to-pixel latency. Test a
suspected cause with a controlled reproduction and compare equivalent workloads.

Report the measured bottleneck or evidence gap, the supporting stage/failure field,
retained interval, and next discriminating check. Local artifact links are acceptable.
Never expose raw content, source paths, credentials, identities, private maps, or raw
errors. Upload nothing to a hosted service. Read-only log analysis never triggers work
in Pomegr or the coding provider.
