import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The request handler reads these lookups from the monitor runtime with an optional call, so a missing
// one fails quietly: an agent task write answers unavailable and no session can be started.
test("the monitor runtime forwards every task lookup the request handler reads", () => {
  const handler = readFileSync(new URL("../../../server/serving/request-handler.mjs", import.meta.url), "utf8");
  const monitor = readFileSync(new URL("../../../server/server.mjs", import.meta.url), "utf8");
  const read = new Set([...handler.matchAll(/runtime\.(resolve(?:Task|Run)[A-Za-z]+)/gu)].map((match) => match[1]));
  assert.deepEqual([...read].sort(), ["resolveRunModels", "resolveTaskCheckFacts", "resolveTaskSession", "resolveTaskSessionFacts", "resolveTaskStart"]);
  for (const name of read) assert.match(monitor, new RegExp(`\\b${name}: observation\\.${name}\\b`, "u"), name);
});
