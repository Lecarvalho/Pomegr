import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import {
  applyOperations, BOARD_OPERATIONS, extractProposal, normalizeOperation, normalizeProposal, PROPOSAL_FENCE, proposalImages,
} from "../desktop/runtime/agent-chat-proposal.mjs";
import {
  addImage, chatHarness, finishTurn, gifBytes, jpegBytes, pngBytes, readyBoard, repositoryId, send, storedFiles, token,
} from "./helpers/agent-chat-harness.mjs";

const A = "img-0123456789ab";
const B = "img-ba9876543210";
const C = "img-00000000000c";
const D = "img-00000000000d";
const E = "img-00000000000e";

const fence = (body) => `\`\`\`${PROPOSAL_FENCE}\n${JSON.stringify(body)}\n\`\`\``;

test("create_task keeps one to four unique image IDs and drops a null or absent list", () => {
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", images: [A] }), { op: "create_task", text: "x", images: [A] });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", images: [A, B, C, D] }).images, [A, B, C, D]);
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", queue: true, feature: "Auth", images: [B, A] }), { op: "create_task", text: "x", feature: "Auth", queue: true, images: [B, A] });
  assert.equal(Object.hasOwn(normalizeOperation({ op: "create_task", text: "x", images: null }), "images"), false);
  assert.equal(Object.hasOwn(normalizeOperation({ op: "create_task", text: "x", images: undefined }), "images"), false);
  const source = [A];
  const operation = normalizeOperation({ op: "create_task", text: "x", images: source });
  assert.notEqual(operation.images, source, "the stored list is a copy");
});

test("create_task refuses a list of images outside the contract", () => {
  const refused = [
    [], [A, B, C, D, E], [A, A], [A, "img-short"], [`${A}\n`], [A.toUpperCase()], [`../${A}`], [`${A}.png`], ["IMG-0123456789ab"], [5], [null], [[A]], [{ id: A }], A, 5, true, {}, { 0: A, length: 1 },
  ];
  for (const images of refused) assert.equal(normalizeOperation({ op: "create_task", text: "x", images }), null, JSON.stringify(images));
});

test("attach_images is accepted with a task ID and one to four unique image IDs, and kept as written", () => {
  assert.deepEqual(normalizeOperation({ op: "attach_images", id: "T-12", images: [A] }), { op: "attach_images", id: "T-12", images: [A] });
  assert.deepEqual(normalizeOperation({ op: "attach_images", id: "T-1", images: [D, C, B, A] }), { op: "attach_images", id: "T-1", images: [D, C, B, A] });
  assert.ok(BOARD_OPERATIONS.includes("attach_images"));
  assert.ok(BOARD_OPERATIONS.indexOf("attach_images") < BOARD_OPERATIONS.indexOf("start_session"));
});

test("attach_images refuses every malformed form and any extra key", () => {
  const refused = [
    { op: "attach_images" }, { op: "attach_images", id: "T-1" }, { op: "attach_images", images: [A] }, { op: "attach_images", id: "T-1", images: [] },
    { op: "attach_images", id: "T-1", images: null }, { op: "attach_images", id: "T-1", images: undefined }, { op: "attach_images", id: "T-1", images: [A, A] },
    { op: "attach_images", id: "T-1", images: [A, B, C, D, E] }, { op: "attach_images", id: "T-1", images: ["img-x"] }, { op: "attach_images", id: "T-1", images: A },
    { op: "attach_images", id: "T-1", images: [5] }, { op: "attach_images", id: "T-0", images: [A] }, { op: "attach_images", id: "t-1", images: [A] },
    { op: "attach_images", id: "../T-1", images: [A] }, { op: "attach_images", id: 1, images: [A] }, { op: "attach_images", id: "T-1", images: [A], text: "x" },
    { op: "attach_images", id: "T-1", images: [A], column: "Ready" }, { op: "attach_images", id: "T-1", image: A },
  ];
  for (const source of refused) assert.equal(normalizeOperation(source), null, JSON.stringify(source));
});

test("images on any other operation are refused", () => {
  for (const source of [
    { op: "update_task", id: "T-1", text: "x", images: [A] }, { op: "delete_task", id: "T-1", images: [A] }, { op: "queue_task", id: "T-1", images: [A] },
    { op: "move_task", id: "T-1", column: "Ready", images: [A] }, { op: "group_tasks", ids: ["T-1", "T-2"], images: [A] }, { op: "ungroup_tasks", ids: ["T-1"], images: [A] }, { op: "start_session", id: "T-1", images: [A] },
    { op: "create_feature", name: "x", images: [A] }, { op: "set_queue", on: true, images: [A] },
  ]) assert.equal(normalizeOperation(source), null, source.op);
});

test("a proposal may mix attach_images with board changes, but never with a start or a queue change", () => {
  const attach = { op: "attach_images", id: "T-1", images: [A] };
  const create = { op: "create_task", text: "x", images: [B] };
  assert.deepEqual(normalizeProposal({ summary: "s", operations: [create, attach, { op: "queue_task", id: "T-2" }] }).operations, [create, attach, { op: "queue_task", id: "T-2" }]);
  assert.equal(normalizeProposal({ summary: "s", operations: [attach, { op: "start_session", id: "T-1" }] }), null);
  assert.equal(normalizeProposal({ summary: "s", operations: [attach, { op: "set_queue", on: true }] }), null);
  assert.equal(normalizeProposal({ summary: "s", operations: [{ op: "attach_images", id: "T-1", images: [] }] }), null, "one bad operation refuses the proposal");
});

test("extractProposal reads images from a fenced block, and a bad image list makes the block unreadable", () => {
  const ok = extractProposal(`Here.\n\n${fence({ summary: "Put the mock-up on T-4", operations: [{ op: "attach_images", id: "T-4", images: [A] }] })}`);
  assert.equal(ok.unreadable, false);
  assert.deepEqual(ok.proposal.operations, [{ op: "attach_images", id: "T-4", images: [A] }]);
  const bad = extractProposal(`Here.\n\n${fence({ summary: "x", operations: [{ op: "create_task", text: "x", images: [A, A] }] })}`);
  assert.equal(bad.proposal, null);
  assert.equal(bad.unreadable, true);
});

test("proposalImages lists every image a proposal names once, in order", () => {
  const proposal = { operations: [{ op: "create_task", text: "x", images: [B, A] }, { op: "queue_task", id: "T-1" }, { op: "attach_images", id: "T-2", images: [A, C] }] };
  assert.deepEqual(proposalImages(proposal), [B, A, C]);
  assert.deepEqual(proposalImages({ operations: [{ op: "queue_task", id: "T-1" }] }), []);
  for (const value of [null, undefined, {}, [], "x", { operations: "x" }, { operations: [null, 5, { images: "x" }] }]) assert.deepEqual(proposalImages(value), []);
});

test("applyOperations without an image request fails an image part as unavailable and does not queue", async () => {
  const post = async (action) => (action === "create" ? { ok: true, taskId: "T-9", board: readyBoard() } : { ok: true });
  const create = { op: "create_task", text: "x", images: [A], queue: true };
  for (const attach of [undefined, null, "x", async () => null, async () => ({ ok: false, error: "bogus" }), async () => { throw new Error("boom"); }, async () => ({ ok: "yes" })]) {
    const results = await applyOperations([create, { op: "queue_task", id: "T-1" }], { post, board: readyBoard(), attach });
    assert.deepEqual(results, [{ ok: false, error: "unavailable", taskId: "T-9", part: "images" }, { ok: false, error: "skipped" }]);
  }
});

test("applyOperations passes the new task ID and each image, in order, and queues only after the last image", async () => {
  const order = [];
  const post = async (action, payload) => { order.push([action, payload]); return action === "create" ? { ok: true, taskId: "T-9", board: readyBoard() } : { ok: true }; };
  const attach = async (taskId, imageId) => { order.push(["attach", taskId, imageId]); return { ok: true }; };
  const results = await applyOperations([{ op: "create_task", text: "x", images: [B, A, C], queue: true }], { post, board: readyBoard(), attach });
  assert.deepEqual(results, [{ ok: true, taskId: "T-9" }]);
  assert.deepEqual(order.map((entry) => entry.slice(0, 1).concat(entry[0] === "attach" ? entry.slice(1) : [])), [["create"], ["attach", "T-9", B], ["attach", "T-9", A], ["attach", "T-9", C], ["queue_add"]]);
  assert.deepEqual(order.at(-1), ["queue_add", { id: "T-9" }]);
});

test("applyOperations for attach_images needs the task on the board, skips images the task holds, and stops at the first image that fails", async () => {
  const board = readyBoard();
  board.tasks[0].images = [{ id: A, type: "png", bytes: 3 }, null, { id: 5 }];
  const sent = [];
  const attach = async (taskId, imageId) => { sent.push([taskId, imageId]); return imageId === C ? { ok: false, error: "limit" } : { ok: true }; };
  const post = async () => ({ ok: true });
  assert.deepEqual(await applyOperations([{ op: "attach_images", id: "T-1", images: [A] }], { post, board, attach }), [{ ok: true }]);
  assert.deepEqual(sent, [], "an image the task already holds is not sent again");
  assert.deepEqual(await applyOperations([{ op: "attach_images", id: "T-1", images: [A, B] }], { post, board, attach }), [{ ok: true }]);
  assert.deepEqual(sent, [["T-1", B]]);
  sent.length = 0;
  assert.deepEqual(await applyOperations([{ op: "attach_images", id: "T-2", images: [B, C, D] }, { op: "queue_task", id: "T-2" }], { post, board, attach }), [{ ok: false, error: "limit", part: "images" }, { ok: false, error: "skipped" }]);
  assert.deepEqual(sent, [["T-2", B], ["T-2", C]], "the image after the failed one is not tried");
  assert.deepEqual(await applyOperations([{ op: "attach_images", id: "T-77", images: [A] }], { post, board, attach }), [{ ok: false, error: "not_found" }]);
  assert.deepEqual(sent.length, 2);
});

// A conversation in which the owner sent images and the agent answered with a proposal, made through the real flow.
async function proposed(h, bytes, operations, { summary = "Put the images on a task" } = {}) {
  const images = [];
  for (const entry of bytes) images.push(await addImage(h, entry));
  const sent = await send(h, { images: images.map((image) => image.id) });
  const body = { summary, operations: operations(images) };
  const conversation = await finishTurn(h, h.runs.at(-1), { status: "complete", text: `Here is the plan.\n\n${fence(body)}` }, sent.conversationId);
  return { images, conversationId: sent.conversationId, message: conversation.messages.at(-1), proposal: conversation.messages.at(-1).proposal };
}

const applyProposal = (h, setup) => h.handle("apply", { repositoryId, conversationId: setup.conversationId, proposalId: setup.proposal.id });
const claimed = (h, setup, image) => path.join(h.directory, repositoryId, "images", setup.conversationId, `${image.id}.${{ png: "png", jpeg: "jpg", gif: "gif" }[image.type]}`);

function takeEverything(h) {
  h.state.actions = (action) => (action === "create" ? { ok: true, taskId: "T-9", board: readyBoard() } : { ok: true });
}

test("a finished turn whose proposal names an image the owner sent stores a pending proposal", async (context) => {
  const h = await chatHarness(context);
  const setup = await proposed(h, [pngBytes(1), jpegBytes(2)], ([a, b]) => [{ op: "create_task", text: "Match the mock-up", images: [a.id, b.id] }]);
  assert.equal(setup.proposal.state, "pending");
  assert.equal(setup.message.proposalUnreadable, undefined);
  assert.deepEqual(setup.proposal.operations, [{ op: "create_task", text: "Match the mock-up", images: setup.images.map((image) => image.id) }]);
});

test("a proposal that names an image ID the conversation never held is stored unreadable, with no proposal, but with its text", async (context) => {
  for (const operations of [
    () => [{ op: "create_task", text: "x", images: ["img-aaaaaaaaaaaa"] }],
    () => [{ op: "attach_images", id: "T-1", images: ["img-aaaaaaaaaaaa"] }],
    (images) => [{ op: "create_task", text: "x", images: [images[0].id] }, { op: "attach_images", id: "T-1", images: [images[0].id, "img-aaaaaaaaaaaa"] }],
  ]) {
    const h = await chatHarness(context);
    const setup = await proposed(h, [pngBytes(1)], operations);
    assert.equal(setup.proposal, undefined);
    assert.equal(setup.message.proposalUnreadable, true);
    assert.equal(setup.message.text, "Here is the plan.");
    assert.equal(h.actionCalls().length, 0);
  }
});

test("a staged image the owner never sent in a message is not a valid image of a proposal", async (context) => {
  const h = await chatHarness(context);
  const staged = await addImage(h, pngBytes(5));
  const sent = await send(h);
  const text = `Plan.\n\n${fence({ summary: "x", operations: [{ op: "create_task", text: "x", images: [staged.id] }] })}`;
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text }, sent.conversationId);
  assert.equal(conversation.messages.at(-1).proposal, undefined);
  assert.equal(conversation.messages.at(-1).proposalUnreadable, true);
});

test("an image of the first message is valid in a proposal after a later message", async (context) => {
  const h = await chatHarness(context);
  const first = await addImage(h, gifBytes(1));
  const sent = await send(h, { images: [first.id] });
  await finishTurn(h, h.runs[0], { status: "complete", text: "Seen." }, sent.conversationId);
  await send(h, { conversationId: sent.conversationId, text: "Put it on a task" });
  const text = `Plan.\n\n${fence({ summary: "x", operations: [{ op: "create_task", text: "x", images: [first.id] }] })}`;
  const conversation = await finishTurn(h, h.runs[1], { status: "complete", text }, sent.conversationId);
  assert.equal(conversation.messages.at(-1).proposal.state, "pending");
});

test("apply of a create with images posts create, then one image request per image with the exact bytes, then queue_add", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  const setup = await proposed(h, [pngBytes(1), jpegBytes(2), gifBytes(3)], (images) => [{ op: "create_task", text: "Match the mock-up", queue: true, images: images.map((image) => image.id) }]);
  const before = h.calls.length;
  assert.deepEqual(await applyProposal(h, setup), { ok: true });
  // The two requests after the apply are the reads of the follow-up Pomegr then asks of Aril.
  await h.followUp();
  const made = h.calls.slice(before);
  assert.deepEqual(made.map((call) => call.pathname), ["/api/tasks", "/internal/tasks/create", "/internal/tasks/image-add", "/internal/tasks/image-add", "/internal/tasks/image-add", "/internal/tasks/queue_add", "/api/tasks", "/internal/tasks/worktree-root"]);
  const sentBytes = [pngBytes(1), jpegBytes(2), gifBytes(3)];
  setup.images.forEach((image, index) => {
    const call = made[2 + index];
    assert.equal(call.init.method, "POST");
    assert.equal(call.contentType, "application/octet-stream");
    assert.equal(call.init.headers[DESKTOP_AUTH_HEADER], token);
    assert.equal(call.init.redirect, "error");
    assert.deepEqual(call.query, { repositoryId, taskId: "T-9", imageId: image.id });
    assert.equal(call.search, `?${new URLSearchParams({ repositoryId, taskId: "T-9", imageId: image.id })}`);
    assert.deepEqual(call.bytes, sentBytes[index]);
    assert.equal(call.body, null);
  });
  assert.deepEqual(made[5].body, { repositoryId, payload: { id: "T-9" } });
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.equal(stored.state, "applied");
  assert.deepEqual(stored.results, [{ ok: true, taskId: "T-9" }]);
});

test("apply of a create with images and no queue posts no queue_add", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }]);
  await applyProposal(h, setup);
  assert.deepEqual(h.actionCalls().map((call) => call.pathname.replace("/internal/tasks/", "")), ["create"]);
  assert.equal(h.imageCalls().length, 1);
});

test("an image the monitor refuses leaves a partial result with the task, no queue_add, and the later operations skipped", async (context) => {
  for (const error of ["limit", "conflict", "invalid", "not_found", "unsupported"]) {
    const h = await chatHarness(context);
    takeEverything(h);
    h.state.imageAdd = () => ({ ok: false, error });
    const setup = await proposed(h, [pngBytes(1), jpegBytes(2)], (images) => [
      { op: "create_task", text: "Match the mock-up", queue: true, images: images.map((image) => image.id) }, { op: "queue_task", id: "T-1" },
    ]);
    assert.deepEqual(await applyProposal(h, setup), { ok: true });
    assert.equal(h.imageCalls().length, 1, "the second image is not tried");
    assert.deepEqual(h.actionCalls().map((call) => call.pathname.replace("/internal/tasks/", "")), ["create"], "no queue_add");
    const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
    assert.equal(stored.state, "partial");
    assert.deepEqual(stored.results, [{ ok: false, error, taskId: "T-9", part: "images" }, { ok: false, error: "skipped" }], error);
  }
});

test("a monitor that does not answer, throws, or answers a different image gives unavailable at the image part", async (context) => {
  const answers = [
    () => { throw new Error("C:\\private\\boom"); }, () => ({ ok: true, imageId: "img-aaaaaaaaaaaa" }), () => ({ ok: true }), () => ({ ok: false, error: "C:\\private\\path" }), () => ({ ok: false }), () => null,
  ];
  for (const imageAdd of answers) {
    const h = await chatHarness(context);
    takeEverything(h);
    h.state.imageAdd = imageAdd;
    const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", queue: true, images: [a.id] }]);
    await applyProposal(h, setup);
    const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
    assert.equal(stored.state, "partial");
    assert.deepEqual(stored.results, [{ ok: false, error: "unavailable", taskId: "T-9", part: "images" }]);
    assert.equal(JSON.stringify(storedFiles(h.directory)).includes("private"), false);
  }
});

test("every image request is bounded in time and refuses redirects", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }]);
  await applyProposal(h, setup);
  const [call] = h.imageCalls();
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.cache, "no-store");
});

test("the second image failing leaves the first sent and the task named in the result", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  let count = 0;
  h.state.imageAdd = (call) => ((count += 1) === 2 ? { ok: false, error: "limit" } : { ok: true, imageId: call.query.imageId });
  const setup = await proposed(h, [pngBytes(1), jpegBytes(2), gifBytes(3)], (images) => [{ op: "create_task", text: "x", images: images.map((image) => image.id) }]);
  await applyProposal(h, setup);
  assert.equal(h.imageCalls().length, 2);
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.deepEqual(stored.results, [{ ok: false, error: "limit", taskId: "T-9", part: "images" }]);
});

test("attach_images puts the images on a task of the board and stores the proposal as applied", async (context) => {
  const h = await chatHarness(context);
  const setup = await proposed(h, [pngBytes(1), gifBytes(2)], (images) => [{ op: "attach_images", id: "T-1", images: images.map((image) => image.id) }]);
  const before = h.calls.length;
  assert.deepEqual(await applyProposal(h, setup), { ok: true });
  const calls = h.calls.slice(before).filter((call) => call.pathname.startsWith("/internal/") && call.pathname !== "/internal/tasks/worktree-root");
  assert.deepEqual(calls.map((call) => [call.pathname, call.query.taskId, call.query.imageId]), setup.images.map((image) => ["/internal/tasks/image-add", "T-1", image.id]));
  assert.deepEqual(calls.map((call) => call.bytes), [pngBytes(1), gifBytes(2)]);
  assert.equal(h.actionCalls().length, 0, "no task action ran");
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.equal(stored.state, "applied");
  assert.deepEqual(stored.results, [{ ok: true }]);
});

test("attach_images does not send an image the board's task already holds", async (context) => {
  const h = await chatHarness(context);
  const setup = await proposed(h, [pngBytes(1), gifBytes(2)], (images) => [{ op: "attach_images", id: "T-1", images: images.map((image) => image.id) }]);
  h.state.board.tasks[0].images = [{ id: setup.images[0].id, type: "png", bytes: setup.images[0].bytes }];
  await applyProposal(h, setup);
  await h.finishFollowUp(setup.conversationId);
  assert.deepEqual(h.imageCalls().map((call) => call.query.imageId), [setup.images[1].id]);
  const all = await proposed(h, [pngBytes(3)], ([a]) => [{ op: "attach_images", id: "T-2", images: [a.id] }]);
  h.state.board.tasks[1].images = [{ id: all.images[0].id, type: "png", bytes: all.images[0].bytes }];
  const count = h.imageCalls().length;
  await applyProposal(h, all);
  assert.equal(h.imageCalls().length, count, "nothing was sent");
  assert.equal((await h.reload().read(repositoryId, all.conversationId)).messages.at(-1).proposal.state, "applied");
});

test("attach_images on a task that is not on the board is not_found and sends nothing", async (context) => {
  const h = await chatHarness(context);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "attach_images", id: "T-77", images: [a.id] }]);
  await applyProposal(h, setup);
  assert.equal(h.imageCalls().length, 0);
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.equal(stored.state, "partial");
  assert.deepEqual(stored.results, [{ ok: false, error: "not_found" }]);
});

test("attach_images refused by the monitor stores the image part without a task ID", async (context) => {
  const h = await chatHarness(context);
  h.state.imageAdd = () => ({ ok: false, error: "conflict" });
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "attach_images", id: "T-2", images: [a.id] }, { op: "queue_task", id: "T-2" }]);
  await applyProposal(h, setup);
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.deepEqual(stored.results, [{ ok: false, error: "conflict", part: "images" }, { ok: false, error: "skipped" }]);
  assert.equal(h.actionCalls().length, 0);
});

test("an image file that is gone from the disk answers not_found at the image part and sends nothing", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", queue: true, images: [a.id] }]);
  await fs.rm(claimed(h, setup, setup.images[0]));
  await applyProposal(h, setup);
  assert.equal(h.imageCalls().length, 0);
  assert.deepEqual(h.actionCalls().map((call) => call.pathname.replace("/internal/tasks/", "")), ["create"]);
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.deepEqual(stored.results, [{ ok: false, error: "not_found", taskId: "T-9", part: "images" }]);
});

test("an image file whose bytes changed on disk is not sent", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }]);
  await fs.writeFile(claimed(h, setup, setup.images[0]), new TextEncoder().encode("<svg>not what the owner sent</svg>"));
  await applyProposal(h, setup);
  assert.equal(h.imageCalls().length, 0);
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.equal(stored.results[0].part, "images");
});

test("dismissing a proposal with images sends nothing and keeps the images", async (context) => {
  const h = await chatHarness(context);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }]);
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: setup.conversationId, proposalId: setup.proposal.id }), { ok: true });
  assert.equal(h.imageCalls().length, 0);
  assert.equal((await h.image("read", { repositoryId, conversationId: setup.conversationId, imageId: setup.images[0].id })).ok, true);
});

test("the stored conversation round-trips through a fresh store: images on the message and the operation, and the image part on the result", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  h.state.imageAdd = () => ({ ok: false, error: "limit" });
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }, { op: "attach_images", id: "T-1", images: [a.id] }]);
  await applyProposal(h, setup);
  const fresh = h.reload();
  const conversation = await fresh.read(repositoryId, setup.conversationId);
  assert.deepEqual(conversation.messages[0].images, setup.images);
  const proposal = conversation.messages.at(-1).proposal;
  assert.deepEqual(proposal.operations[1], { op: "attach_images", id: "T-1", images: [setup.images[0].id] });
  assert.deepEqual(proposal.results, [{ ok: false, error: "limit", taskId: "T-9", part: "images" }, { ok: false, error: "skipped" }]);
  assert.deepEqual(await fresh.save(repositoryId, conversation) && await fresh.read(repositoryId, setup.conversationId), conversation, "saving it again changes nothing");
});

test("the next turn's prompt says the images were not attached to the task, and not when they were", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  h.state.imageAdd = () => ({ ok: false, error: "limit" });
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }]);
  await applyProposal(h, setup);
  await h.finishFollowUp(setup.conversationId);
  await send(h, { conversationId: setup.conversationId, text: "Did it work?" });
  assert.match(h.runs.at(-1).options.prompt, /\[Proposal "Put the images on a task" with 1 operation\(s\): [^\]]*created T-9; the images were not attached to T-9[^\]]*\]/u);

  const ok = await chatHarness(context);
  takeEverything(ok);
  const good = await proposed(ok, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }]);
  await applyProposal(ok, good);
  await ok.finishFollowUp(good.conversationId);
  await send(ok, { conversationId: good.conversationId, text: "Did it work?" });
  assert.doesNotMatch(ok.runs.at(-1).options.prompt, /images were not attached/u);

  const attach = await chatHarness(context);
  attach.state.imageAdd = () => ({ ok: false, error: "conflict" });
  const only = await proposed(attach, [pngBytes(1)], ([a]) => [{ op: "attach_images", id: "T-3", images: [a.id] }]);
  await applyProposal(attach, only);
  await attach.finishFollowUp(only.conversationId);
  await send(attach, { conversationId: only.conversationId, text: "And now?" });
  assert.match(attach.runs.at(-1).options.prompt, /the images were not attached to T-3/u);
});

test("an operation after a successful image part still runs, in order", async (context) => {
  const h = await chatHarness(context);
  takeEverything(h);
  const setup = await proposed(h, [pngBytes(1)], ([a]) => [{ op: "create_task", text: "x", images: [a.id] }, { op: "queue_task", id: "T-2" }]);
  await applyProposal(h, setup);
  assert.deepEqual(h.actionCalls().map((call) => call.pathname.replace("/internal/tasks/", "")), ["create", "queue_add"]);
  const stored = (await h.reload().read(repositoryId, setup.conversationId)).messages.at(-1).proposal;
  assert.equal(stored.state, "applied");
  assert.deepEqual(stored.results, [{ ok: true, taskId: "T-9" }, { ok: true }]);
});
