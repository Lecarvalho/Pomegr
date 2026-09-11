-- Only fixed aggregate resource/queue counters, never arbitrary track names.
WITH expected(name) AS (
  SELECT 'queue_depth' UNION ALL SELECT 'oldest_pending_ms'
  UNION ALL SELECT 'active' UNION ALL SELECT 'capacity'
  UNION ALL SELECT 'cpu' UNION ALL SELECT 'memory'
  UNION ALL SELECT 'event_loop_ms' UNION ALL SELECT 'bytes' UNION ALL SELECT 'records'
)
SELECT expected.name, count(counter.value) AS samples,
  min(counter.value) AS minimum, max(counter.value) AS maximum,
  avg(counter.value) AS mean, sum(counter.value) AS total
FROM expected LEFT JOIN counter_track ON counter_track.name = expected.name || ' value'
LEFT JOIN counter ON counter.track_id = counter_track.id
GROUP BY expected.name ORDER BY expected.name;
