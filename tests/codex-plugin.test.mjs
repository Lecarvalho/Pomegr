import assert from "node:assert/strict";
import { access, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCodexPlugin } from "../scripts/install-codex-plugin.mjs";

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

test("repo marketplace exposes the provider-neutral Pomegr Codex plugin", async () => {
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
    const clientRepository = path.join(temporaryRoot, "client-repository");
    await cp(pluginRoot, installedPlugin, { recursive: true });
    await mkdir(clientRepository, { recursive: true });
    await assert.rejects(access(path.join(installedPlugin, "node_modules")), { code: "ENOENT" });

    const tools = await readMcpToolInventory(path.join(installedPlugin, "mcp", "server.bundle.mjs"), clientRepository);
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

test("repo installer previews, installs, preserves other marketplace entries, and becomes idempotent", async () => {
  await withTemporaryDirectory(async (clientRepository) => {
    await mkdir(path.join(clientRepository, ".git"));
    const marketplacePath = path.join(clientRepository, ".agents", "plugins", "marketplace.json");
    const existingMarketplace = {
      name: "client-tools",
      interface: { displayName: "Client Tools" },
      plugins: [{
        name: "existing",
        source: { source: "local", path: "./plugins/existing" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      }],
    };
    await mkdir(path.dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, `${JSON.stringify(existingMarketplace, null, 2)}\n`, "utf8");

    const preview = await installCodexPlugin({ targetRepository: clientRepository, dryRun: true });
    assert.ok(preview.plugin.files.every((file) => file.action === "create"));
    assert.equal(preview.marketplace.action, "update");
    await assert.rejects(access(path.join(clientRepository, "plugins", "pomegr")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(marketplacePath, "utf8")), existingMarketplace);

    const installed = await installCodexPlugin({ targetRepository: clientRepository });
    assert.equal(installed.marketplace.action, "update");
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
    assert.equal(marketplace.name, "client-tools");
    assert.equal(marketplace.interface.displayName, "Client Tools");
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ["existing", "pomegr"]);
    assert.equal(marketplace.plugins[1].source.path, "./plugins/pomegr");

    const installedTools = await readMcpToolInventory(
      path.join(clientRepository, "plugins", "pomegr", "mcp", "server.bundle.mjs"),
      clientRepository,
    );
    assert.deepEqual(installedTools.map((tool) => tool.name).sort(), [
      "clear_agent_signal",
      "clear_session_signal",
      "report_agent_signal",
      "report_session_signal",
      "report_task_signal",
    ]);

    const secondPreview = await installCodexPlugin({ targetRepository: clientRepository, dryRun: true });
    assert.ok(secondPreview.plugin.files.every((file) => file.action === "unchanged"));
    assert.equal(secondPreview.marketplace.action, "unchanged");
  });
});

test("repo installer refuses to overwrite a plugin directory owned by another package", async () => {
  await withTemporaryDirectory(async (clientRepository) => {
    await mkdir(path.join(clientRepository, ".git"));
    const manifestPath = path.join(clientRepository, "plugins", "pomegr", ".codex-plugin", "plugin.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{"name":"not-pomegr"}\n', "utf8");

    await assert.rejects(
      installCodexPlugin({ targetRepository: clientRepository, dryRun: true }),
      /Refusing to overwrite a non-Pomegr plugin directory/,
    );
  });
});

test("repo installer refuses unmanaged files in an existing Pomegr plugin directory", async () => {
  await withTemporaryDirectory(async (clientRepository) => {
    await mkdir(path.join(clientRepository, ".git"));
    const destination = path.join(clientRepository, "plugins", "pomegr");
    await cp(pluginRoot, destination, { recursive: true });
    await writeFile(path.join(destination, "unmanaged-hook.mjs"), "// must not survive an update\n", "utf8");

    await assert.rejects(
      installCodexPlugin({ targetRepository: clientRepository, dryRun: true }),
      /Refusing to leave unmanaged files in the Pomegr plugin directory/,
    );
  });
});

test("repo installer preserves custom metadata on an existing Pomegr marketplace entry", async () => {
  await withTemporaryDirectory(async (clientRepository) => {
    await mkdir(path.join(clientRepository, ".git"));
    const marketplacePath = path.join(clientRepository, ".agents", "plugins", "marketplace.json");
    await mkdir(path.dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, `${JSON.stringify({
      name: "client-tools",
      plugins: [{
        name: "pomegr",
        source: { source: "local", path: "./old/pomegr" },
        policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE", products: ["Codex"] },
        category: "Development",
        clientNote: "preserve me",
      }],
    }, null, 2)}\n`, "utf8");

    await installCodexPlugin({ targetRepository: clientRepository });
    const entry = JSON.parse(await readFile(marketplacePath, "utf8")).plugins[0];
    assert.equal(entry.source.path, "./plugins/pomegr");
    assert.deepEqual(entry.policy, {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_USE",
      products: ["Codex"],
    });
    assert.equal(entry.category, "Development");
    assert.equal(entry.clientNote, "preserve me");
  });
});

test("repo installer rejects symbolic-link escapes in managed target paths", async () => {
  for (const managedRoot of ["plugins", ".agents"]) {
    await withTemporaryDirectory(async (temporaryRoot) => {
      const clientRepository = path.join(temporaryRoot, "client");
      const external = path.join(temporaryRoot, "external");
      await mkdir(path.join(clientRepository, ".git"), { recursive: true });
      await mkdir(external);
      await symlink(external, path.join(clientRepository, managedRoot), process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        installCodexPlugin({ targetRepository: clientRepository, dryRun: true }),
        /Refusing to write through a symbolic link/,
      );
    });
  }
});
