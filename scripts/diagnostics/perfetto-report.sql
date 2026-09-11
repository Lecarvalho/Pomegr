-- Fixed, local-only report for Pomegr's monitor-private pipeline trace.
-- Perfetto slice durations are nanoseconds. Keep this query free of trace content.
WITH expected(name) AS (
  SELECT 'source_notification'
  UNION ALL SELECT 'catalog_discovery'
  UNION ALL SELECT 'source_queue'
  UNION ALL SELECT 'source_preparation'
  UNION ALL SELECT 'acquisition_normalization'
  UNION ALL SELECT 'catalog_commit_wait'
  UNION ALL SELECT 'catalog_projection'
  UNION ALL SELECT 'session_commit_wait'
  UNION ALL SELECT 'session_derivation'
  UNION ALL SELECT 'normalized_store_commit'
  UNION ALL SELECT 'candidate_to_commit'
  UNION ALL SELECT 'history_read'
  UNION ALL SELECT 'history_publish'
  UNION ALL SELECT 'history_contribution'
  UNION ALL SELECT 'checkpoint'
  UNION ALL SELECT 'revision_notify'
  UNION ALL SELECT 'cache_serve'
  UNION ALL SELECT 'renderer_event'
  UNION ALL SELECT 'renderer_fetch'
  UNION ALL SELECT 'renderer_react_commit'
  UNION ALL SELECT 'renderer_next_frame'
  UNION ALL SELECT 'calibration'
  UNION ALL SELECT 'benchmark_source'
  UNION ALL SELECT 'visible_row'
)
SELECT
  expected.name,
  count(slice.name) AS span_count,
  coalesce(sum(slice.dur), 0) AS stage_dur_ns,
  percentile(CASE WHEN slice.dur >= 0 AND coalesce(EXTRACT_ARG(slice.arg_set_id, 'args.outcome'), '') != 'incomplete' THEN slice.dur END, 50) AS p50_ns,
  percentile(CASE WHEN slice.dur >= 0 AND coalesce(EXTRACT_ARG(slice.arg_set_id, 'args.outcome'), '') != 'incomplete' THEN slice.dur END, 95) AS p95_ns,
  coalesce(max(slice.dur), 0) AS stage_max_ns,
  sum(CASE WHEN EXTRACT_ARG(slice.arg_set_id, 'args.outcome') = 'incomplete' OR slice.dur < 0 THEN 1 ELSE 0 END) AS incomplete_count,
  sum(CASE WHEN EXTRACT_ARG(slice.arg_set_id, 'args.outcome') IN ('failed', 'rejected') THEN 1 ELSE 0 END) AS failure_count,
  (SELECT count(*) FROM slice) AS slice_count,
  coalesce((SELECT sum(dur) FROM slice), 0) AS total_dur_ns,
  coalesce((SELECT max(dur) FROM slice), 0) AS max_dur_ns,
  (SELECT int_value FROM __intrinsic_metadata WHERE name = 'json_metadata.version') AS trace_schema_version
FROM expected
LEFT JOIN slice ON slice.name = expected.name
GROUP BY expected.name
ORDER BY expected.name;
