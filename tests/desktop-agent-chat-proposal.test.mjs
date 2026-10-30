import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOperations,
  BOARD_COLUMNS,
  BOARD_OPERATIONS,
  IMAGE_OPERATION,
  IMAGES_PER_OPERATION,
  LEGACY_MEMORY_OPERATIONS,
  extractProposal,
  normalizeOperation,
  normalizeProposal,
  PROPOSAL_FENCE,
  PROPOSAL_OPERATION_LIMIT,
  PROPOSAL_SUMMARY_LIMIT,
  visibleAnswer,
} from "../desktop/runtime/agent-chat-proposal.mjs";

const fence = (body) => `\`\`\`${PROPOSAL_FENCE}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;
const goodProposal = { summary: "Add one task", operations: [{ op: "create_task", text: "Write the plan" }] };

test("rework declarations are bounded, exact, separate from Apply, and forbidden in grant writes", async () => {
  const link = { op: "declare_rework", fix: "T-12", reworks: "#336", cause: "missed_wiring" };
  for (const cause of ["missed_wiring", "spec_gap", "wrong_behavior", "stale_instructions", "latent", "other"]) {
    assert.deepEqual(normalizeOperation({ ...link, cause }), { ...link, cause });
  }
  for (const fields of [{ cause: "unknown" }, { reworks: "T-12" }, { fix: "#0" }, { fix: "#9007199254740992" }, { declaredBy: "aril" }]) {
    assert.equal(normalizeOperation({ ...link, ...fields }), null);
  }
  const proposal = (operations) => ({ summary: "Record the fix", operations });
  assert.deepEqual(normalizeProposal(proposal([link])), proposal([link]));
  for (const other of [{ op: "create_task", text: "Check wiring" },
    { op: "start_session", id: "T-1" }, { op: "set_queue", on: true }, { op: "set_aril_settings", settings: {} }, { op: "remove_worktree", id: "T-1", branch: false }]) {
    assert.deepEqual(normalizeProposal(proposal([link, other])), proposal([link, other]));
  }
  assert.ok(normalizeProposal(proposal(Array(5).fill(link))));
  assert.equal(normalizeProposal(proposal(Array(6).fill(link))), null);
  assert.equal(normalizeProposal(proposal([link]), { grantWrite: true }), null);
  assert.equal(normalizeProposal(proposal([{ op: "create_task", text: "Fix" }, link]), { grantWrite: true }), null);
  assert.deepEqual(await applyOperations([link], { post: () => assert.fail("declarations never use Apply"), board: {} }), [{ ok: false, error: "unsupported" }]);
});

test("the proposal contract constants are fixed", () => {
  assert.equal(PROPOSAL_FENCE, "pomegr-board");
  assert.equal(PROPOSAL_OPERATION_LIMIT, 40);
  assert.equal(PROPOSAL_SUMMARY_LIMIT, 300);
  assert.deepEqual([...BOARD_OPERATIONS], ["create_feature", "update_feature", "delete_feature", "create_task", "update_task", "delete_task", "move_task", "queue_task", "unqueue_task", "group_tasks", "ungroup_tasks", "set_after", "attach_images", "start_session", "set_queue", "set_aril_settings", "add_memory", "update_memory", "remove_memory", "remove_worktree", "declare_rework"]);
  assert.equal(IMAGES_PER_OPERATION, 4);
  assert.equal(IMAGE_OPERATION, "attach_images");
  assert.deepEqual([...BOARD_COLUMNS], ["Backlog", "Ready", "In progress", "Review", "Done"]);
});

test("every operation is accepted in its minimal form and kept as written", () => {
  const accepted = [
    [{ op: "create_feature", name: "Auth" }, { op: "create_feature", name: "Auth" }],
    [{ op: "update_feature", feature: "Auth", done: true }, { op: "update_feature", feature: "Auth", done: true }],
    [{ op: "delete_feature", feature: "Auth" }, { op: "delete_feature", feature: "Auth" }],
    [{ op: "create_task", text: "Do it" }, { op: "create_task", text: "Do it" }],
    [{ op: "update_task", id: "T-1", text: "New" }, { op: "update_task", id: "T-1", text: "New" }],
    [{ op: "delete_task", id: "T-12" }, { op: "delete_task", id: "T-12" }],
    [{ op: "move_task", id: "T-1", column: "Ready" }, { op: "move_task", id: "T-1", column: "Ready" }],
    [{ op: "queue_task", id: "T-1" }, { op: "queue_task", id: "T-1" }],
    [{ op: "unqueue_task", id: "T-1" }, { op: "unqueue_task", id: "T-1" }],
    [{ op: "group_tasks", ids: ["T-1", "T-2"] }, { op: "group_tasks", ids: ["T-1", "T-2"] }],
    [{ op: "ungroup_tasks", ids: ["T-1"] }, { op: "ungroup_tasks", ids: ["T-1"] }],
    [{ op: "set_after", id: "T-2", after: ["T-1"] }, { op: "set_after", id: "T-2", after: ["T-1"] }],
    [{ op: "attach_images", id: "T-1", images: ["img-0123456789ab"] }, { op: "attach_images", id: "T-1", images: ["img-0123456789ab"] }],
    [{ op: "start_session", id: "T-1" }, { op: "start_session", id: "T-1" }],
    [{ op: "set_queue", on: false }, { op: "set_queue", on: false }],
    [{ op: "set_aril_settings", settings: {} }, { op: "set_aril_settings", settings: {} }],
    [{ op: "remove_worktree", id: "T-1", branch: false }, { op: "remove_worktree", id: "T-1", branch: false }],
    [{ op: "declare_rework", fix: "T-1", reworks: "#336", cause: "missed_wiring" }, { op: "declare_rework", fix: "T-1", reworks: "#336", cause: "missed_wiring" }],
  ];
  // The three memory operations are left: a stored proposal may still hold one, and a new answer may not (see the next test).
  assert.equal(accepted.length + LEGACY_MEMORY_OPERATIONS.length, BOARD_OPERATIONS.length);
  for (const [source, expected] of accepted) assert.deepEqual(normalizeOperation(source), expected, source.op);
});

test("memory is no longer proposed: a new answer with a memory operation is outside the contract, and a stored proposal still reads back", () => {
  const stored = [{ op: "add_memory", text: "Use tests" }, { op: "update_memory", id: 1, text: "Use tests" }, { op: "remove_memory", id: 1 }];
  assert.deepEqual([...LEGACY_MEMORY_OPERATIONS], ["add_memory", "update_memory", "remove_memory"]);
  for (const operation of stored) {
    assert.equal(normalizeOperation(operation), null, operation.op);
    assert.equal(normalizeProposal({ summary: "Remember", operations: [operation] }), null, operation.op);
    assert.deepEqual(normalizeOperation(operation, { stored: true }), operation, operation.op);
  }
  // Applying one that was saved does nothing: Aril keeps its memory by itself now.
  return applyOperations([stored[0]], { post: () => assert.fail("a saved memory operation changes nothing"), board: {} })
    .then((results) => assert.deepEqual(results, [{ ok: false, error: "unsupported" }]));
});

test("Aril settings proposals accept only the current limit names", () => {
  const current = { limits: { hours: 2, tasks: 5, tasksAtATime: 2, sendBacks: 1, usagePercent: 80 } };
  assert.deepEqual(normalizeOperation({ op: "set_aril_settings", settings: current }), { op: "set_aril_settings", settings: current });
  for (const limits of [
    { hours: 2, starts: 5, concurrent: 2, sendBacks: 1, allowancePercent: 80 },
    { ...current.limits, starts: 5 },
    { ...current.limits, allowancePercent: 80 },
  ]) assert.equal(normalizeOperation({ op: "set_aril_settings", settings: { limits } }), null);
});

test("a full create_task is normalized: flat run and complete-when fields become partial objects", () => {
  const operation = normalizeOperation({
    op: "create_task", text: "  Ship it  ", feature: " Auth ", provider: "claude", model: "claude-opus-4-1[1m]", effort: "high",
    complete_when: ["tree_clean", "pr_open"], own_condition: " Changelog updated ", queue: true,
  });
  assert.deepEqual(operation, {
    op: "create_task", text: "Ship it", feature: "Auth", queue: true,
    run: { provider: "claude", model: "claude-opus-4-1[1m]", effort: "high" },
    completeWhen: { checks: ["pr_open", "tree_clean"], own: "Changelog updated" },
  });
});

test("queue false and a null feature are dropped from create_task", () => {
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", queue: false, feature: null }), { op: "create_task", text: "x" });
});

test("only the run and complete-when parts that were written are kept", () => {
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", effort: "low" }).run, { effort: "low" });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", model: "gpt-6-sol" }).run, { model: "gpt-6-sol" });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", provider: null, model: null, effort: null }).run, { provider: null, model: null, effort: null });
  assert.equal(normalizeOperation({ op: "create_task", text: "x" }).run, undefined);
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", complete_when: [] }).completeWhen, { checks: [] });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", own_condition: "" }).completeWhen, { own: null });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", own_condition: null }).completeWhen, { own: null });
  assert.equal(normalizeOperation({ op: "create_task", text: "x" }).completeWhen, undefined);
});

test("complete_when checks are put in the fixed check order", () => {
  const operation = normalizeOperation({ op: "update_task", id: "T-1", complete_when: ["ci_passed", "pr_merged", "commit_on_branch", "tree_clean", "pr_open"] });
  assert.deepEqual(operation.completeWhen.checks, ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"]);
});

test("update_task keeps a null feature, partial parts, and text", () => {
  assert.deepEqual(normalizeOperation({ op: "update_task", id: "T-4", feature: null }), { op: "update_task", id: "T-4", feature: null });
  assert.deepEqual(normalizeOperation({ op: "update_task", id: "T-4", feature: " Auth ", provider: "codex", complete_when: ["pr_open"] }), {
    op: "update_task", id: "T-4", feature: "Auth", run: { provider: "codex" }, completeWhen: { checks: ["pr_open"] },
  });
});

test("a column is matched without case and spaces and stored under its canonical name", () => {
  for (const [written, column] of [["ready", "Ready"], ["  IN PROGRESS ", "In progress"], ["backlog", "Backlog"], ["DONE", "Done"], ["rEvIeW", "Review"]]) {
    assert.deepEqual(normalizeOperation({ op: "move_task", id: "T-1", column: written }), { op: "move_task", id: "T-1", column });
  }
  assert.deepEqual(normalizeOperation({ op: "move_task", id: "T-1", column: "Ready", position: 0 }), { op: "move_task", id: "T-1", column: "Ready", position: 0 });
  assert.deepEqual(normalizeOperation({ op: "move_task", id: "T-1", column: "Ready", position: null }), { op: "move_task", id: "T-1", column: "Ready" });
  assert.deepEqual(normalizeOperation({ op: "move_task", id: "T-1", column: "Ready", position: 100_000 }), { op: "move_task", id: "T-1", column: "Ready", position: 100_000 });
});

test("an operation outside the contract is refused", () => {
  const long = (length) => "a".repeat(length);
  const refused = [
    ["not an object", null], ["not an object", "create_task"], ["array", []], ["number", 5], ["class instance", new (class Op { op = "delete_task"; id = "T-1"; })()],
    ["missing op", { id: "T-1" }], ["unknown op", { op: "stop_session", id: "T-1" }], ["op not a string", { op: ["delete_task"], id: "T-1" }],
    ["__proto__ op", { op: "toString" }],
    ["extra key on feature", { op: "create_feature", name: "A", extra: 1 }], ["extra key on delete", { op: "delete_task", id: "T-1", force: true }],
    ["extra key on task", { op: "create_task", text: "x", path: "C:\\x" }], ["extra key on update", { op: "update_task", id: "T-1", text: "x", step: 1 }],
    ["extra key on move", { op: "move_task", id: "T-1", column: "Ready", at: 1 }], ["extra key on group", { op: "group_tasks", ids: ["T-1", "T-2"], feature: "A" }], ["extra key on ungroup", { op: "ungroup_tasks", ids: ["T-1"], id: "T-1" }],
    ["id zero", { op: "delete_task", id: "T-0" }], ["id lower case", { op: "delete_task", id: "t-1" }], ["id with a space", { op: "delete_task", id: "T-1 " }],
    ["id with leading zero", { op: "delete_task", id: "T-01" }], ["id of ten digits", { op: "delete_task", id: "T-1234567890" }],
    ["id a number", { op: "delete_task", id: 1 }], ["id missing", { op: "queue_task" }], ["id path", { op: "unqueue_task", id: "../T-1" }],
    ["empty text", { op: "create_task", text: "" }], ["blank text", { op: "create_task", text: "  \n " }], ["text a number", { op: "create_task", text: 4 }],
    ["text over 4000", { op: "create_task", text: long(4001) }], ["update text empty", { op: "update_task", id: "T-1", text: "" }],
    ["NUL in text", { op: "create_task", text: "a\u0000b" }], ["escape in text", { op: "create_task", text: "a\u001bb" }],
    ["C1 control in text", { op: "create_task", text: "a\u0085b" }], ["line separator in text", { op: "create_task", text: "a\u2028b" }],
    ["model without a provider", { op: "create_task", text: "x", provider: null, model: "gpt-6-sol" }],
    ["unknown provider", { op: "create_task", text: "x", provider: "gemini" }], ["unknown effort", { op: "create_task", text: "x", effort: "max" }],
    ["model with dots up", { op: "create_task", text: "x", model: "../x" }], ["model with a space", { op: "create_task", text: "x", model: "a b" }],
    ["model that starts with a dash", { op: "create_task", text: "x", model: "--help" }], ["empty model", { op: "create_task", text: "x", model: "" }],
    ["model of 121 characters", { op: "create_task", text: "x", model: long(121) }], ["model a number", { op: "update_task", id: "T-1", model: 4 }],
    ["duplicate check", { op: "create_task", text: "x", complete_when: ["pr_open", "pr_open"] }],
    ["unknown check", { op: "create_task", text: "x", complete_when: ["lint"] }], ["checks not a list", { op: "create_task", text: "x", complete_when: "pr_open" }],
    ["own condition over 500", { op: "create_task", text: "x", own_condition: long(501) }], ["own condition a number", { op: "create_task", text: "x", own_condition: 5 }],
    ["own condition with NUL", { op: "update_task", id: "T-1", own_condition: "a\u0000" }],
    ["step on a task", { op: "create_task", text: "x", feature: "A", step: 1 }], ["set_step is removed", { op: "set_step", id: "T-1", step: 1 }],
    ["group of one", { op: "group_tasks", ids: ["T-1"] }], ["group of 17", { op: "group_tasks", ids: Array.from({ length: 17 }, (_, i) => `T-${i + 1}`) }],
    ["group with a repeated id", { op: "group_tasks", ids: ["T-1", "T-1"] }], ["group with a bad id", { op: "group_tasks", ids: ["T-1", "x"] }],
    ["group ids not a list", { op: "group_tasks", ids: "T-1" }], ["group with id instead of ids", { op: "group_tasks", id: "T-1" }],
    ["group with a placeholder", { op: "group_tasks", ids: ["T-1", "new-1"] }], ["group missing ids", { op: "group_tasks" }],
    ["ungroup of none", { op: "ungroup_tasks", ids: [] }], ["ungroup of 17", { op: "ungroup_tasks", ids: Array.from({ length: 17 }, (_, i) => `T-${i + 1}`) }],
    ["ungroup with a repeated id", { op: "ungroup_tasks", ids: ["T-1", "T-1"] }], ["ungroup with id instead of ids", { op: "ungroup_tasks", id: "T-1" }],
    ["queue not a boolean", { op: "create_task", text: "x", queue: "yes" }],
    ["negative position", { op: "move_task", id: "T-1", column: "Ready", position: -1 }], ["fractional position", { op: "move_task", id: "T-1", column: "Ready", position: 1.5 }],
    ["position over the limit", { op: "move_task", id: "T-1", column: "Ready", position: 100_001 }], ["position a string", { op: "move_task", id: "T-1", column: "Ready", position: "0" }],
    ["unknown column", { op: "move_task", id: "T-1", column: "Archive" }], ["column a number", { op: "move_task", id: "T-1", column: 2 }], ["column missing", { op: "move_task", id: "T-1" }],
    ["update without a field", { op: "update_task", id: "T-1" }],
    ["feature name over 80", { op: "create_feature", name: long(81) }], ["feature name on two lines", { op: "create_feature", name: "A\nB" }],
    ["feature name empty", { op: "create_feature", name: "  " }], ["task feature on two lines", { op: "create_task", text: "x", feature: "A\nB" }],
    ["task feature over 80", { op: "create_task", text: "x", feature: long(81) }], ["update feature empty", { op: "update_task", id: "T-1", feature: "" }],
    ["update feature over 80", { op: "update_task", id: "T-1", feature: long(81) }], ["update feature a number", { op: "update_task", id: "T-1", feature: 3 }],
  ];
  for (const [rule, source] of refused) assert.equal(normalizeOperation(source), null, rule);
});

test("the edges of every bound are accepted", () => {
  assert.ok(normalizeOperation({ op: "create_task", text: "a".repeat(4000) }));
  assert.ok(normalizeOperation({ op: "create_task", text: "line one\nline two\ttabbed\r\nline three" }));
  assert.ok(normalizeOperation({ op: "create_task", text: "x", own_condition: "a".repeat(500) }));
  assert.ok(normalizeOperation({ op: "create_task", text: "x", model: "a".repeat(120) }));
  assert.ok(normalizeOperation({ op: "create_task", text: "x", feature: "a".repeat(80) }));
  assert.ok(normalizeOperation({ op: "create_feature", name: "a".repeat(80) }));
  assert.ok(normalizeOperation({ op: "delete_task", id: "T-123456789" }));
  assert.ok(normalizeOperation({ op: "group_tasks", ids: Array.from({ length: 16 }, (_, i) => `T-${i + 1}`) }));
  assert.ok(normalizeOperation({ op: "ungroup_tasks", ids: Array.from({ length: 16 }, (_, i) => `T-${i + 1}`) }));
});

test("a proposal needs a one-line summary and one to forty operations, and one bad operation rejects it all", () => {
  assert.deepEqual(normalizeProposal({ summary: "  Add one task  ", operations: goodProposal.operations }), { summary: "Add one task", operations: [{ op: "create_task", text: "Write the plan" }] });
  const operations = (count) => Array.from({ length: count }, () => ({ op: "queue_task", id: "T-1" }));
  assert.equal(normalizeProposal({ summary: "x", operations: operations(40) }).operations.length, 40);
  assert.equal(normalizeProposal({ summary: "x", operations: operations(41) }), null);
  assert.equal(normalizeProposal({ summary: "x", operations: [] }), null);
  assert.equal(normalizeProposal({ summary: "x", operations: [...operations(2), { op: "delete_task", id: "bad" }] }), null);
  assert.equal(normalizeProposal({ summary: "x", operations: [...operations(2), { op: "delete_task", id: "T-1", extra: 1 }] }), null);
  assert.equal(normalizeProposal({ summary: "a".repeat(300), operations: operations(1) }).summary.length, 300);
  for (const summary of [undefined, "", "   ", "a".repeat(301), "one\ntwo", "bell\u0007", 5, null]) {
    assert.equal(normalizeProposal({ summary, operations: operations(1) }), null, String(summary));
  }
  assert.equal(normalizeProposal({ ...goodProposal, title: "x" }), null);
  for (const source of [null, "x", [], { summary: "x" }, { summary: "x", operations: "none" }, { operations: operations(1) }]) assert.equal(normalizeProposal(source), null);
});

test("an answer without a proposal block is returned as written and is not unreadable", () => {
  assert.deepEqual(extractProposal("Here is my advice.\n\nSecond paragraph."), { text: "Here is my advice.\n\nSecond paragraph.", proposal: null, unreadable: false });
  assert.deepEqual(extractProposal(""), { text: "", proposal: null, unreadable: false });
  assert.deepEqual(extractProposal(undefined), { text: "", proposal: null, unreadable: false });
  assert.deepEqual(extractProposal(7), { text: "", proposal: null, unreadable: false });
});

test("one valid block is removed from the text and becomes the proposal", () => {
  const read = extractProposal(`I suggest one task.\n\n${fence(goodProposal)}\n`);
  assert.deepEqual(read, { text: "I suggest one task.", proposal: goodProposal, unreadable: false });
  const middle = extractProposal(`Before.\n${fence(goodProposal)}\nAfter.`);
  assert.equal(middle.proposal.summary, "Add one task");
  assert.equal(middle.text.includes("```"), false);
  assert.match(middle.text, /^Before\.\s+After\.$/u);
  assert.deepEqual(extractProposal(fence(goodProposal)), { text: "", proposal: goodProposal, unreadable: false });
});

test("a proposal block that is malformed, repeated, unclosed, oversize, or outside the contract is unreadable and never shown", () => {
  const unreadable = (answer) => {
    const read = extractProposal(answer);
    assert.equal(read.proposal, null);
    assert.equal(read.unreadable, true);
    assert.equal(read.text.includes(PROPOSAL_FENCE), false, "the block is not part of the text");
    assert.equal(read.text.includes("```"), false);
    return read;
  };
  assert.equal(unreadable(`Plan.\n${fence("{not json")}`).text, "Plan.");
  assert.equal(unreadable(`Plan.\n${fence(goodProposal)}\n\nand again\n${fence(goodProposal)}`).text.startsWith("Plan."), true);
  assert.equal(unreadable(`Plan.\n\`\`\`${PROPOSAL_FENCE}\n{"summary":"x","operations":[`).text, "Plan.");
  assert.equal(unreadable(`Plan.\n${fence({ summary: "x", operations: [] })}`).text, "Plan.");
  assert.equal(unreadable(`Plan.\n${fence({ summary: "x", operations: [{ op: "delete_task", id: "T-1", force: true }] })}`).text, "Plan.");
  assert.equal(unreadable(`Plan.\n${fence({ ...goodProposal, extra: true })}`).text, "Plan.");
  assert.equal(unreadable(`Plan.\n${fence("[1,2]")}`).text, "Plan.");
  // A valid block followed by one that was never closed still offers nothing.
  unreadable(`${fence(goodProposal)}\nthen\n\`\`\`${PROPOSAL_FENCE}\n{"summary"`);
  // 256 KiB is the bound of one block's bytes.
  const padded = (length) => `{"summary":"x","operations":[{"op":"create_task","text":"y"}],"pad":"${"a".repeat(length)}"}`;
  unreadable(`Plan.\n${fence(padded(256 * 1024))}`);
  assert.equal(extractProposal(`Plan.\n${fence("{\"summary\":\"x\",\"operations\":[{\"op\":\"create_task\",\"text\":\"y\"}]}")}`).unreadable, false);
});

test("an answer of only an unclosed block has no text and is unreadable", () => {
  assert.deepEqual(extractProposal(`\`\`\`${PROPOSAL_FENCE}\n{"summary":`), { text: "", proposal: null, unreadable: true });
});

test("a fence with another language tag is ordinary text", () => {
  const answer = "Example:\n\n```json\n{\"summary\":\"x\",\"operations\":[]}\n```\n\n```js\nconsole.log(1)\n```";
  assert.deepEqual(extractProposal(answer), { text: answer, proposal: null, unreadable: false });
  const near = "```pomegr\n{\"summary\":\"x\"}\n```";
  assert.deepEqual(extractProposal(near), { text: near, proposal: null, unreadable: false });
  // A tag with other text after the name on its line still opens the block; the agent's own name is the only one honored.
  assert.equal(extractProposal("```Pomegr-Board\n{}\n```").unreadable, false);
});

test("a proposal block is read from CRLF text too", () => {
  const crlf = `I suggest one task.\r\n\r\n\`\`\`${PROPOSAL_FENCE}\r\n${JSON.stringify(goodProposal)}\r\n\`\`\`\r\n`;
  const read = extractProposal(crlf);
  assert.equal(read.unreadable, false);
  assert.deepEqual(read.proposal, goodProposal);
  assert.equal(read.text.includes("```"), false);
  assert.match(read.text, /^I suggest one task\./u);
  assert.equal(visibleAnswer(crlf).includes("create_task"), false);
  const bare = extractProposal(`Plan.\r\n\`\`\`${PROPOSAL_FENCE}\r\n${JSON.stringify(goodProposal)}\r\n\`\`\``);
  assert.deepEqual(bare.proposal, goodProposal);
});

test("a visible answer hides a proposal block that has begun and one that is closed", () => {
  assert.equal(visibleAnswer("Thinking about it."), "Thinking about it.");
  assert.equal(visibleAnswer(`Plan.\n\n\`\`\`${PROPOSAL_FENCE}\n{"summary":"x","oper`), "Plan.");
  assert.equal(visibleAnswer(`Plan.\n\n\`\`\`${PROPOSAL_FENCE}`), "Plan.");
  assert.equal(visibleAnswer(`Plan.\n${fence(goodProposal)}\nDone.`).includes("create_task"), false);
  assert.equal(visibleAnswer(`Plan.\n${fence(goodProposal)}\n`), "Plan.");
  assert.equal(visibleAnswer("a\n\n\n\n\nb"), "a\n\nb");
  assert.equal(visibleAnswer("```json\n{}\n```"), "```json\n{}\n```");
  assert.equal(visibleAnswer(null), "");
  assert.equal(visibleAnswer(undefined), "");
});

// ---- applyOperations -------------------------------------------------------------------------------------------

const columns = [{ id: "col-a", name: "Backlog" }, { id: "col-b", name: "Ready" }, { id: "col-c", name: "In progress" }];
const auth = { id: "feat-1", name: "Auth", done: false };
const storedRun = { provider: "claude", model: "claude-opus-4-1", effort: "high", remoteControl: true, keepWorktree: true };
const storedWhen = { checks: ["pr_open", "tree_clean"], own: "Keep the changelog" };

function boardOf({ features = [auth], tasks } = {}) {
  return {
    columns, features,
    tasks: tasks ?? [
      { id: "T-3", featureId: "feat-1", run: storedRun, completeWhen: storedWhen },
      { id: "T-4", featureId: null, run: { provider: "codex", model: "gpt-6-sol", effort: "low" }, completeWhen: { checks: [], own: null } },
      { id: "T-5" },
    ],
  };
}

/** A fake monitor: records every call and answers from `reply(action, payload, calls)`; the default is `{ ok: true }`. */
function monitor(reply = () => ({ ok: true })) {
  const calls = [];
  return { calls, post: async (action, payload) => { calls.push({ action, payload }); return reply(action, payload, calls); } };
}

async function apply(operations, fake, board = boardOf()) {
  const results = await applyOperations(operations, { post: fake.post, board });
  assert.equal(results.length, operations.length, "one result per operation");
  return results;
}

test("create_task posts a create with the whole run and complete-when built from the partial parts", async () => {
  const fake = monitor((action) => (action === "create" ? { ok: true, taskId: "T-9" } : { ok: true }));
  const results = await apply([
    { op: "create_task", text: "Plain" },
    { op: "create_task", text: "Partial", run: { effort: "low" }, completeWhen: { own: "Done when X" } },
    { op: "create_task", text: "Provider only", run: { provider: "codex" }, completeWhen: { checks: ["ci_passed"] } },
    { op: "create_task", text: "Full", run: { provider: "claude", model: "m-1", effort: "xhigh" }, completeWhen: { checks: ["pr_open"], own: null } },
  ], fake);
  assert.deepEqual(results, Array(4).fill({ ok: true, taskId: "T-9" }));
  assert.deepEqual(fake.calls, [
    { action: "create", payload: { text: "Plain" } },
    { action: "create", payload: { text: "Partial", run: { provider: null, model: null, effort: "low" }, completeWhen: { checks: [], own: "Done when X" } } },
    { action: "create", payload: { text: "Provider only", run: { provider: "codex", model: null, effort: null }, completeWhen: { checks: ["ci_passed"], own: null } } },
    { action: "create", payload: { text: "Full", run: { provider: "claude", model: "m-1", effort: "xhigh" }, completeWhen: { checks: ["pr_open"], own: null } } },
  ]);
});

test("create_task resolves its feature by name on the current board; queue adds a following queue_add", async () => {
  const fake = monitor((action) => (action === "create" ? { ok: true, taskId: "T-11" } : { ok: true }));
  const results = await apply([{ op: "create_task", text: "In a feature", feature: "Auth", queue: true }], fake);
  assert.deepEqual(results, [{ ok: true, taskId: "T-11" }]);
  assert.deepEqual(fake.calls, [
    { action: "create", payload: { text: "In a feature", featureId: "feat-1" } },
    { action: "queue_add", payload: { id: "T-11" } },
  ]);
  const joined = monitor((action) => (action === "create" ? { ok: true, taskId: "T-12" } : { ok: true }));
  await apply([{ op: "create_task", text: "No queue", feature: "Auth" }], joined);
  assert.deepEqual(joined.calls, [{ action: "create", payload: { text: "No queue", featureId: "feat-1" } }]);
});

test("create_feature then a task that names it works, because the board of the first answer is used", async () => {
  const withFeature = boardOf({ features: [auth, { id: "feat-2", name: "Billing", done: false }] });
  const fake = monitor((action) => {
    if (action === "feature_create") return { ok: true, board: withFeature };
    if (action === "create") return { ok: true, taskId: "T-20" };
    return { ok: true };
  });
  const results = await apply([{ op: "create_feature", name: "Billing" }, { op: "create_task", text: "Invoice", feature: "Billing" }], fake, boardOf());
  assert.deepEqual(results, [{ ok: true }, { ok: true, taskId: "T-20" }]);
  assert.deepEqual(fake.calls, [
    { action: "feature_create", payload: { name: "Billing" } },
    { action: "create", payload: { text: "Invoice", featureId: "feat-2" } },
  ]);
});

test("an open feature of that name makes create_feature a successful no-op; a done one does not", async () => {
  const fake = monitor();
  assert.deepEqual(await apply([{ op: "create_feature", name: "Auth" }], fake), [{ ok: true }]);
  assert.equal(fake.calls.length, 0);
  const finished = boardOf({ features: [{ ...auth, done: true }] });
  const again = monitor();
  assert.deepEqual(await apply([{ op: "create_feature", name: "Auth" }], again, finished), [{ ok: true }]);
  assert.deepEqual(again.calls, [{ action: "feature_create", payload: { name: "Auth" } }]);
  // A name is matched exactly.
  const exact = monitor();
  await apply([{ op: "create_feature", name: "auth" }], exact);
  assert.equal(exact.calls.length, 1);
});

test("a task that names a feature the board does not have is not_found without a request", async () => {
  const fake = monitor();
  assert.deepEqual(await apply([{ op: "create_task", text: "x", feature: "Missing" }], fake), [{ ok: false, error: "not_found" }]);
  const finished = boardOf({ features: [{ ...auth, done: true }] });
  assert.deepEqual(await apply([{ op: "create_task", text: "x", feature: "Auth" }], fake, finished), [{ ok: false, error: "not_found" }]);
  assert.deepEqual(await apply([{ op: "update_task", id: "T-4", feature: "Missing" }], fake), [{ ok: false, error: "not_found" }]);
  assert.equal(fake.calls.length, 0);
});

test("update_task merges a partial run with the stored one and keeps remote control and the kept worktree", async () => {
  const fake = monitor();
  await apply([
    { op: "update_task", id: "T-3", run: { effort: "low" } },
    { op: "update_task", id: "T-3", run: { model: "claude-sonnet-4" } },
    { op: "update_task", id: "T-3", completeWhen: { own: null } },
    { op: "update_task", id: "T-3", completeWhen: { checks: ["ci_passed"] } },
    { op: "update_task", id: "T-3", text: "New text" },
  ], fake);
  assert.deepEqual(fake.calls, [
    { action: "update", payload: { id: "T-3", run: { provider: "claude", model: "claude-opus-4-1", effort: "low", remoteControl: true, keepWorktree: true } } },
    { action: "update", payload: { id: "T-3", run: { provider: "claude", model: "claude-sonnet-4", effort: "high", remoteControl: true, keepWorktree: true } } },
    { action: "update", payload: { id: "T-3", completeWhen: { checks: ["pr_open", "tree_clean"], own: null } } },
    { action: "update", payload: { id: "T-3", completeWhen: { checks: ["ci_passed"], own: "Keep the changelog" } } },
    { action: "update", payload: { id: "T-3", text: "New text" } },
  ]);
});

test("changing the provider without a model drops the stored model; Codex runs carry no remote control", async () => {
  const fake = monitor();
  await apply([
    { op: "update_task", id: "T-3", run: { provider: "codex" } },
    { op: "update_task", id: "T-3", run: { provider: "codex", model: "gpt-6-sol" } },
    { op: "update_task", id: "T-3", run: { provider: "claude" } },
    { op: "update_task", id: "T-4", run: { provider: "claude" } },
    { op: "update_task", id: "T-4", run: { provider: "codex" } },
    { op: "update_task", id: "T-5", run: { effort: "medium" } },
  ], fake);
  assert.deepEqual(fake.calls.map((call) => call.payload.run), [
    { provider: "codex", model: null, effort: "high", keepWorktree: true },
    { provider: "codex", model: "gpt-6-sol", effort: "high", keepWorktree: true },
    { provider: "claude", model: "claude-opus-4-1", effort: "high", remoteControl: true, keepWorktree: true },
    { provider: "claude", model: null, effort: "low" },
    { provider: "codex", model: "gpt-6-sol", effort: "low" },
    { provider: null, model: null, effort: "medium" },
  ]);
});

test("update_task sends a feature only when it changes, and null only when the task has one", async () => {
  const board = boardOf({ features: [auth, { id: "feat-2", name: "Billing", done: false }, { id: "feat-3", name: "Old", done: true }] });
  board.tasks.push({ id: "T-6", featureId: "feat-3" });
  const fake = monitor();
  const results = await apply([
    { op: "update_task", id: "T-4", feature: "Auth" },
    { op: "update_task", id: "T-3", feature: "Billing" },
    { op: "update_task", id: "T-3", feature: null },
    { op: "update_task", id: "T-6", feature: "Old" },
    { op: "update_task", id: "T-6", feature: null },
    { op: "update_task", id: "T-3", feature: "Auth" },
    { op: "update_task", id: "T-4", feature: null },
    { op: "update_task", id: "T-5", feature: null },
  ], fake, board);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(fake.calls, [
    { action: "update", payload: { id: "T-4", featureId: "feat-1" } },
    { action: "update", payload: { id: "T-3", featureId: "feat-2" } },
    { action: "update", payload: { id: "T-3", featureId: null } },
    { action: "update", payload: { id: "T-6", featureId: null } },
  ]);
});

test("an update that would change nothing answers ok without a request, and one with other fields leaves out the unchanged feature", async () => {
  const fake = monitor();
  assert.deepEqual(await apply([{ op: "update_task", id: "T-3", feature: "Auth" }, { op: "update_task", id: "T-5", feature: null }], fake), [{ ok: true }, { ok: true }]);
  assert.equal(fake.calls.length, 0);
  await apply([{ op: "update_task", id: "T-3", text: "New", feature: "Auth" }], fake);
  assert.deepEqual(fake.calls, [{ action: "update", payload: { id: "T-3", text: "New" } }]);
  assert.equal(Object.hasOwn(fake.calls[0].payload, "featureId"), false);
});

test("move resolves the column by name and appends by default", async () => {
  const fake = monitor();
  await apply([
    { op: "move_task", id: "T-3", column: "Ready" },
    { op: "move_task", id: "T-3", column: "In progress", position: 0 },
    { op: "move_task", id: "T-4", column: "Backlog", position: 7 },
  ], fake);
  assert.deepEqual(fake.calls, [
    { action: "move", payload: { id: "T-3", columnId: "col-b", position: 100_000 } },
    { action: "move", payload: { id: "T-3", columnId: "col-c", position: 0 } },
    { action: "move", payload: { id: "T-4", columnId: "col-a", position: 7 } },
  ]);
  const none = monitor();
  assert.deepEqual(await apply([{ op: "move_task", id: "T-3", column: "Done" }], none), [{ ok: false, error: "not_found" }]);
  assert.equal(none.calls.length, 0);
});

test("delete, queue, unqueue, group, and ungroup map to their fixed task actions", async () => {
  const fake = monitor();
  const results = await apply([
    { op: "delete_task", id: "T-3" }, { op: "queue_task", id: "T-4" }, { op: "unqueue_task", id: "T-5" },
    { op: "group_tasks", ids: ["T-3", "T-4"] }, { op: "ungroup_tasks", ids: ["T-3"] },
  ], fake);
  assert.deepEqual(results, Array(5).fill({ ok: true }));
  assert.deepEqual(fake.calls, [
    { action: "delete", payload: { id: "T-3" } },
    { action: "queue_add", payload: { id: "T-4" } },
    { action: "queue_remove", payload: { id: "T-5" } },
    { action: "queue_group", payload: { ids: ["T-3", "T-4"] } },
    { action: "queue_ungroup", payload: { ids: ["T-3"] } },
  ]);
});

test("an operation on a task that is not on the board is not_found without a request", async () => {
  const fake = monitor();
  const results = await apply([
    { op: "update_task", id: "T-99", text: "x" }, { op: "delete_task", id: "T-99" }, { op: "move_task", id: "T-99", column: "Ready" },
    { op: "queue_task", id: "T-99" }, { op: "unqueue_task", id: "T-99" }, { op: "group_tasks", ids: ["T-3", "T-99"] },
  ], fake);
  assert.equal(results[0].error, "not_found");
  assert.deepEqual(results.slice(1), Array(5).fill({ ok: false, error: "skipped" }));
  assert.equal(fake.calls.length, 0);
  for (const operation of [
    { op: "delete_task", id: "T-99" }, { op: "move_task", id: "T-99", column: "Ready" }, { op: "queue_task", id: "T-99" },
    { op: "unqueue_task", id: "T-99" }, { op: "group_tasks", ids: ["T-3", "T-99"] }, { op: "ungroup_tasks", ids: ["T-99"] },
  ]) assert.deepEqual(await apply([operation], fake), [{ ok: false, error: "not_found" }], operation.op);
  assert.equal(fake.calls.length, 0);
});

test("a board that is missing or malformed leaves every task and feature unknown", async () => {
  for (const board of [null, undefined, "board", [], { tasks: "none", features: 4, columns: {} }, { tasks: [null, { id: "x" }, { id: "T-0" }, 5] }]) {
    const fake = monitor();
    assert.deepEqual(await applyOperations([{ op: "delete_task", id: "T-3" }], { post: fake.post, board }), [{ ok: false, error: "not_found" }]);
    assert.equal(fake.calls.length, 0);
  }
});

test("it stops at the first failure and marks the operations after it skipped", async () => {
  const fake = monitor((action, payload) => (action === "update" && payload.id === "T-4" ? { ok: false, error: "conflict" } : { ok: true }));
  const results = await apply([
    { op: "delete_task", id: "T-5" },
    { op: "update_task", id: "T-4", text: "Blocked by a session" },
    { op: "delete_task", id: "T-3" },
    { op: "create_feature", name: "Never" },
  ], fake);
  assert.deepEqual(results, [{ ok: true }, { ok: false, error: "conflict" }, { ok: false, error: "skipped" }, { ok: false, error: "skipped" }]);
  assert.deepEqual(fake.calls.map((call) => call.action), ["delete", "update"]);
});

test("a monitor error outside the fixed set, a thrown post, and a malformed answer are unavailable", async () => {
  const answers = [
    { ok: false, error: "teapot" }, { ok: false, error: "skipped" }, { ok: false, error: "unavailable" }, { ok: false, error: 7 }, { ok: false },
    { ok: "true" }, {}, null, undefined, "ok", 1, [], [{ ok: true }],
  ];
  for (const answer of answers) {
    const fake = monitor(() => answer);
    assert.deepEqual(await apply([{ op: "delete_task", id: "T-3" }, { op: "delete_task", id: "T-4" }], fake), [{ ok: false, error: "unavailable" }, { ok: false, error: "skipped" }], JSON.stringify(answer));
    assert.equal(fake.calls.length, 1);
  }
  const thrown = { post: async () => { throw new Error("C:\\private\\path"); } };
  assert.deepEqual(await apply([{ op: "delete_task", id: "T-3" }], thrown), [{ ok: false, error: "unavailable" }]);
  const sync = { post: () => { throw new Error("boom"); } };
  assert.deepEqual(await apply([{ op: "delete_task", id: "T-3" }], sync), [{ ok: false, error: "unavailable" }]);
  for (const error of ["invalid", "not_found", "limit", "conflict", "unsupported"]) {
    assert.deepEqual(await apply([{ op: "delete_task", id: "T-3" }], monitor(() => ({ ok: false, error, detail: "private" }))), [{ ok: false, error }], error);
  }
});

test("a task that was created but cannot be queued is a failure that names the task; one that answers no task ID is unavailable", async () => {
  const fake = monitor((action) => (action === "create" ? { ok: true, taskId: "T-30" } : { ok: false, error: "limit" }));
  const results = await apply([{ op: "create_task", text: "x", queue: true }, { op: "delete_task", id: "T-3" }], fake);
  assert.deepEqual(results, [{ ok: false, error: "limit", taskId: "T-30" }, { ok: false, error: "skipped" }]);
  assert.deepEqual(fake.calls.map((call) => call.action), ["create", "queue_add"]);
  for (const taskId of [undefined, null, "T-0", "task-1", 30]) {
    const bare = monitor(() => ({ ok: true, taskId }));
    assert.deepEqual(await apply([{ op: "create_task", text: "x", queue: true }], bare), [{ ok: false, error: "unavailable" }], String(taskId));
    assert.equal(bare.calls.length, 1, "nothing is queued for an unknown task");
  }
  const failed = monitor(() => ({ ok: false, error: "limit" }));
  assert.deepEqual(await apply([{ op: "create_task", text: "x", queue: true }], failed), [{ ok: false, error: "limit" }]);
  assert.equal(failed.calls.length, 1);
});

test("an empty list of operations answers an empty list and sends nothing", async () => {
  const fake = monitor();
  assert.deepEqual(await applyOperations([], { post: fake.post, board: boardOf() }), []);
  assert.equal(fake.calls.length, 0);
});

test("set_after takes 0 to 8 distinct task IDs, never the task itself", () => {
  assert.deepEqual(normalizeOperation({ op: "set_after", id: "T-3", after: [] }), { op: "set_after", id: "T-3", after: [] });
  const eight = Array.from({ length: 8 }, (_, index) => `T-${index + 10}`);
  assert.deepEqual(normalizeOperation({ op: "set_after", id: "T-3", after: eight }), { op: "set_after", id: "T-3", after: eight });
  for (const after of [["T-3"], ["T-1", "T-1"], [...eight, "T-30"], ["t-1"], "T-1", undefined]) {
    assert.equal(normalizeOperation({ op: "set_after", id: "T-3", after }), null, JSON.stringify(after));
  }
  assert.equal(normalizeOperation({ op: "set_after", id: "T-3", after: ["T-1"], extra: true }), null);
});

test("update_feature and delete_feature name a feature by its exact title; update_feature needs a new title or done", () => {
  assert.deepEqual(normalizeOperation({ op: "update_feature", feature: " Auth ", name: " Sign-in " }), { op: "update_feature", feature: "Auth", name: "Sign-in" });
  assert.deepEqual(normalizeOperation({ op: "update_feature", feature: "Auth", done: true }), { op: "update_feature", feature: "Auth", done: true });
  assert.deepEqual(normalizeOperation({ op: "update_feature", feature: "Auth", done: false }), { op: "update_feature", feature: "Auth", done: false });
  assert.deepEqual(normalizeOperation({ op: "update_feature", feature: "Auth", name: "Sign-in", done: true }), { op: "update_feature", feature: "Auth", name: "Sign-in", done: true });
  assert.deepEqual(normalizeOperation({ op: "delete_feature", feature: "Auth" }), { op: "delete_feature", feature: "Auth" });
  for (const [label, operation] of [
    ["update with no change", { op: "update_feature", feature: "Auth" }],
    ["update without a feature", { op: "update_feature", name: "Sign-in" }],
    ["update with a blank feature", { op: "update_feature", feature: "  ", done: true }],
    ["update with a feature ID instead of a title", { op: "update_feature", id: "feat-1", done: true }],
    ["update with a blank title", { op: "update_feature", feature: "Auth", name: " " }],
    ["update with a title over 80", { op: "update_feature", feature: "Auth", name: "a".repeat(81) }],
    ["update with a title on two lines", { op: "update_feature", feature: "Auth", name: "A\nB" }],
    ["update with a non-boolean done", { op: "update_feature", feature: "Auth", done: "true" }],
    ["update with a null done", { op: "update_feature", feature: "Auth", done: null }],
    ["update with a description", { op: "update_feature", feature: "Auth", description: "x" }],
    ["update with an app version", { op: "update_feature", feature: "Auth", appVersion: "1.0" }],
    ["delete without a feature", { op: "delete_feature" }],
    ["delete with a feature on two lines", { op: "delete_feature", feature: "A\nB" }],
    ["delete with an extra key", { op: "delete_feature", feature: "Auth", force: true }],
  ]) assert.equal(normalizeOperation(operation), null, label);
  assert.equal(normalizeOperation({ op: "delete_feature", feature: "Auth" }, { grantWrite: true }), null, "a grant write creates tasks only");
  const proposal = { summary: "Tidy features", operations: [{ op: "update_feature", feature: "Auth", done: true }, { op: "delete_feature", feature: "Old" }] };
  assert.deepEqual(extractProposal(`Tidy.\n${fence(proposal)}`).proposal, proposal);
});

test("update_feature posts the desktop feature_update by ID, for an open or a done feature", async () => {
  const done = { id: "feat-2", name: "Shipped", done: true };
  const fake = monitor();
  const results = await apply([
    { op: "update_feature", feature: "Auth", name: "Sign-in" },
    { op: "update_feature", feature: "Auth", done: true },
    { op: "update_feature", feature: "Shipped", done: false },
  ], fake, boardOf({ features: [auth, done] }));
  assert.deepEqual(results, Array(3).fill({ ok: true }));
  // Marking done or reopening sends the feature action alone: no task is moved, unqueued, or deleted.
  assert.deepEqual(fake.calls, [
    { action: "feature_update", payload: { id: "feat-1", name: "Sign-in" } },
    { action: "feature_update", payload: { id: "feat-1", done: true } },
    { action: "feature_update", payload: { id: "feat-2", done: false } },
  ]);
});

test("update_feature answers the monitor's conflict for a taken title, and not_found for an unknown feature without a request", async () => {
  const taken = monitor(() => ({ ok: false, error: "conflict" }));
  const billing = { id: "feat-2", name: "Billing", done: false };
  assert.deepEqual(await apply([{ op: "update_feature", feature: "Auth", name: "Billing" }, { op: "delete_task", id: "T-4" }], taken, boardOf({ features: [auth, billing] })),
    [{ ok: false, error: "conflict" }, { ok: false, error: "skipped" }]);
  assert.deepEqual(taken.calls, [{ action: "feature_update", payload: { id: "feat-1", name: "Billing" } }]);
  const missing = monitor();
  assert.deepEqual(await apply([{ op: "update_feature", feature: "auth", done: true }], missing), [{ ok: false, error: "not_found" }]);
  assert.equal(missing.calls.length, 0);
});

test("delete_feature deletes a feature with no task and refuses one that still has a task, a done one included", async () => {
  const empty = { id: "feat-2", name: "Empty", done: false };
  const fake = monitor();
  assert.deepEqual(await apply([{ op: "delete_feature", feature: "Empty" }], fake, boardOf({ features: [auth, empty] })), [{ ok: true }]);
  assert.deepEqual(fake.calls, [{ action: "feature_delete", payload: { id: "feat-2" } }]);
  const held = monitor();
  assert.deepEqual(await apply([{ op: "delete_feature", feature: "Auth" }], held), [{ ok: false, error: "conflict" }]);
  const doneTask = boardOf({ features: [{ ...auth, done: true }], tasks: [{ id: "T-7", featureId: "feat-1", state: "done" }] });
  assert.deepEqual(await apply([{ op: "delete_feature", feature: "Auth" }], held, doneTask), [{ ok: false, error: "conflict" }]);
  assert.equal(held.calls.length, 0, "the desktop delete, which detaches tasks, is never sent for a feature with a task");
  const missing = monitor();
  assert.deepEqual(await apply([{ op: "delete_feature", feature: "Gone" }], missing), [{ ok: false, error: "not_found" }]);
  assert.equal(missing.calls.length, 0);
});
