import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { parseProviderSessionEvidence } from "../monitor/providers/provider-contract.mjs";
import { createRepositoryInventoryRuntime } from "../monitor/repository-inventory-runtime.mjs";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function gitRepository(t, prefix) {
  const root = await temporaryDirectory(t, prefix);
  await mkdir(path.join(root, "src"));
  execFileSync("git", ["-C", root, "init", "--quiet"], { stdio: "ignore" });
  return root;
}

function patch(target) {
  return `*** Begin Patch\n*** Add File: ${target}\n+export {};\n*** End Patch`;
}

async function providerWithEvidence(t, targets) {
  const codexHome = await temporaryDirectory(t, "pomegr-codex-attribution-home-");
  const launch = await temporaryDirectory(t, "pomegr-codex-clapline-");
  const rollout = path.join(codexHome, "sessions", "2026", "09", "27", "rollout-attribution.jsonl");
  await mkdir(path.dirname(rollout), { recursive: true });
  const records = [{ type: "session_meta", timestamp: "2026-09-27T10:00:00.000Z", payload: {
    id: "attribution-session", cwd: launch, source: "cli", git: { branch: "codex/clapline" },
  } }];
  for (const [index, target] of targets.entries()) {
    records.push(
      { type: "response_item", timestamp: `2026-09-27T10:00:0${index + 1}.000Z`, payload: {
        type: "function_call", name: "apply_patch", call_id: `patch-${index}`, arguments: JSON.stringify({ patch: patch(target) }),
      } },
      { type: "response_item", timestamp: `2026-09-27T10:00:1${index}.000Z`, payload: { type: "function_call_output", call_id: `patch-${index}` } },
    );
  }
  await writeFile(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const provider = createCodexProvider({ codexHome, cacheMs: 0, includeArchived: false });
  const registry = createProviderRegistry([provider]);
  const inventory = createRepositoryInventoryRuntime({
    registry, persistence: false, storeFile: path.join(codexHome, "inventory.json"),
  });
  await inventory.ready;
  provider.setRepositoryResolver(inventory.resolveRepository);
  // The launch directory is a plain (non-Git) temp directory here, so before any
  // mutation is proven the session-identity rule names the project after that
  // directory itself rather than claiming an unproven repository.
  assert.equal((await provider.listSessions())[0].project, path.basename(launch), "a non-Git launch directory still names the project by its own basename");
  const evidence = await provider.readSession("attribution-session", { historical: true });
  return { evidence, provider, inventory, launch };
}

test("Codex provider binds a mutation outside launch cwd to the real repository and retains no root", async (t) => {
  const repository = await gitRepository(t, "pomegr-codex-attribution-a-");
  const { evidence, provider, inventory, launch } = await providerWithEvidence(t, [path.join(repository, "src", "from-pomegr.ts")]);
  const parsed = parseProviderSessionEvidence(evidence);
  const { repositoryId } = await inventory.resolveRepository(repository, { requireGit: true });
  assert.equal(parsed.session.project, path.basename(repository));
  assert.equal(parsed.session.repositoryAttribution, "single");
  assert.equal(parsed.session.recordedGitBranch, "", "a Clapline launch branch is not a branch for the mutation repository");
  assert.deepEqual(parsed.toolCalls[0].fileChanges, [{ repositoryId, path: "src/from-pomegr.ts", kind: "created", previousPath: null }]);
  assert.equal(JSON.stringify(parsed).includes(repository), false);
  assert.equal(JSON.stringify(parsed).includes(launch), false);
  assert.equal(provider.repositoryAttributionForSession("attribution-session")?.state, "single");
});

test("Codex provider binds a mutation through a repository directory alias", async (t) => {
  const repository = await gitRepository(t, "pomegr-codex-attribution-alias-");
  const aliases = await temporaryDirectory(t, "pomegr-codex-alias-parent-");
  const alias = path.join(aliases, "linked-repository");
  await symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");
  const { evidence, inventory } = await providerWithEvidence(t, [path.join(alias, "src", "from-alias.ts")]);
  const { repositoryId } = await inventory.resolveRepository(repository, { requireGit: true });
  const parsed = parseProviderSessionEvidence(evidence);
  assert.equal(parsed.session.repositoryAttribution, "single");
  assert.equal(parsed.session.project, path.basename(repository));
  assert.deepEqual(parsed.toolCalls[0].fileChanges, [{ repositoryId, path: "src/from-alias.ts", kind: "created", previousPath: null }]);
});

test("Codex provider names the project from the launch directory when it is itself a Git repository, with no proven mutation and no restart memory", async (t) => {
  const codexHome = await temporaryDirectory(t, "pomegr-codex-attribution-home-");
  const launchRepository = await gitRepository(t, "pomegr-codex-attribution-launch-");
  const nestedLaunchCwd = path.join(launchRepository, "src");
  const rollout = path.join(codexHome, "sessions", "2026", "09", "27", "rollout-launch.jsonl");
  await mkdir(path.dirname(rollout), { recursive: true });
  const records = [{ type: "session_meta", timestamp: "2026-09-27T10:00:00.000Z", payload: {
    id: "launch-session", cwd: nestedLaunchCwd, source: "cli", git: { branch: "codex/clapline" },
  } }];
  await writeFile(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const provider = createCodexProvider({ codexHome, cacheMs: 0, includeArchived: false });
  const registry = createProviderRegistry([provider]);
  const inventory = createRepositoryInventoryRuntime({ registry, persistence: false, storeFile: path.join(codexHome, "inventory.json") });
  await inventory.ready;
  provider.setRepositoryResolver(inventory.resolveRepository);
  const { repositoryId } = await inventory.resolveRepository(launchRepository, { requireGit: true });

  // A fresh provider (in-memory attribution tracker is empty, as after a restart)
  // and no completed structured file edit yet: catalog rows must still show the
  // real repository, resolved purely from the launch cwd.
  const catalog = await provider.listSessions();
  assert.equal(catalog[0].project, path.basename(launchRepository));
  assert.equal(JSON.stringify(catalog).includes(launchRepository), false);
  assert.equal(JSON.stringify(catalog).includes(nestedLaunchCwd), false);

  const headers = [];
  await provider.enumerateSessionHeaders({ onBatch: (batch) => { headers.push(...batch); return true; } });
  const header = headers.find((entry) => entry.localId === "launch-session");
  assert.equal(header.project, path.basename(launchRepository));
  assert.equal(header.repositoryId, repositoryId);
  assert.equal(JSON.stringify(headers).includes(launchRepository), false);
  assert.equal(JSON.stringify(headers).includes(nestedLaunchCwd), false);

  const evidence = await provider.readSession("launch-session", { historical: true });
  const parsed = parseProviderSessionEvidence(evidence);
  assert.equal(parsed.session.project, path.basename(launchRepository));
  assert.equal(parsed.session.repositoryAttribution, "single");
  assert.equal(parsed.session.repositoryId, repositoryId);
  assert.equal(parsed.session.recordedGitBranch, "codex/clapline", "the launch directory's own branch validates against its own repository");
  assert.equal(JSON.stringify(parsed).includes(launchRepository), false);
  assert.equal(JSON.stringify(parsed).includes(nestedLaunchCwd), false);
  assert.equal(provider.repositoryAttributionForSession("launch-session")?.state, "single");
});

test("Codex provider marks two proven mutation repositories as multiple and keeps each binding", async (t) => {
  const first = await gitRepository(t, "pomegr-codex-attribution-first-");
  const second = await gitRepository(t, "pomegr-codex-attribution-second-");
  const { evidence, provider, inventory } = await providerWithEvidence(t, [path.join(first, "src", "one.ts"), path.join(second, "src", "two.ts")]);
  const parsed = parseProviderSessionEvidence(evidence);
  const [one, two] = await Promise.all([
    inventory.resolveRepository(first, { requireGit: true }), inventory.resolveRepository(second, { requireGit: true }),
  ]);
  assert.equal(parsed.session.project, "Multiple repositories");
  assert.equal(parsed.session.repositoryAttribution, "multiple");
  assert.deepEqual(parsed.toolCalls.map((call) => call.fileChanges?.[0]?.repositoryId), [one.repositoryId, two.repositoryId]);
  assert.equal(provider.repositoryAttributionForSession("attribution-session")?.state, "multiple");
});
