import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryContributionPublisher } from "../monitor/history-contribution-publisher.mjs";

test("a newer disjoint suffix cannot overtake a failed predecessor", async () => {
  const jobs = [];
  const accepted = [];
  let calls = 0;
  const owner = createHistoryContributionPublisher({ isActive: () => true,
    schedule: (task) => { jobs.push(task); return task; }, cancel() {},
    store: { async publishRequestContribution(_id, contribution) {
      calls += 1;
      if (calls === 1) throw new Error("synthetic storage interruption");
      accepted.push(contribution); return {};
    } },
  });
  await owner.publish("requests", "codex:synthetic", { epoch: 1, sequence: 1, requests: [{ id: "one" }], activity: [{ id: "call-one" }] });
  await owner.publish("requests", "codex:synthetic", { epoch: 1, sequence: 2, requests: [{ id: "two" }], activity: [{ id: "call-two" }] });
  assert.equal(calls, 1);
  assert.equal(jobs.length, 1);
  jobs.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(accepted[0].requests.map((item) => item.id), ["one", "two"]);
  assert.deepEqual(accepted[0].activity.map((item) => item.id), ["call-one", "call-two"]);
  assert.equal(accepted[0].sequence, 2);
  assert.equal(owner.busy(), false);
  owner.stop();
});

test("shutdown fences in-flight failures from scheduling retries in a later lifetime", async () => {
  let reject;
  const jobs = [];
  const owner = createHistoryContributionPublisher({ isActive: () => true,
    schedule: (task) => { jobs.push(task); return task; },
    store: { publishActivityContribution() { return new Promise((_resolve, fail) => { reject = fail; }); } },
  });
  const work = owner.publish("activity", "codex:synthetic", { epoch: 1, sequence: 1, activity: [] });
  await Promise.resolve(); owner.stop(); reject(new Error("synthetic")); await work;
  assert.equal(jobs.length, 0);
});
