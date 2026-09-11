-- Causal edges imported from capture-local flow IDs. No arbitrary arguments.
-- An edge joins slices; this is not an end-to-end browser latency measurement.
SELECT upstream.name AS upstream, downstream.name AS downstream,
  count(*) AS samples,
  max(max(0, downstream.ts - (upstream.ts + upstream.dur))) AS max_gap_ns
FROM flow JOIN slice upstream ON upstream.id = flow.slice_out
JOIN slice downstream ON downstream.id = flow.slice_in
WHERE upstream.dur >= 0 AND downstream.dur >= 0
GROUP BY upstream.name, downstream.name ORDER BY max_gap_ns DESC LIMIT 32;
