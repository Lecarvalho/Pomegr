import assert from "node:assert/strict";
import test from "node:test";
import { arilFollowUpPayload, arilFollowUpTarget, arilFollowUpText, normalizeArilFollowUpData } from "../../../shared/aril-follow-up.mjs";
import { nativeNotificationPayload, normalizeNativeNotificationSnapshot } from "../../../desktop/runtime/notifications.mjs";
import { deriveArilFollowUps } from "../../../server/notifications/aril-follow-up-notifications.mjs";
import { createNotificationLedger } from "../../../server/notifications/notification-ledger.mjs";
import { normalizeNotificationPersistence } from "../../../server/notifications/notification-persistence.mjs";

// Grant follow-ups (T-183): the fixed line, its public data allowlist, and its notification occurrence.
const REPO = `repo-${"b".repeat(24)}`;
const scope = "c".repeat(64);
const at = "2026-10-26T12:00:00.000Z";
const item = (kind, task, provider = null) => ({ kind, task, provider });
const facts = (items, { more = 0, ended = null } = {}) => ({ items, more, ended });
const followUp = (overrides = {}) => ({ repositoryId: REPO, key: `${REPO}:3:41`, conversationId: "chat-0123456789ab", messageId: "m-2",
  items: [item("grant_merge", "T-5")], more: 0, ended: null, at, ...overrides });

test("a merge burst reads as one line with the task IDs and what comes next", () => {
  assert.equal(arilFollowUpText(facts([item("grant_merge", "T-5"), item("grant_branch_deleted", "T-5"), item("grant_start", "T-6")])),
    "Merged T-5, deleted the branch of T-5, and started T-6. Nothing needs you yet.");
  assert.equal(arilFollowUpText(facts([item("review_passed", "T-5"), item("grant_merge_auto", "T-5")])), "T-5 passed review and turned on auto-merge for T-5. Nothing needs you yet.");
});

test("a refusal names the task that needs the owner", () => {
  assert.equal(arilFollowUpText(facts([item("grant_merge_refused", "T-7")])), "Could not merge T-7. T-7 needs you.");
  assert.equal(arilFollowUpText(facts([item("grant_branch_delete_refused", "T-7"), item("review_failed", "T-8")])), "Could not delete the branch of T-7 and T-8 failed review. T-7 and T-8 need you.");
  assert.equal(arilFollowUpText(facts([item("review_failed", "T-8"), item("sent_back", "T-8")])), "T-8 failed review and sent T-8 back to its builder. Nothing needs you yet.", "a failed review sent back needs nobody");
});

test("a usage hold says which starts wait, and a resume clears it", () => {
  assert.equal(arilFollowUpText(facts([item("grant_usage_hold", null, "claude")])), "Held new Claude starts at the usage limit. New Claude starts wait until usage is below the limit.");
  assert.equal(arilFollowUpText(facts([item("grant_usage_hold", null, "codex"), item("grant_usage_resume", null, "codex")])), "Held new Codex starts at the usage limit and resumed Codex starts. Nothing needs you yet.");
});

test("a grant end is said with its reason, alone or after the burst, and stays within the notification body", () => {
  assert.equal(arilFollowUpText(facts([], { ended: "expired" })), "The grant ended because its time ran out.");
  assert.equal(arilFollowUpText(facts([item("grant_merge_refused", "T-9")], { ended: "tasks_used" })), "Could not merge T-9. The grant ended because it used all its tasks, and T-9 needs you.");
  const long = arilFollowUpText(facts(Array.from({ length: 8 }, (_, index) => item("grant_branch_delete_refused", `T-12345678${index}`)), { more: 900, ended: "app_restart" }));
  assert.ok(long.length <= 200, long);
  assert.match(long, /^Could not delete the branch of T-123456780, could not delete the branch of T-123456781, could not delete the branch of T-123456782, and 905 more updates\./u);
});

test("the public data is an exact allowlist and its target is the repository's own chat", () => {
  const data = { repositoryId: REPO, conversationId: "chat-0123456789ab", messageId: "m-2", ...facts([item("grant_start", "T-1")]) };
  assert.deepEqual(normalizeArilFollowUpData("aril_follow_up", null, data), data);
  assert.equal(arilFollowUpTarget(data), `/tasks?repository=${REPO}&aril=chat-0123456789ab&message=m-2`);
  assert.equal(arilFollowUpTarget({ ...data, conversationId: null, messageId: null }), `/tasks?repository=${REPO}&aril=open`);
  for (const bad of [{ ...data, text: "x" }, { ...data, repositoryId: "repo-x" }, { ...data, conversationId: null }, { ...data, items: [] },
    { ...data, items: [item("grant_start", "T-1", "claude")] }, { ...data, items: [item("grant_usage_hold", "T-1", "claude")] }, { ...data, items: [item("merged", "T-1")] },
    { ...data, items: [item("grant_start", "../x")] }, { ...data, more: 1 }, { ...data, ended: "crashed" }, { ...data, messageId: "m-0" }]) {
    assert.equal(normalizeArilFollowUpData("aril_follow_up", null, bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeArilFollowUpData("aril_follow_up", "claude", data), null);
  assert.equal(arilFollowUpPayload({ kind: "needs_input", provider: null, data }), null);
});

test("a settled follow-up is one native-eligible occurrence that persists and restores without replay", () => {
  const ledger = createNotificationLedger({ now: () => Date.parse(at) });
  ledger.acceptFacts({ arilFollowUps: { revision: 1, followUps: [followUp(), followUp({ key: "bad" }), followUp({ repositoryId: "repo-x" })], sourceScope: scope } });
  const [row, ...others] = ledger.readSnapshot().occurrences;
  assert.equal(others.length, 0);
  assert.deepEqual({ kind: row.kind, category: row.category, priority: row.priority, action: row.action, provider: row.provider, lifecycle: row.lifecycle, deliveryEligible: row.deliveryEligible },
    { kind: "aril_follow_up", category: "aril", priority: 50, action: "open_aril_chat", provider: null, lifecycle: "resolved", deliveryEligible: true });
  assert.equal(nativeNotificationPayload(normalizeNativeNotificationSnapshot(ledger.readSnapshot()).occurrences[0]).body, "Merged T-5. Nothing needs you yet.");
  const saved = { version: 1, profileScope: scope, ...ledger.exportState() };
  const restored = normalizeNotificationPersistence(saved, scope, Date.parse(at));
  assert.ok(restored);
  const fresh = createNotificationLedger({ now: () => Date.parse(at) });
  fresh.restore(restored.state);
  assert.deepEqual(fresh.readSnapshot().occurrences.map((entry) => entry.id), [row.id]);
  for (const mutate of [(value) => { value.snapshot.occurrences[0].data.text = "x"; }, (value) => { value.snapshot.occurrences[0].provider = "claude"; },
    (value) => { value.snapshot.occurrences[0].category = "attention"; }, (value) => { value.evidence[0][0] = value.evidence[0][0].replace(/:41$/u, ":x"); }]) {
    const bad = structuredClone(saved); mutate(bad);
    assert.equal(normalizeNotificationPersistence(bad, scope, Date.parse(at)), null);
  }
  assert.deepEqual(deriveArilFollowUps({ followUps: [followUp({ at: "yesterday" })] }).items, []);
});
