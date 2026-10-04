import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeModelObservation } from "../../../../server/providers/claude/model-observation.mjs";

test("Claude subscription catalog and entitlement stay unavailable without any acquisition", async () => {
  const reader = createClaudeModelObservation();
  assert.deepEqual(await reader.read(), { provider: "claude", status: "unavailable", complete: false,
    observedAt: null, sourceScope: null, models: [] });
  assert.deepEqual(reader.capabilities, { clientCatalog: "unavailable", accountEntitlement: "unavailable",
    announcement: "unavailable", deprecation: "unavailable" });
});
