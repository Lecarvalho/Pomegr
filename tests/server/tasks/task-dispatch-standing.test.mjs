import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_DISPATCH_UNBOUND_TTL_MS, dispatchStanding, isLive, parseStoredDispatch,
} from "../../../server/tasks/task-dispatch-standing.mjs";

const DIGEST = "ab".repeat(32);
const MINTED = 1_800_000_000_000;
const stored = (mintedAt = MINTED) => `${DIGEST}:${mintedAt}`;

test("a stored dispatch parses to its digest and mint time, and anything else parses to null", () => {
  assert.deepEqual(parseStoredDispatch(stored()), { digest: DIGEST, mintedAt: MINTED });
  for (const value of [null, undefined, 7, {}, "", "x", DIGEST, `${DIGEST}:`, `${DIGEST}:-1`, `${DIGEST}:1.5`, `${DIGEST}:${"9".repeat(17)}`,
    `${"AB".repeat(32)}:${MINTED}`, `${"ab".repeat(31)}:${MINTED}`, `${stored()} `, ` ${stored()}`]) {
    assert.equal(parseStoredDispatch(value), null, String(value));
  }
});

test("a dispatch is live from its mint until the ten minutes it waits for its session run out", () => {
  assert.equal(TASK_DISPATCH_UNBOUND_TTL_MS, 10 * 60 * 1000);
  const parsed = parseStoredDispatch(stored());
  assert.equal(isLive(parsed, MINTED), true);
  assert.equal(isLive(parsed, MINTED + TASK_DISPATCH_UNBOUND_TTL_MS - 1), true);
  assert.equal(isLive(parsed, MINTED + TASK_DISPATCH_UNBOUND_TTL_MS), false);
  // A mint time ahead of the clock was not written by this dispatcher's clock: it is not live.
  assert.equal(isLive(parsed, MINTED - 1), false);
  assert.equal(isLive(null, MINTED), false);
});

test("dispatchStanding is none, live, or expired, and a value no dispatch could have written is expired", () => {
  assert.equal(dispatchStanding(null, MINTED), "none");
  assert.equal(dispatchStanding(undefined, MINTED), "none");
  assert.equal(dispatchStanding(stored(), MINTED), "live");
  assert.equal(dispatchStanding(stored(), MINTED + TASK_DISPATCH_UNBOUND_TTL_MS - 1), "live");
  assert.equal(dispatchStanding(stored(), MINTED + TASK_DISPATCH_UNBOUND_TTL_MS), "expired");
  assert.equal(dispatchStanding(stored(), MINTED - 1), "expired");
  for (const value of ["", "garbage", DIGEST, `${DIGEST}:-1`, 7]) {
    assert.equal(dispatchStanding(value, MINTED), "expired", String(value));
  }
});
