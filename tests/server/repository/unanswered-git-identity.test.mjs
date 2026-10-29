// A working directory Git does not answer for (a removed folder, a timeout, a failure) gets a folder-named identity
// for that read only. It is never cached as the repository's identity, never bound, and a later read asks Git again.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GIT_NOT_A_REPOSITORY } from "../../../server/repository/git-checkout.mjs";
import { createGitRootLookup, createRepositoryInventoryRuntime } from "../../../server/repository/repository-inventory-runtime.mjs";
import { GUESSED_ASSOCIATION_RETRY_MS, createSessionRepositoryAssociations } from "../../../server/repository/session-repository-association.mjs";

const MAIN = path.resolve("/work/Clapline");
const WORKTREE = path.join(MAIN, ".claude", "worktrees", "feature");
const SUBFOLDER = path.join(WORKTREE, "src", "frontend");

/** A Git stand-in: `answering` decides whether Git answers at all; a linked worktree names the main `.git`. */
function gitStandIn() {
  const git = { answering: false, reads: 0 };
  git.lookup = async (cwd) => {
    git.reads += 1;
    if (!git.answering) return null;
    const inside = (root) => cwd === root || cwd.startsWith(`${root}${path.sep}`);
    if (inside(WORKTREE)) return { root: WORKTREE, commonDir: path.join(MAIN, ".git") };
    if (inside(MAIN)) return { root: MAIN, commonDir: null };
    return null;
  };
  return git;
}

async function inventory(context, git) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-unanswered-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storeFile = path.join(directory, "inventory.json");
  const runtime = createRepositoryInventoryRuntime({ registry: { providers: [] }, storeFile, gitRoot: git.lookup });
  await runtime.ready;
  return { runtime, storeFile };
}

test("the Git root lookup keeps an answer for its time but reads again after no answer", async () => {
  let answer = null;
  let reads = 0;
  const lookup = createGitRootLookup(async () => { reads += 1; return answer; });
  assert.equal(await lookup(SUBFOLDER), null);
  assert.equal(await lookup(SUBFOLDER), null);
  assert.equal(reads, 2, "no answer is never served from the cache");
  answer = { root: MAIN, commonDir: null };
  assert.deepEqual(await lookup(SUBFOLDER), answer);
  assert.deepEqual(await lookup(SUBFOLDER), answer);
  assert.equal(reads, 3, "an answer is kept");
  // Git's answer that a folder is no repository is an answer too; it names no repository root.
  const notRepository = createGitRootLookup(async () => { reads += 1; return GIT_NOT_A_REPOSITORY; });
  assert.equal(await notRepository(MAIN), GIT_NOT_A_REPOSITORY);
  assert.equal(await notRepository(MAIN), GIT_NOT_A_REPOSITORY);
  assert.equal(reads, 4);
});

test("an unanswered Git read is not cached, and a later read gets the real repository ID", async (context) => {
  const git = gitStandIn();
  const { runtime } = await inventory(context, git);
  const guessed = await runtime.identify(SUBFOLDER);
  assert.equal(runtime.repositoryConfirmation(guessed.repositoryId), "guessed");
  assert.equal(await runtime.resolveRepository(SUBFOLDER, { requireGit: true }), null);

  git.answering = true;
  const real = await runtime.identify(SUBFOLDER);
  assert.notEqual(real.repositoryId, guessed.repositoryId, "the later read asks Git again");
  assert.deepEqual(real, await runtime.identify(MAIN), "a worktree subfolder belongs to its main repository");
  assert.equal(runtime.repositoryConfirmation(real.repositoryId), "confirmed");
  assert.equal(runtime.repositoryRoot(real.repositoryId), MAIN);
  assert.equal(runtime.repositoryConfirmation("repo-ffffffffffffffffffffffff"), "unknown");
});

test("a guess that hashes to a confirmed repository never downgrades it", async (context) => {
  const git = gitStandIn();
  git.answering = true;
  const { runtime } = await inventory(context, git);
  const main = await runtime.identify(MAIN);
  git.answering = false;
  // The main root itself, read while Git does not answer (a stalled monitor, for example), hashes to the same ID.
  assert.deepEqual(await runtime.identify(path.join(MAIN, ".")), main);
  assert.equal(runtime.repositoryConfirmation(main.repositoryId), "confirmed");
});

test("a session association binds only an identity Git confirmed", async (context) => {
  const git = gitStandIn();
  const { runtime, storeFile } = await inventory(context, git);
  const bindings = async () => JSON.parse(await readFile(storeFile, "utf8").catch(() => "{\"bindings\":[]}")).bindings;
  const guessed = await runtime.associateSession({ sessionId: "claude:removed-folder", provider: "claude", startedAt: "2026-10-29T00:42:00.000Z", cwd: SUBFOLDER });
  assert.equal(runtime.repositoryConfirmation(guessed.repositoryId), "guessed");
  assert.deepEqual(await bindings(), [], "no binding is stored for a guessed identity");

  git.answering = true;
  const confirmed = await runtime.associateSession({ sessionId: "claude:removed-folder", provider: "claude", startedAt: "2026-10-29T00:42:00.000Z", cwd: SUBFOLDER });
  assert.notEqual(confirmed.repositoryId, guessed.repositoryId);
  assert.deepEqual((await bindings()).map((entry) => [entry.sessionId, entry.repositoryId]), [["claude:removed-folder", confirmed.repositoryId]]);
});

test("a session association to a guessed identity is derived again after its retry time", async (context) => {
  const git = gitStandIn();
  const { runtime } = await inventory(context, git);
  let clock = Date.parse("2026-10-29T12:54:00.000Z");
  const changes = [];
  const associations = createSessionRepositoryAssociations({
    registry: { repositoryAttributionForSession: () => null }, inventory: runtime,
    previousReference: () => null, previousAssociation: () => null, onChange: (id) => changes.push(id), now: () => clock,
  });
  const candidate = { providerId: "claude", localSessionId: "removed-folder", evidence: { session: { cwd: SUBFOLDER, startedAt: null, repositoryAttribution: "launch" } } };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const changed = async (count) => { for (let wait = 0; changes.length < count && wait < 200; wait += 1) await settle(); };
  associations.get(candidate);
  await changed(1);
  const guessed = associations.get(candidate).repositoryId;
  assert.equal(runtime.repositoryConfirmation(guessed), "guessed");

  git.answering = true;
  const reads = git.reads;
  assert.equal(associations.get(candidate).repositoryId, guessed, "before its retry time the guess is served as it is");
  await settle();
  assert.equal(git.reads, reads, "no Git read before the retry time");

  clock += GUESSED_ASSOCIATION_RETRY_MS;
  associations.get(candidate);
  await changed(2);
  const confirmed = associations.get(candidate).repositoryId;
  assert.equal(confirmed, (await runtime.identify(MAIN)).repositoryId);
  assert.deepEqual(changes, ["claude:removed-folder", "claude:removed-folder"]);
  clock += GUESSED_ASSOCIATION_RETRY_MS;
  const settledReads = git.reads;
  associations.get(candidate);
  await settle();
  assert.equal(git.reads, settledReads, "a confirmed association is not derived again");
});
