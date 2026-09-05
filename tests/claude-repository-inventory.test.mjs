import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CLAUDE_REPOSITORY_INVENTORY_ARGS, createClaudeRepositoryInventoryCapture } from "../monitor/providers/claude-repository-inventory.mjs";

test("Claude repository capture uses fixed safe arguments and returns only normalized inventory", async () => {
  let invocation;
  const spawn = (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ result: "## Context Usage\n**Model:** claude-test\n\n| Category | Tokens | Percentage |\n|---|---:|---:|\n| System prompt | 1.2k | 12% |\n| Messages | 8k | 80% |\n\n### Tools\n| Tool | Tokens |\n|---|---:|\n| Read | 200 |" }));
      child.emit("exit", 0);
    });
    return child;
  };
  const capture = createClaudeRepositoryInventoryCapture({ environment: { POMEGR_CLAUDE_EXECUTABLE: "C:\\Tools\\claude.exe", USERPROFILE: "C:\\Users\\test", PATH: "C:\\Tools" },
    fileExists: () => true, spawn, platform: "win32", now: () => Date.parse("2026-09-04T10:00:00.000Z") });
  const result = await capture({ cwd: "C:\\repo" });
  assert.equal(result.status, "completed");
  assert.deepEqual(invocation.args, [...CLAUDE_REPOSITORY_INVENTORY_ARGS]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, "C:\\repo");
  assert.equal(result.inventory.machineryTokens, 1200);
  assert.deepEqual(result.inventory.categories.map(({ name }) => name), ["System prompt"]);
  assert.equal(JSON.stringify(result).includes("Messages"), false);
});

test("Claude repository capture reports an unavailable executable without spawning", async () => {
  const capture = createClaudeRepositoryInventoryCapture({ environment: { POMEGR_CLAUDE_EXECUTABLE: "C:\\missing\\claude.exe" },
    fileExists: () => false, platform: "win32", spawn() { throw new Error("must not spawn"); } });
  assert.deepEqual(await capture({ cwd: "C:\\repo" }), { status: "unavailable", failureKind: "executable_unavailable" });
});

test("Claude repository capture bounds runtime and output without retaining provider text", async () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const options = { environment: { POMEGR_CLAUDE_EXECUTABLE: "C:\\Tools\\claude.exe", PRIVATE_SECRET: "never-forward" },
    fileExists: () => true, spawn, platform: "win32", timeoutMs: 1_000 };
  const timed = createClaudeRepositoryInventoryCapture(options)({ cwd: "C:\\repo" });
  assert.deepEqual(await timed, { status: "timed_out", failureKind: "timed_out" });
  assert.equal(children[0].killed, true);

  const overflowCapture = createClaudeRepositoryInventoryCapture({ ...options, timeoutMs: 5_000 });
  const overflow = overflowCapture({ cwd: "C:\\repo" });
  await new Promise((resolve) => setImmediate(resolve));
  children[1].stdout.write(Buffer.alloc(129 * 1024, 65));
  children[1].emit("exit", 1);
  assert.deepEqual(await overflow, { status: "failed", failureKind: "invalid_output" });
});
