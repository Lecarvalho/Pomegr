import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { createChatRunDeclarations } from "../../../../server/providers/kernel/chat-run-declarations.mjs";

// Two headless runs with the same registry shape: print mode, no transcript, a validated owner. Only the session ID
// tells Pomegr's own chat run apart from a `claude -p` the owner started by hand.
const declaredId = "0b7c2a4e-1f3d-4c5b-9a8e-7d6f5e4c3b2a";
const ownersId = "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-chat-run-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "sessions");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  const startedAt = Date.now() - 5_000;
  const register = (pid, sessionId) => writeFile(path.join(registryRoot, `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd: path.join(root, "repository"), startedAt, procStart: `start-${pid}`, kind: "interactive", entrypoint: "sdk-cli",
  }));
  await register(41, declaredId);
  await register(42, ownersId);
  let clock = Date.now();
  const declarations = createChatRunDeclarations({ now: () => clock });
  const provider = createClaudeProvider({
    homeDir: root, projectsRoot, registryRoot, chatRunDeclarations: declarations,
    registryProcessIdentities: () => new Map([[41, "start-41"], [42, "start-42"]]),
    registryProcessExists: () => true,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const headers = async () => {
    const rows = [];
    await provider.enumerateSessionHeaders({ onBatch: (batch) => { rows.push(...batch); return true; } });
    return rows.map((row) => row.localId).sort();
  };
  return { provider, declarations, headers, registryRoot, advance: (ms) => { clock += ms; } };
}

const listed = async (provider) => (await provider.listSessions()).map((entry) => entry.localId).sort();

test("a declared chat run never enters the catalog; an undeclared headless run of the same shape does", async (context) => {
  const { provider, declarations, headers } = await fixture(context);
  assert.deepEqual(await listed(provider), [declaredId, ownersId].sort(), "without a declaration both rows show, as today");
  assert.equal(declarations.declare(declaredId), true);
  assert.deepEqual(await listed(provider), [ownersId]);
  assert.deepEqual(await headers(), [ownersId], "the incremental catalog scan leaves it out too");
  assert.equal((await provider.listSessions())[0].isLive, true, "the owner's headless run stays live");
  assert.equal(await provider.readSession(declaredId), null);
});

test("a withdrawn declaration shows a still-present registration again", async (context) => {
  const { provider, declarations } = await fixture(context);
  declarations.declare(declaredId);
  assert.deepEqual(await listed(provider), [ownersId]);
  declarations.withdraw(declaredId);
  assert.deepEqual(await listed(provider), [declaredId, ownersId].sort());
});

test("an expired declaration shows a still-present registration again", async (context) => {
  const { provider, declarations, advance } = await fixture(context);
  declarations.declare(declaredId);
  advance(11 * 60_000 - 1);
  assert.deepEqual(await listed(provider), [ownersId]);
  advance(1);
  assert.deepEqual(await listed(provider), [declaredId, ownersId].sort());
});

test("a declaration hides nothing once the run's registration is gone", async (context) => {
  const { provider, declarations, registryRoot } = await fixture(context);
  declarations.declare(declaredId);
  await unlink(path.join(registryRoot, "41.json"));
  assert.deepEqual(await listed(provider), [ownersId]);
  declarations.declare(ownersId.replace(/^5/u, "6"));
  assert.deepEqual(await listed(provider), [ownersId], "a declaration matches only its own session ID");
});
