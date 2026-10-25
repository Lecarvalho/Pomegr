import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as chat from "../desktop/runtime/agent-chat.mjs";
import { boardSnapshot, composePrompt } from "../desktop/runtime/agent-chat-prompt.mjs";
import { chatHarness, finishTurn, pendingProposal, repositoryId, seed, send, until, withProposal } from "./helpers/agent-chat-harness.mjs";

const settledAt = "2026-10-20T12:00:00.000Z";
const changedAt = "2026-10-21T12:00:00.000Z";
const aril = { settings: { settledAt }, memory: [] };
async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".workflow-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const write = async (name, text = "synthetic workflow content") => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, windowsHide: true, encoding: "utf8", env: { ...process.env,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_AUTHOR_DATE: changedAt, GIT_COMMITTER_DATE: changedAt },
  });
  return { root, write, git };
}

test("workflow discovery uses existing fixed sources and at most 40 workflow files", async (t) => {
  const { root, write } = await fixture(t);
  const fixed = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", ".pomegr/signals.md"];
  for (const file of [...fixed, "README.md", ".github/ignored.md", ".github/workflows/bad..yml", `.github/workflows/${"x".repeat(190)}.yml`]) await write(file);
  for (let i = 0; i < 45; i++) await write(`.github/workflows/nested/${i}.yml`);
  const sources = await chat.workflowSources(root);
  assert.deepEqual(sources.filter((name) => !name.startsWith(".github/workflows/")).sort(), fixed.sort());
  assert.equal(sources.filter((name) => name.startsWith(".github/workflows/")).length, 40);
  for (const name of sources) assert.ok(chat.isWorkflowSourcePath(name));
  for (const name of ["../AGENTS.md", "/AGENTS.md", "README.md", ".github/workflows/../secret", ".github/workflows/x\n.yml", ".github/workflows/x\u0085.yml", `.github/workflows/${"a".repeat(201)}`]) assert.equal(chat.isWorkflowSourcePath(name), false, name);
});

test("temporary Git evidence detects strict commit dates, oldest memory time, staged and untracked changes", async (t) => {
  const { root, write, git } = await fixture(t);
  git("init", "--quiet");
  await write("AGENTS.md");
  await write(".github/workflows/check [one].yml");
  git("add", "."); git("commit", "--quiet", "-m", "workflow fixture");
  const changes = await chat.readWorkflowChanges(root, aril);
  assert.deepEqual(changes.map((entry) => entry.path).sort(), [".github/workflows/check [one].yml", "AGENTS.md"]);
  assert.ok(changes.every((entry) => entry.changedAt === changedAt && !entry.uncommitted));
  assert.deepEqual(await chat.readWorkflowChanges(root, { settings: { settledAt: changedAt }, memory: [] }), []);
  assert.deepEqual(await chat.readWorkflowChanges(root, { settings: { settledAt: changedAt }, memory: [{ updatedAt: Date.parse(settledAt) }] }), changes);
  assert.deepEqual(await chat.readWorkflowChanges(root, { settings: { settledAt: null }, memory: [{ updatedAt: Date.parse(settledAt) }] }), changes);
  await write("AGENTS.md", "edited"); git("add", "AGENTS.md");
  await write("CLAUDE.md");
  for (const file of ["AGENTS.md", "CLAUDE.md"]) await utimes(path.join(root, file), new Date(changedAt), new Date(changedAt));
  const dirty = await chat.readWorkflowChanges(root, { settings: { settledAt: "2099-01-01T00:00:00Z" }, memory: [] });
  assert.deepEqual(dirty.map((entry) => entry.path).sort(), ["AGENTS.md", "CLAUDE.md"]);
  assert.ok(dirty.every((entry) => entry.uncommitted && entry.changedAt === changedAt));
});

test("nothing settled skips discovery and omits the section; settled snapshots carry ISO times", async () => {
  assert.equal(await chat.readWorkflowChanges("does-not-exist", { settings: { settledAt: null }, memory: [] }), undefined);
  const board = { aril: { settings: { settledAt: null }, memory: [{ id: 1, text: "Rule", createdAt: 0, updatedAt: Date.parse(settledAt) }] } };
  assert.equal(boardSnapshot(board).memory[0].updatedAt, settledAt);
  assert.equal(boardSnapshot({ aril: { settings: {}, memory: [] } }).aril_settings.settledAt, null);
  assert.doesNotMatch(composePrompt({ board: {}, message: "hi" }), /\n<workflow_changes>\n/u);
  assert.match(composePrompt({ board, workflowChanges: [], message: "hi" }), /\n<workflow_changes>\nNo workflow source changed since your settings and memory were settled.\n<\/workflow_changes>/u);
  assert.match(composePrompt({ board, workflowChanges: [{ path: "AGENTS.md", changedAt, uncommitted: true }], message: "hi" }), /AGENTS\.md.*2026-10-21T12:00:00.000Z.*uncommitted/u);
});

test("Git failure and a total timeout produce only the fixed unknown line", async (t) => {
  const { root, write } = await fixture(t);
  await write("AGENTS.md");
  const failed = await chat.readWorkflowChanges(root, aril, { execFile: (_file, _args, _options, cb) => cb(new Error("private detail")) });
  assert.equal(failed, null);
  let signal;
  const start = Date.now();
  const timedOut = await chat.readWorkflowChanges(root, aril, { timeoutMs: 50, execFile: (_file, _args, options) => { signal = options.signal; } });
  assert.equal(timedOut, null);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 1000);
  for (const workflowChanges of [failed, timedOut]) {
    const prompt = composePrompt({ board: { aril }, workflowChanges, message: "hi" });
    assert.match(prompt, /\n<workflow_changes>\nWorkflow changes are unknown.\n<\/workflow_changes>/u);
    assert.ok(!prompt.includes(root) && !prompt.includes("private detail") && !prompt.includes("synthetic workflow content"));
  }
});

test("owner, follow-up and grant-write turns refresh workflow evidence in the resolved root", async (t) => {
  const { root, write } = await fixture(t);
  await write("AGENTS.md");
  let calls = 0;
  const h = await chatHarness(t, { execFile: (file, args, options, cb) => {
    assert.equal(file, "git"); assert.equal(options.cwd, root); assert.equal(options.shell, false);
    assert.ok(options.signal && options.timeout <= 5000);
    calls++;
    cb(null, args.includes("log") ? `${Date.parse(changedAt) / 1000}\n` : "");
  } });
  h.state.rootAnswer = { ok: true, root };
  h.state.board.aril = aril;
  const sent = await send(h);
  assert.match(h.runs[0].options.prompt, /\n<workflow_changes>\nAGENTS.md/u);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done" }, sent.conversationId);
  const afterOwner = calls;
  const proposal = pendingProposal();
  const conversation = await seed(h, { messages: withProposal(proposal) });
  await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId: proposal.id });
  const followUp = await h.followUp();
  assert.match(followUp.options.prompt, /\n<workflow_changes>\nAGENTS.md/u);
  await h.finishFollowUp(conversation.id);
  assert.ok(calls > afterOwner);
  const afterFollowUp = calls;
  const pending = h.chat.grantWrite({ repositoryId, plans: ["plan.md"] });
  const grant = await until(() => h.runs[2]);
  assert.match(grant.options.prompt, /\n<workflow_changes>\nAGENTS.md/u);
  grant.resolve({ status: "complete", text: "Nothing left" });
  assert.equal((await pending).ok, true);
  assert.ok(calls > afterFollowUp);
});
