-- A server's committed-response token issuance is the reference, not provider arrival.
-- Browser clocks are aligned only with a measured request-interval uncertainty.
WITH served AS (
  SELECT EXTRACT_ARG(arg_set_id, 'args.revision') AS revision, min(ts) AS issued_at
  FROM slice WHERE name = 'cache_serve'
    AND EXTRACT_ARG(arg_set_id, 'args.revision') IS NOT NULL GROUP BY revision
), completed AS (
  SELECT name, EXTRACT_ARG(arg_set_id, 'args.surface') AS surface,
    EXTRACT_ARG(arg_set_id, 'args.revision') AS revision,
    ts + dur AS ended_at,
    EXTRACT_ARG(arg_set_id, 'args.clockErrorUs') * 1000 AS error_ns
  FROM slice WHERE name IN ('renderer_fetch', 'renderer_react_commit', 'renderer_next_frame')
    AND dur >= 0 AND EXTRACT_ARG(arg_set_id, 'args.clock') = 'request_interval_bound'
    AND EXTRACT_ARG(arg_set_id, 'args.outcome') != 'incomplete'
)
SELECT completed.name, surface, count(*) AS samples,
  percentile(max(0, ended_at - issued_at - error_ns), 50) AS p50_lower_ns,
  percentile(max(0, ended_at - issued_at + error_ns), 50) AS p50_upper_ns,
  percentile(max(0, ended_at - issued_at - error_ns), 95) AS p95_lower_ns,
  percentile(max(0, ended_at - issued_at + error_ns), 95) AS p95_upper_ns,
  max(error_ns) AS max_error_ns
FROM completed JOIN served USING (revision)
GROUP BY completed.name, surface ORDER BY surface, completed.name;
