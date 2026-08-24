import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("Pomegr repository exposes a standard provider-neutral Codex marketplace plugin", async () => {
  const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));

  assert.equal(marketplace.name, "pomegr");
  assert.equal(marketplace.plugins[0].name, "pomegr");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/pomegr");
  assert.equal(manifest.name, "pomegr");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcpServers.pomegr.command, "node");
  assert.equal(mcp.mcpServers.pomegr.args[0], "./mcp/server.bundle.mjs");
  assert.equal(mcp.mcpServers.pomegr.cwd, ".");
  assert.doesNotMatch(JSON.stringify({ manifest, mcp }), /claude|anthropic/i);
});

test("installed Codex plugin starts without repository dependencies and lists bounded signal tools", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const installedPlugin = path.join(temporaryRoot, "installed-pomegr");
    const runtimeCwd = path.join(temporaryRoot, "runtime");
    await cp(pluginRoot, installedPlugin, { recursive: true });
    await mkdir(runtimeCwd, { recursive: true });
    await assert.rejects(access(path.join(installedPlugin, "node_modules")), { code: "ENOENT" });

    const tools = await readMcpToolInventory(path.join(installedPlugin, "mcp", "server.bundle.mjs"), runtimeCwd);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "clear_agent_signal",
      "clear_session_signal",
      "report_agent_signal",
      "report_session_signal",
      "report_task_signal",
    ]);
    assert.ok(tools.every((tool) => !JSON.stringify(tool).includes("anthropic/alwaysLoad")));
  });
});

test("client guide uses only standard Codex marketplace commands", async () => {
  const guide = await readFile(path.join(repositoryRoot, "docs", "CODEX_PLUGIN.md"), "utf8");
  assert.match(guide, /codex plugin marketplace add Lecarvalho\/pomegr --ref main/);
  assert.match(guide, /codex plugin add pomegr@pomegr/);
  assert.doesNotMatch(guide, /install-codex-plugin|client-repository|--dry-run/);
});
