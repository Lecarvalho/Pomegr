import assert from "node:assert/strict";
import { execFile as execFileChild, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from "node:fs/promises";
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

test("owner, follow-up and grant-write turns read the workflow evidence in the resolved root, and a source edited between turns shows up on the next one", async (t) => {
  const { root, write } = await fixture(t);
  await write("AGENTS.md");
  // A repository whose HEAD the key can read; the fake Git answers what the files say.
  await write(".git/HEAD", "ref: refs/heads/main\n");
  await write(".git/refs/heads/main", `${"a".repeat(40)}\n`);
  let calls = 0;
  let edited = false;
  const h = await chatHarness(t, { execFile: (file, args, options, cb) => {
    assert.equal(file, "git"); assert.equal(options.cwd, root); assert.equal(options.shell, false);
    assert.ok(options.signal && options.timeout <= 5000);
    calls++;
    cb(null, args.includes("log") ? `${Date.parse(changedAt) / 1000}\n` : edited ? " M AGENTS.md\0" : "");
  } });
  h.state.rootAnswer = { ok: true, root };
  h.state.board.aril = aril;
  const sent = await send(h);
  assert.match(h.runs[0].options.prompt, /\n<workflow_changes>\nAGENTS.md \S+ committed\n/u);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done" }, sent.conversationId);
  const afterOwner = calls;
  assert.ok(afterOwner > 0, "the first turn read Git");
  const proposal = pendingProposal();
  const conversation = await seed(h, { messages: withProposal(proposal) });
  await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId: proposal.id });
  const followUp = await h.followUp();
  assert.match(followUp.options.prompt, /\n<workflow_changes>\nAGENTS.md \S+ committed\n/u);
  await h.finishFollowUp(conversation.id);
  assert.equal(calls, afterOwner, "nothing changed since the last read, so the follow-up reads no Git");
  // The owner edits a workflow source between turns. The next turn, a grant write turn, tells it.
  edited = true;
  await write("AGENTS.md", "edited");
  const pending = h.chat.grantWrite({ repositoryId, plans: ["plan.md"] });
  const grant = await until(() => h.runs[2]);
  assert.match(grant.options.prompt, /\n<workflow_changes>\nAGENTS.md \S+ uncommitted\n/u);
  grant.resolve({ status: "complete", text: "Nothing left" });
  assert.equal((await pending).ok, true);
  assert.ok(calls > afterOwner, "the edit made the key differ, so Git was read again");
});

/** A reader that counts the processes it starts: around the real Git, or with `fake` answering every call with nothing. */
function countingReader({ fake = false, ...options } = {}) {
  const counter = { calls: 0 };
  // A real Git can be slow while the whole suite runs, so the five seconds of a read are not what these tests check.
  const reader = chat.createWorkflowReader({ timeoutMs: 60_000, ...options, execFile: (file, args, execOptions, callback) => { counter.calls += 1; return fake ? callback(null, "") : execFileChild(file, args, execOptions, callback); } });
  return { reader, counter };
}

async function committedFixture(t) {
  const made = await fixture(t);
  made.git("init", "--quiet", "--initial-branch=main");
  await made.write("AGENTS.md");
  await made.write(".github/workflows/check.yml");
  made.git("add", ".");
  made.git("commit", "--quiet", "-m", "workflow fixture");
  return made;
}

test("the workflow reader starts no Git process while the key is the same, whatever the settled time", async (t) => {
  const { root } = await committedFixture(t);
  const { reader, counter } = countingReader();
  const first = await reader.read(root, aril);
  assert.deepEqual(first.map((entry) => [entry.path, entry.uncommitted]).sort(), [[".github/workflows/check.yml", false], ["AGENTS.md", false]]);
  const full = counter.calls;
  assert.ok(full >= 3, "one log for each source and one status");
  assert.deepEqual(await reader.read(root, aril), first);
  assert.deepEqual(await reader.read(root, { settings: { settledAt: changedAt }, memory: [] }), [], "the changes follow the settled time, which is not part of the key");
  assert.deepEqual(await reader.read(root, { settings: { settledAt: null }, memory: [{ updatedAt: Date.parse(settledAt) }] }), first);
  assert.equal(counter.calls, full);
  assert.equal(await reader.read(root, { settings: { settledAt: null }, memory: [] }), undefined);
});

test("the workflow reader reads again after a source is edited, staged, or committed, and after one appears or goes", async (t) => {
  const { root, write, git } = await committedFixture(t);
  const { reader, counter } = countingReader();
  await reader.read(root, aril);
  let seen = counter.calls;
  const reread = async (what) => {
    const changes = await reader.read(root, aril);
    assert.ok(counter.calls > seen, `${what}: Git was read again`);
    seen = counter.calls;
    return changes;
  };
  const unchanged = async (what) => {
    await reader.read(root, aril);
    assert.equal(counter.calls, seen, `${what}: nothing was read`);
  };

  // An edit with the same size and a new time: only the time says so.
  const edit = new Date("2026-10-22T08:00:00.000Z");
  await write("AGENTS.md", "synthetic workflow contenT");
  await utimes(path.join(root, "AGENTS.md"), edit, edit);
  assert.deepEqual((await reread("an edit")).find((entry) => entry.path === "AGENTS.md"), { path: "AGENTS.md", changedAt: edit.toISOString(), uncommitted: true });
  await unchanged("the same edit again");
  // Staging it changes the index, not the file; it stays uncommitted.
  git("add", "AGENTS.md");
  assert.equal((await reread("staging")).find((entry) => entry.path === "AGENTS.md").uncommitted, true);
  await unchanged("the same index again");
  // A commit moves HEAD.
  git("commit", "--quiet", "-m", "edit the rules");
  assert.equal((await reread("a commit")).find((entry) => entry.path === "AGENTS.md").uncommitted, false);
  await unchanged("the same commit again");
  // A source that appears, and one that goes.
  await write("CLAUDE.md");
  assert.deepEqual((await reread("a new source")).find((entry) => entry.path === "CLAUDE.md"), { path: "CLAUDE.md", changedAt: (await stat(path.join(root, "CLAUDE.md"))).mtime.toISOString(), uncommitted: true });
  await rm(path.join(root, "CLAUDE.md"));
  assert.equal((await reread("a removed source")).some((entry) => entry.path === "CLAUDE.md"), false);
  await unchanged("nothing since");
  // An ignore rule can change what status reports for an untracked source.
  await write(".gitignore", "CONTRIBUTING.md\n");
  await reread("an ignore file");
});

test("a key that cannot be read, an unborn branch, and a read that failed all read Git every time", async (t) => {
  // No repository folder at all.
  const bare = await fixture(t);
  await bare.write("AGENTS.md");
  let { reader, counter } = countingReader({ fake: true });
  await reader.read(bare.root, aril);
  const once = counter.calls;
  await reader.read(bare.root, aril);
  assert.equal(counter.calls, once * 2, "no .git: a full read each time");
  // A HEAD that says nothing the key can use.
  await bare.write(".git/HEAD", "ref: refs/heads/missing\n");
  ({ reader, counter } = countingReader({ fake: true }));
  await reader.read(bare.root, aril);
  await reader.read(bare.root, aril);
  assert.equal(counter.calls, once * 2, "a ref that is neither loose nor packed: a full read each time");
  await bare.write(".git/HEAD", "ref: refs/heads/../../escape\n");
  await reader.read(bare.root, aril);
  assert.equal(counter.calls, once * 3, "a ref outside refs/ is never opened");
  // An unborn branch has no commit.
  const unborn = await fixture(t);
  unborn.git("init", "--quiet", "--initial-branch=main");
  await unborn.write("AGENTS.md");
  ({ reader, counter } = countingReader());
  await reader.read(unborn.root, aril);
  const first = counter.calls;
  await reader.read(unborn.root, aril);
  assert.equal(counter.calls, first * 2, "an unborn branch: a full read each time");
  // A read that failed keeps nothing: the next read is a full one, and only then is the answer kept.
  const { root } = await committedFixture(t);
  let failing = true;
  const reads = [];
  const flaky = chat.createWorkflowReader({ timeoutMs: 60_000, execFile: (file, args, options, callback) => {
    reads.push(args);
    if (failing) { callback(new Error("private detail")); return undefined; }
    return execFileChild(file, args, options, callback);
  } });
  assert.equal(await flaky.read(root, aril), null);
  const failed = reads.length;
  failing = false;
  assert.ok((await flaky.read(root, aril)).length > 0);
  assert.ok(reads.length > failed, "a full read after the failure");
  const kept = reads.length;
  await flaky.read(root, aril);
  assert.equal(reads.length, kept);
});

test("the workflow reader reads a linked worktree and packed refs without Git, and gives up its facts after a few minutes", async (t) => {
  const { root, git } = await committedFixture(t);
  git("branch", "side");
  const linked = path.join(root, ".linked-worktree");
  git("worktree", "add", "--quiet", linked, "side");
  let wall = 1_000_000;
  const { reader, counter } = countingReader({ now: () => wall, maxAgeMs: 5 * 60_000 });
  const first = await reader.read(linked, aril);
  assert.ok(first.length > 0);
  const full = counter.calls;
  await reader.read(linked, aril);
  assert.equal(counter.calls, full, "a linked worktree, whose .git is a file, has a key");
  // Packing the refs moves the commit from a loose file to packed-refs; it is the same commit.
  git("pack-refs", "--all");
  await reader.read(linked, aril);
  assert.equal(counter.calls, full, "a commit in packed-refs has a key");
  wall += 4 * 60_000;
  await reader.read(linked, aril);
  assert.equal(counter.calls, full);
  wall += 2 * 60_000;
  await reader.read(linked, aril);
  assert.equal(counter.calls, full * 2, "after the longest age the facts are read again");
});
