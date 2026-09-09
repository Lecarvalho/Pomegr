import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { createProviderFoldersSnapshot } from "../monitor/provider-folders.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function requestStatus(origin, headers, body = "") {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port, path: "/api/provider-folders", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("registry captures the active adapters' effective configured roots", () => {
  const root = path.resolve("provider-folders-fixture");
  const claudeConfigDir = path.join(root, "claude");
  const claudeProjectsDir = path.join(root, "claude-projects");
  const codexHome = path.join(root, "codex");
  const registry = createProviderRegistry([
    createClaudeProvider({ homeDir: root, env: { CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_PROJECTS_DIR: claudeProjectsDir } }),
    createCodexProvider({ homeDir: root, env: { CODEX_HOME: codexHome } }),
  ]);
  assert.deepEqual(registry.providerFolders, { folders: {
    claudeConfigDir, claudeProjectsDir, codexHome,
  } });
});

test("folder snapshots reject malformed roots and retain only fixed fields", () => {
  const snapshot = createProviderFoldersSnapshot([
    { id: "claude", providerFolders: { claudeConfigDir: "relative", claudeProjectsDir: "x".repeat(4_097), private: path.resolve("private") } },
    { id: "codex", providerFolders: { codexHome: `bad\u0000root`, extra: path.resolve("private") } },
  ]);
  assert.deepEqual(snapshot, { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: null } });
});

test("provider folder serving is fixed, cache-free, and cannot acquire provider data", async (context) => {
  let snapshots = 0;
  let acquisitions = 0;
  const runtime = {
    providerFolders() {
      snapshots += 1;
      return { folders: { claudeConfigDir: path.resolve("claude"), claudeProjectsDir: "relative", codexHome: `bad\u0000root`, private: path.resolve("private") } };
    },
    async sessionCatalog() { acquisitions += 1; return []; },
  };
  const server = http.createServer(createRequestHandler({ runtime }));
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${origin}/api/provider-folders`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await response.json(), { folders: { claudeConfigDir: path.resolve("claude"), claudeProjectsDir: null, codexHome: null } });
  assert.equal(snapshots, 1);
  assert.equal(acquisitions, 0);
  assert.equal((await fetch(`${origin}/api/provider-folders`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/api/provider-folders?root=private`)).status, 400);
  assert.equal(await requestStatus(origin, { "Content-Length": "1" }, "x"), 400);
  assert.equal((await fetch(`${origin}/api/provider-folders`, { headers: { Origin: "https://untrusted.example" } })).status, 401);
  assert.equal(await requestStatus(origin, { Host: "localhost:1" }), 401);
});

test("provider folder reads honor desktop authorization", async (context) => {
  const server = http.createServer(createRequestHandler({
    runtime: { providerFolders: () => ({ folders: {} }) }, authorizationToken: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  }));
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await fetch(`${origin}/api/provider-folders`)).status, 401);
  assert.equal((await fetch(`${origin}/api/provider-folders`, { headers: { "x-pomegr-desktop-authorization": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" } })).status, 200);
});
