import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NODE_PTY_UNPACKED_FILES } from "./asar-policy.mjs";

// Official release and checksums: https://nodejs.org/dist/v24.14.0/SHASUMS256.txt
export const NODE_VERSION = "24.14.0";
export const NODE_EXE_SHA256 = "63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088";
// https://raw.githubusercontent.com/nodejs/node/v24.14.0/LICENSE
export const NODE_LICENSE_SHA256 = "4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18";
export const TERMINAL_HOST_FILES = Object.freeze([
  "desktop/terminal-host/main.mjs",
  "desktop/terminal-host/host.mjs",
  "desktop/terminal-host/protocol.mjs",
  "desktop/terminal-host/scrollback.mjs",
]);
export const TERMINAL_MODULE_FILES = Object.freeze([
  ...NODE_PTY_UNPACKED_FILES,
  "node_modules/node-pty/LICENSE",
  "node_modules/node-pty/package.json",
  ...[
    "conpty_console_list_agent", "eventEmitter2", "index", "interfaces", "terminal", "types",
    "unixTerminal", "utils", "windowsConoutConnection", "windowsPtyAgent", "windowsTerminal",
    "shared/conout", "worker/conoutSocketWorker",
  ].map((file) => `node_modules/node-pty/lib/${file}.js`),
  "node_modules/node-addon-api/LICENSE.md",
  "node_modules/node-addon-api/package.json",
].sort());
const runtimeFiles = ["LICENSE", "node.exe", ...TERMINAL_HOST_FILES, ...TERMINAL_MODULE_FILES].sort();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("DESKTOP_TERMINAL_NODE_DOWNLOAD_FAILED");
  return Buffer.from(await response.arrayBuffer());
}

export async function ensureTerminalNode(root, options = {}) {
  const cache = path.join(root, "outputs", "terminal-node", `node-v${NODE_VERSION}-win-x64.exe`);
  let bytes;
  try { bytes = await readFile(cache); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = await (options.fetchBytes || fetchBytes)(`https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`);
    if (sha256(bytes) !== NODE_EXE_SHA256) throw new Error("DESKTOP_TERMINAL_NODE_HASH_MISMATCH");
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, bytes, { flag: "wx" });
  }
  if (sha256(bytes) !== NODE_EXE_SHA256) throw new Error("DESKTOP_TERMINAL_NODE_HASH_MISMATCH");
  return cache;
}

async function resourceFiles(root, prefix = "") {
  const files = [];
  for (const name of await readdir(path.join(root, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const details = await lstat(path.join(root, relative));
    if (details.isSymbolicLink()) throw new Error("DESKTOP_TERMINAL_RUNTIME_FILE_SET_INVALID");
    if (details.isDirectory()) files.push(...await resourceFiles(root, relative));
    else if (details.isFile()) files.push(relative);
    else throw new Error("DESKTOP_TERMINAL_RUNTIME_FILE_SET_INVALID");
  }
  return files.sort();
}

export async function writeTerminalManifest(root) {
  const files = {};
  for (const file of runtimeFiles) files[file] = sha256(await readFile(path.join(root, file)));
  const manifest = { buildId: sha256(JSON.stringify(files)), files };
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function assertTerminalRuntime(root) {
  const actual = await resourceFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify([...runtimeFiles, "manifest.json"].sort())) {
    throw new Error("DESKTOP_TERMINAL_RUNTIME_FILE_SET_INVALID");
  }
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["buildId", "files"])
    || JSON.stringify(Object.keys(manifest.files)) !== JSON.stringify(runtimeFiles)
    || manifest.buildId !== sha256(JSON.stringify(manifest.files))) {
    throw new Error("DESKTOP_TERMINAL_RUNTIME_MANIFEST_INVALID");
  }
  for (const file of runtimeFiles) {
    if (manifest.files[file] !== sha256(await readFile(path.join(root, file)))) {
      throw new Error("DESKTOP_TERMINAL_RUNTIME_HASH_MISMATCH");
    }
  }
  if (manifest.files["node.exe"] !== NODE_EXE_SHA256 || manifest.files.LICENSE !== NODE_LICENSE_SHA256) {
    throw new Error("DESKTOP_TERMINAL_RUNTIME_DISTRIBUTION_INVALID");
  }
  return manifest;
}

export async function stageTerminalModules(root, destination) {
  for (const file of TERMINAL_MODULE_FILES) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, file), target);
  }
}

export async function prepareTerminalRuntime(root) {
  const node = await ensureTerminalNode(root);
  const destination = path.join(root, "outputs", "terminal-runtime");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(node, path.join(destination, "node.exe"));
  const license = (await readFile(path.join(root, "desktop", "packaging", "node-LICENSE.txt"), "utf8")).replaceAll("\r\n", "\n");
  await writeFile(path.join(destination, "LICENSE"), license);
  await stageTerminalModules(root, destination);
  for (const file of TERMINAL_HOST_FILES) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, file), target);
  }
  await writeTerminalManifest(destination);
  return assertTerminalRuntime(destination);
}
