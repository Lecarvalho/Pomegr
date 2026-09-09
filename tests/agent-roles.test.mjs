import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { customAgentType, normalizeAgentType, resolveAgentRole, roleConfigRoot, validateRoleConfig } from "../monitor/agent-roles.mjs";

test("custom display types come from bounded identifiers only when the role is unmapped", () => {
  const repositoryRoles = new Map();
  for (const [kind, expected] of [["codex-waiter", "codex-waiter"], ["queue-runner", "queue-runner"], ["local:Custom_Helper", "custom-helper"], ["a".repeat(64), "a".repeat(64)]]) {
    assert.equal(customAgentType(kind, resolveAgentRole({ kind, repositoryRoles })), expected);
  }
  for (const kind of [null, undefined, 42, "", "unknown", "UNAVAILABLE", "none", "null", "a".repeat(65), "helper\nsecret", "helper\u202E", "<script>", "C:\\private\\agent", "/private/agent", "private.txt", "https://host/helper", "agent with prose", "namespace:/private:helper"]) {
    assert.equal(customAgentType(kind, "unknown"), null);
  }
  for (const input of [{ id: "primary", kind: "queue-runner" }, { kind: "code-reviewer" }, { kind: "queue-runner", workflowId: "wf-1" }, { kind: "queue-runner", repositoryRoles: new Map([["queue-runner", "workflow-worker"]]) }]) {
    assert.equal(customAgentType(input.kind, resolveAgentRole({ repositoryRoles, ...input })), null);
  }
});

test("normalizes only the terminal provider namespace and resolves documented precedence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-agent-roles-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, ".pomegr"));
  await writeFile(path.join(root, ".pomegr", "roles.json"), JSON.stringify({
    version: 1,
    roles: { "cavecrew-builder": "reviewer" },
  }));

  assert.equal(normalizeAgentType("plugin:cavecrew_builder"), "cavecrew-builder");
  assert.equal(normalizeAgentType("  plugin:reviewer"), "reviewer");
  assert.equal(resolveAgentRole({ id: "primary", kind: "reviewer", cwd: root }), "orchestrator");
  assert.equal(resolveAgentRole({ kind: "plugin:cavecrew_builder", cwd: root }), "reviewer");
  assert.equal(resolveAgentRole({ kind: "custom-builder", cwd: root }), "builder");
  assert.equal(resolveAgentRole({ kind: "code-reviewer-builder", cwd: root }), "reviewer");
  assert.equal(resolveAgentRole({ kind: "approval-reviewer", cwd: root }), "reviewer");
  assert.equal(resolveAgentRole({ kind: "verify-build", cwd: root }), "tester");
  assert.equal(resolveAgentRole({ kind: "unknown", workflowId: "wf-1", cwd: root }), "workflow-worker");
  assert.equal(resolveAgentRole({ kind: "unknown", cwd: root }), "unknown");
});

test("ignores malformed role files and skips invalid rows without failing analysis", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-agent-roles-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const configDir = path.join(root, ".pomegr");
  await mkdir(configDir);
  const file = path.join(configDir, "roles.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    roles: { valid: "builder", "Not Normal": "reviewer", wrong: "not-a-role" },
  }));
  const partial = validateRoleConfig(root);
  assert.equal(partial.status, "ready");
  assert.deepEqual([...partial.roles], [["valid", "builder"]]);
  assert.equal(partial.errors.length, 2);

  await writeFile(file, "{");
  assert.equal(validateRoleConfig(root).status, "invalid");
  assert.equal(resolveAgentRole({ kind: "cavecrew-builder", cwd: root }), "builder");
});

test("loads the role file from the repository root when a session starts below it", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-agent-roles-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const nested = path.join(root, "packages", "dashboard");
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".pomegr"));
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(root, ".pomegr", "roles.json"), JSON.stringify({ version: 1, roles: { specialist: "researcher" } }));
  assert.equal(roleConfigRoot(nested), root);
  assert.equal(resolveAgentRole({ kind: "specialist", cwd: nested }), "researcher");
});
