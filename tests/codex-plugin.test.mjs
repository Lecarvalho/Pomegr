import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "pomegr");

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readMcpToolInventory(server, cwd) {
  const child = spawn(process.execPath, [server], {
    cwd,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP tools/list. stderr: ${stderr}`)), 5_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!stdout.includes('"id":2')) reject(new Error(`MCP server exited with ${code}. stderr: ${stderr}`));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === 2) {
            clearTimeout(timer);
            resolve(message.result?.tools || []);
          }
        }
      });

      child.stdin.write(`${[
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pomegr-codex-plugin-test", version: "1.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ].map((request) => JSON.stringify(request)).join("\n")}\n`);
    });
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  }
}

test("Codex plugin hooks run under PowerShell after plugin-root expansion", { skip: process.platform !== "win32" }, async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const installedPlugin = path.join(temporaryRoot, "installed Pomegr plugin");
    const runtimeCwd = path.join(temporaryRoot, "runtime workspace");
    await cp(pluginRoot, installedPlugin, { recursive: true });
    await mkdir(runtimeCwd, { recursive: true });

    const hooks = JSON.parse(await readFile(path.join(installedPlugin, "hooks", "hooks.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(installedPlugin, ".codex-plugin", "plugin.json"), "utf8"));
    const cases = [
      ["SessionStart", { hook_event_name: "SessionStart", source: "startup", cwd: runtimeCwd }],
      ["SubagentStart", { hook_event_name: "SubagentStart", agent_type: "investigator", cwd: runtimeCwd }],
      ["SubagentStop", { hook_event_name: "SubagentStop", agent_type: "investigator", cwd: runtimeCwd }],
      ["PostToolUse", { hook_event_name: "PostToolUse", session_id: "test-session", tool_name: "exec_command", cwd: runtimeCwd }],
    ];

    for (const [event, payload] of cases) {
      const hook = hooks.hooks[event][0].hooks[0];
      const command = hook.command.replaceAll("${PLUGIN_ROOT}", installedPlugin.replaceAll("\\", "/"));
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: runtimeCwd,
        encoding: "utf8",
        input: JSON.stringify(payload),
      });
      assert.equal(result.status, 0, `${event} failed: ${result.stderr}`);

      if (event === "SessionStart") {
        const output = JSON.parse(result.stdout);
        assert.equal(
          output.hookSpecificOutput.additionalContext,
          `[Pomegr plugin metadata] ${JSON.stringify({
            pluginVersion: manifest.version,
            policyStatus: "missing",
            policyVersion: null,
          })}`,
        );
      }
    }
  });
});

test("installed Codex plugin starts without repository dependencies and lists bounded signal tools", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const installedPlugin = path.join(temporaryRoot, "installed-pomegr");
    const runtimeCwd = path.join(temporaryRoot, "runtime");
    await cp(pluginRoot, installedPlugin, { recursive: true });
    await mkdir(runtimeCwd, { recursive: true });
    await assert.rejects(access(path.join(installedPlugin, "node_modules")), { code: "ENOENT" });
    await access(path.join(installedPlugin, "hooks", "hooks.json"));
    await access(path.join(installedPlugin, "scripts", "policy.mjs"));
    const reminderPath = path.join(installedPlugin, "scripts", "progress-reminder.bundle.mjs");
    const guardPath = path.join(installedPlugin, "scripts", "usage-guard.bundle.mjs");
    await access(reminderPath);
    await access(guardPath);
    await access(path.join(installedPlugin, "skills", "init", "SKILL.md"));
    await access(path.join(installedPlugin, "skills", "doctor", "SKILL.md"));
    const reminder = spawnSync(process.execPath, [reminderPath], { cwd: runtimeCwd, encoding: "utf8", input: "{}" });
    assert.equal(reminder.status, 0);
    assert.equal(reminder.stdout, "");
    const guard = spawnSync(process.execPath, [guardPath, "--provider", "codex"], { cwd: runtimeCwd, encoding: "utf8", input: "{}" });
    assert.equal(guard.status, 0);
    assert.equal(guard.stdout, "");

    const tools = await readMcpToolInventory(path.join(installedPlugin, "mcp", "server.bundle.mjs"), runtimeCwd);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "clear_agent_signal",
      "clear_session_progress",
      "clear_session_signal",
      "get_agent_context",
      "get_provider_health",
      "get_recent_failures",
      "get_session_report",
      "get_usage_limits",
      "list_session_agents",
      "list_sessions",
      "report_agent_signal",
      "report_session_progress",
      "report_session_signal",
      "report_task_signal",
    ]);
    assert.ok(tools.every((tool) => !JSON.stringify(tool).includes("anthropic/alwaysLoad")));
  });
});

