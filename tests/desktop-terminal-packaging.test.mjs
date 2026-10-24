import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyFiles, getFileMatchers, getNodeModuleFileMatcher } from "app-builder-lib/out/fileMatcher.js";
import {
  NODE_EXE_SHA256, NODE_LICENSE_SHA256, NODE_VERSION, TERMINAL_HOST_FILES, TERMINAL_MODULE_FILES,
  assertTerminalRuntime, ensureTerminalNode, writeTerminalManifest,
} from "../desktop/packaging/terminal-runtime.mjs";
import { NODE_PTY_UNPACKED_FILES } from "../desktop/packaging/asar-policy.mjs";

test("terminal packaging pins the tested official Node distribution and fails closed on download or cache corruption", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-node-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(NODE_VERSION, "24.14.0");
  assert.equal(NODE_EXE_SHA256, "63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088");
  let calls = 0;
  const fetchBytes = async (url) => {
    calls += 1;
    assert.equal(url, "https://nodejs.org/dist/v24.14.0/win-x64/node.exe");
    return Buffer.from("corrupt executable");
  };
  await assert.rejects(ensureTerminalNode(root, { fetchBytes }), /DESKTOP_TERMINAL_NODE_HASH_MISMATCH/);
  const cache = path.join(root, "outputs", "terminal-node", `node-v${NODE_VERSION}-win-x64.exe`);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, "corrupt cached executable");
  await assert.rejects(ensureTerminalNode(root, { fetchBytes }), /DESKTOP_TERMINAL_NODE_HASH_MISMATCH/);
  assert.equal(calls, 1, "a corrupt cache is refused instead of silently replaced");
});

test("terminal resource manifest covers exactly the slim redistributable, with deterministic content identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-terminal-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = ["node.exe", "LICENSE", ...TERMINAL_HOST_FILES, ...TERMINAL_MODULE_FILES].sort();
  for (const file of expected) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `fixture:${file}`);
  }
  const manifest = await writeTerminalManifest(root);
  assert.deepEqual(Object.keys(manifest.files), expected);
  assert.equal(manifest.buildId, createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex"));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")), manifest);
  await assert.rejects(assertTerminalRuntime(root), /DESKTOP_TERMINAL_RUNTIME_DISTRIBUTION_INVALID/);
  await writeFile(path.join(root, "state.json"), "private state");
  await assert.rejects(assertTerminalRuntime(root), /DESKTOP_TERMINAL_RUNTIME_FILE_SET_INVALID/);
  await rm(path.join(root, "state.json"));
  await writeFile(path.join(root, TERMINAL_HOST_FILES[0]), "changed script");
  await assert.rejects(assertTerminalRuntime(root), /DESKTOP_TERMINAL_RUNTIME_HASH_MISMATCH/);
});

test("production packaging includes the host and permits exactly the measured ConPTY native inventory", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["node-pty"], "1.1.0");
  assert.equal(pkg.build.npmRebuild, false, "packaging retains the accepted upstream Node-API prebuilds");
  assert.equal(lock.packages["node_modules/node-pty"].version, "1.1.0");
  assert.equal(lock.packages["node_modules/node-addon-api"].version, "7.1.1");
  const license = (await readFile(new URL("../desktop/packaging/node-LICENSE.txt", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(license).digest("hex"), NODE_LICENSE_SHA256);
  assert.deepEqual(NODE_PTY_UNPACKED_FILES, [
    "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
    "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node",
    "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
    "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
  ]);
  for (const file of [...TERMINAL_HOST_FILES, "desktop/runtime/terminal-host-client.mjs", "desktop/runtime/terminal-host-runtime.mjs"]) {
    assert.ok(pkg.build.files.includes(file), file);
  }
  assert.ok(pkg.build.asarUnpack.includes("node_modules/node-pty/prebuilds/win32-x64/**/*"));
  assert.deepEqual(pkg.build.extraResources.find(({ to }) => to === "terminal-runtime"), {
    from: "outputs/terminal-runtime", to: "terminal-runtime",
  });
  const modules = TERMINAL_MODULE_FILES;
  assert.ok(modules.includes("node_modules/node-pty/lib/worker/conoutSocketWorker.js"));
  assert.deepEqual(modules.filter((file) => /\.(?:node|dll|exe)$/.test(file)), [...NODE_PTY_UNPACKED_FILES].sort());
  assert.deepEqual(modules.filter((file) => file.startsWith("node_modules/node-addon-api/")), [
    "node_modules/node-addon-api/LICENSE.md", "node_modules/node-addon-api/package.json",
  ]);
});

test("electron-builder's actual dependency filter selects exactly the slim terminal module files", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const matcher = getNodeModuleFileMatcher(root, root, (value) => value, {}, {
    config: pkg.build, debugLogger: { isEnabled: false },
  }).createFilter();
  const selected = [];
  async function walk(relative) {
    for (const name of await readdir(path.join(root, relative))) {
      const file = `${relative}/${name}`;
      const absolute = path.join(root, file);
      const details = await lstat(absolute);
      if (!matcher(absolute, details)) continue;
      if (details.isDirectory()) await walk(file);
      else selected.push(file);
    }
  }
  await walk("node_modules/node-pty");
  await walk("node_modules/node-addon-api");
  assert.deepEqual(selected.sort(), TERMINAL_MODULE_FILES);
});

test("electron-builder's resource copier retains every manifested runtime module", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-terminal-resource-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = path.join(root, "outputs", "terminal-runtime");
  for (const file of ["node.exe", "LICENSE", ...TERMINAL_HOST_FILES, ...TERMINAL_MODULE_FILES]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), `fixture:${file}`);
  }
  const manifest = await writeTerminalManifest(source);
  const resources = path.join(root, "resources");
  const mappings = pkg.build.extraResources.filter(({ to }) => to.startsWith("terminal-runtime"));
  const matchers = getFileMatchers({ extraResources: mappings }, "extraResources", resources, {
    defaultSrc: root, globalOutDir: path.join(root, "release"), macroExpander: (value) => value, customBuildOptions: {},
  });
  await copyFiles(matchers);
  for (const file of ["manifest.json", ...Object.keys(manifest.files)]) {
    assert.deepEqual(await readFile(path.join(resources, "terminal-runtime", file)), await readFile(path.join(source, file)), file);
  }
});
