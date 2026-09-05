import assert from "node:assert/strict";
import { WORK_KINDS } from "../../monitor/work-kind.mjs";

export function assertRequestWork(work, association, expectedAssociation) {
  assert.equal(Array.isArray(work) && work.length <= 8, true);
  assert.equal(association, work.length > 0 ? expectedAssociation : null);
  for (const tally of work) {
    assert.deepEqual(Object.keys(tally).sort(), ["count", "kind"]);
    assert.equal(WORK_KINDS.includes(tally.kind), true);
    assert.equal(Number.isSafeInteger(tally.count) && tally.count >= 1 && tally.count <= 999, true);
  }
}
