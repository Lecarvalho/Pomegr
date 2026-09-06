import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudePluginSetupReader } from "../monitor/providers/claude-plugin-setup.mjs";
import { createCodexPluginSetupReader } from "../monitor/providers/codex-plugin-setup.mjs";

async function json(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value)}\n`); }

test("Claude reader resolves the effective project installation and enablement", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  const install = path.join(home, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pomegr@pomegr": [{ scope: "user", version: "0.5.0", installPath: path.join(home, "plugins", "cache", "pomegr", "pomegr", "0.5.0") }, { scope: "project", projectPath: cwd, version: "0.6.0", installPath: install }] } });
  await json(path.join(install, ".claude-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await json(path.join(home, "plugins", "known_marketplaces.json"), { pomegr: { source: { source: "github", repo: "Lecarvalho/pomegr" } } });
  await json(path.join(home, "settings.json"), { enabledPlugins: { "pomegr@pomegr": true } });
  await json(path.join(cwd, ".claude", "settings.json"), { enabledPlugins: { "pomegr@pomegr": false } });
  const result = await createClaudePluginSetupReader({ homeDir: root, configRoot: home })({ cwd });
  assert.deepEqual(result, { installation: "installed", version: "0.6.0", enabled: false, scope: "project", privateAction: { marketplaceRegistered: true, ref: null, sourceTrusted: true } });
});

test("Claude reader fails closed for ambiguous same-scope records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  await json(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pomegr@pomegr": [{ scope: "user", version: "0.5.0", installPath: path.join(home, "a") }, { scope: "user", version: "0.6.0", installPath: path.join(home, "b") }] } });
  const result = await createClaudePluginSetupReader({ homeDir: root, configRoot: home })(cwd);
  assert.equal(result.installation, "unknown");
});

test("Claude keeps enablement unknown without an explicit setting and survives invalid registry JSON", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  const install = path.join(home, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pomegr@pomegr": { scope: "user", version: "0.6.0", installPath: install } } });
  await json(path.join(install, ".claude-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  const result = await createClaudePluginSetupReader({ configRoot: home })({ cwd });
  assert.equal(result.enabled, null);
  await writeFile(path.join(home, "plugins", "installed_plugins.json"), "not-json\n");
  assert.equal((await createClaudePluginSetupReader({ configRoot: home })({ cwd })).installation, "unknown");
});

test("Claude reports first install when the installed registry does not exist", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  await json(path.join(home, "plugins", "known_marketplaces.json"), { pomegr: { source: { source: "github", repo: "Lecarvalho/pomegr" } } });
  const result = await createClaudePluginSetupReader({ configRoot: home })({ cwd });
  assert.equal(result.installation, "not_installed");
  assert.equal(result.privateAction.sourceTrusted, true);
});

test("Claude invalid project settings fail closed for action provenance", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  const install = path.join(home, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pomegr@pomegr": { scope: "user", version: "0.6.0", installPath: install } } });
  await json(path.join(install, ".claude-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await json(path.join(home, "plugins", "known_marketplaces.json"), { pomegr: { source: { source: "github", repo: "Lecarvalho/pomegr" } } });
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), "not-json\n");
  const result = await createClaudePluginSetupReader({ configRoot: home })({ cwd });
  assert.equal(result.enabled, null);
  assert.equal(result.privateAction.sourceTrusted, false);
});

test("Claude invalid settings stay unknown despite a later valid override", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  const install = path.join(home, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pomegr@pomegr": { scope: "user", version: "0.6.0", installPath: install } } });
  await json(path.join(install, ".claude-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await json(path.join(home, "plugins", "known_marketplaces.json"), { pomegr: { source: { source: "github", repo: "Lecarvalho/pomegr" } } });
  await json(path.join(home, "settings.json"), { enabledPlugins: { "pomegr@pomegr": true } });
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: [] }));
  await json(path.join(cwd, ".claude", "settings.local.json"), { enabledPlugins: { "pomegr@pomegr": true } });
  const result = await createClaudePluginSetupReader({ configRoot: home })({ cwd });
  assert.equal(result.enabled, null);
  assert.equal(result.privateAction.sourceTrusted, false);
});

test("Codex reader resolves manifest, enablement, trusted source and pin", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(install, ".codex-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr]\nlast_updated = "2026-09-06T12:00:00Z"\nlast_revision = "abc123"\nsource_type = "git"\nsource = "https://github.com/Lecarvalho/pomegr.git"\nref = "v0.6.0"\n\n[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.deepEqual(result, { installation: "installed", version: "0.6.0", enabled: true, scope: "user", privateAction: { marketplaceRegistered: true, ref: "v0.6.0", sourceTrusted: true } });
});

test("unregistered marketplace keeps the official default provenance", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(install, ".codex-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await writeFile(path.join(root, "config.toml"), `[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })();
  assert.deepEqual(result.privateAction, { marketplaceRegistered: false, ref: null, sourceTrusted: true });
});

test("Codex reports first install when a complete config has no cache yet", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr]\nsource_type = "git"\nsource = "https://github.com/Lecarvalho/pomegr.git"\nref = "main"\n\n[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(result.installation, "not_installed");
  assert.equal(result.privateAction.ref, "main");
});

test("Codex treats malformed cache manifests as unknown", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0", ".codex-plugin");
  await mkdir(install, { recursive: true });
  await writeFile(path.join(install, "plugin.json"), "not-json\n");
  await writeFile(path.join(root, "config.toml"), `[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(result.installation, "unknown");
});

test("Codex treats any malformed cached release as unknown", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await json(path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.5.0", ".codex-plugin", "plugin.json"), { name: "pomegr", version: "0.5.0" });
  await mkdir(path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0", ".codex-plugin"), { recursive: true });
  await writeFile(path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0", ".codex-plugin", "plugin.json"), "not-json\n");
  await writeFile(path.join(root, "config.toml"), `[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })();
  assert.equal(result.installation, "unknown");
});

test("Codex project config overrides global plugin and marketplace records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(install, ".codex-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr]\nsource_type = "git"\nsource = "https://github.com/Lecarvalho/pomegr.git"\nref = "main"\n\n[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const cwd = path.join(root, "repo");
  await mkdir(path.join(cwd, ".codex"), { recursive: true });
  await writeFile(path.join(cwd, ".codex", "config.toml"), `[marketplaces.pomegr]\nsource_type = "git"\nsource = "https://example.invalid/other.git"\nref = "feature"\n\n[plugins."pomegr@pomegr"]\nenabled = false\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })({ cwd });
  assert.equal(result.enabled, false);
  assert.equal(result.privateAction.ref, "feature");
  assert.equal(result.privateAction.sourceTrusted, false);
});

test("Codex accepts nested Git marketplace source records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(install, ".codex-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr]\nsource = { type = "git", url = "https://github.com/Lecarvalho/pomegr.git", ref = "v0.6.0" }\n\n[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(result.privateAction.sourceTrusted, true);
  assert.equal(result.privateAction.ref, "v0.6.0");
});

test("Codex selects the highest comparable cached release when an older cache remains", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const version of ["0.5.0", "0.6.0"]) {
    await json(path.join(root, "plugins", "cache", "pomegr", "pomegr", version, ".codex-plugin", "plugin.json"), { name: "pomegr", version });
  }
  await writeFile(path.join(root, "config.toml"), `[plugins."pomegr@pomegr"]\nenabled = true\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(result.installation, "installed");
  assert.equal(result.version, "0.6.0");
});

test("Codex managed requirements override project enablement", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  const programData = path.join(root, "program-data");
  context.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "plugins", "cache", "pomegr", "pomegr", "0.6.0");
  await json(path.join(install, ".codex-plugin", "plugin.json"), { name: "pomegr", version: "0.6.0" });
  await writeFile(path.join(root, "config.toml"), `[plugins."pomegr@pomegr"]\nenabled = true\n`);
  await mkdir(path.join(programData, "OpenAI", "Codex"), { recursive: true });
  await writeFile(path.join(programData, "OpenAI", "Codex", "requirements.toml"), `[plugins."pomegr@pomegr"]\nenabled = false\n`);
  const result = await createCodexPluginSetupReader({ codexHome: root, env: { ProgramData: programData } })({ cwd: root });
  assert.equal(result.enabled, false);
});

test("Codex rejects duplicate or partial target TOML sections", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plugin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "config.toml"), `[plugins."pomegr@pomegr"]\nenabled = true\nenabled = false\n`);
  const duplicate = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(duplicate.installation, "unknown");
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr]\nsource =\n`);
  const partial = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(partial.installation, "unknown");
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr.source]\ntype = "git"\n`);
  const nested = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(nested.installation, "unknown");
  await writeFile(path.join(root, "config.toml"), `[marketplaces.pomegr]\nsource = { type = "git", url = "https://github.com/Lecarvalho/pomegr.git", extra = "reject" }\n`);
  const unsupported = await createCodexPluginSetupReader({ codexHome: root })({ cwd: root });
  assert.equal(unsupported.installation, "unknown");
});
