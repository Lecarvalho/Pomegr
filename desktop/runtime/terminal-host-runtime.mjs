import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { restrictDirectory } from "../terminal-host/host.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = () => new Error("TERMINAL_INTEGRITY");
const privateParents = new Map();
export function hostIsAlive(state) {
  if (!Number.isSafeInteger(state?.pid) || state.pid < 1) return false;
  try { process.kill(state.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export async function readHostState(directory) {
  try {
    const bytes = await readFile(path.join(directory, "host.json"));
    if (bytes.length > 4096) return null;
    const state = JSON.parse(bytes);
    return Number.isSafeInteger(state.pid) && Number.isSafeInteger(state.protocol)
      && typeof state.pipe === "string" && state.pipe.length < 256 ? state : null;
  } catch { return null; }
}

async function regularFile(root, relative) {
  let current = root;
  if ((await lstat(current)).isSymbolicLink()) throw integrity();
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw integrity();
  }
  if (!(await lstat(current)).isFile()) throw integrity();
  return current;
}

async function verify(root, files) {
  try {
    for (const [relative, expected] of Object.entries(files)) {
      if (hash(await readFile(await regularFile(root, relative))) !== expected) return false;
    }
    // Extra executable code must not enter the immutable runtime through an old copy.
    const walk = async (directory, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) { if (!await walk(path.join(directory, entry.name), `${relative}/`)) return false; }
        else if (!Object.hasOwn(files, relative) && !["host.json", "host.token"].includes(relative)) return false;
      }
      return true;
    };
    return await walk(root);
  } catch { return false; }
}

export async function readTerminalManifest(source) {
  try {
    const bytes = await readFile(await regularFile(source, "manifest.json"));
    if (bytes.length > 64 * 1024) throw integrity();
    const manifest = JSON.parse(bytes);
    const entries = Object.entries(manifest.files);
    if (!entries.length || entries.length > 256 || !Object.hasOwn(manifest.files, "node.exe")) throw integrity();
    for (const [name, digest] of entries) {
      if (!/^[A-Za-z0-9_@./-]+$/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")
        || !/^[a-f0-9]{64}$/.test(digest) || ["host.json", "host.token", "manifest.json"].includes(name)) throw integrity();
    }
    if (manifest.buildId !== hash(JSON.stringify(manifest.files))) throw integrity();
    return manifest;
  } catch { throw integrity(); }
}

export async function prepareTerminalHostCopy({ source, userData }, withCopy = async (copy) => copy) {
  try { return await prepareCopy(source, userData, withCopy); }
  catch (error) {
    if (["TERMINAL_INTEGRITY", "TERMINAL_UNAVAILABLE", "TERMINAL_RUNTIME_PRIVATE", "TERMINAL_PROTOCOL_MISMATCH"].includes(error.message)) throw error;
    throw integrity();
  }
}

async function prepareCopy(source, userData, withCopy) {
  const manifest = await readTerminalManifest(source);
  for (const [relative, expected] of Object.entries(manifest.files)) {
    try { if (hash(await readFile(await regularFile(source, relative))) !== expected) throw integrity(); }
    catch { throw integrity(); }
  }
  const parent = path.join(userData, "terminal-host");
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink()) throw integrity();
  // Restrict once per desktop-main process, including existing folders. All build
  // copies and their state inherit this ACL; host startup needs no ACL subprocess.
  if (!privateParents.has(parent)) {
    privateParents.set(parent, restrictDirectory(parent).catch((error) => { privateParents.delete(parent); throw error; }));
  }
  await privateParents.get(parent);
  const lock = path.join(parent, `${manifest.buildId}.lock`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw integrity();
      let owner;
      try { owner = JSON.parse(await readFile(path.join(lock, "owner.json"))); } catch { /* Creating owner file. */ }
      if (owner && !hostIsAlive(owner)) await rm(lock, { recursive: true, force: true });
      else if (!owner && Date.now() - (await lstat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
      if (Date.now() >= deadline) throw new Error("TERMINAL_UNAVAILABLE");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    return await prepareLockedCopy(source, parent, manifest, withCopy);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function prepareLockedCopy(source, parent, manifest, withCopy) {
  const directory = path.join(parent, manifest.buildId);
  if (await verify(directory, manifest.files)) return withCopy({ directory, buildId: manifest.buildId });
  if (hostIsAlive(await readHostState(directory))) throw integrity();
  const staging = path.join(parent, `${manifest.buildId}.${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const relative of Object.keys(manifest.files)) {
      const destination = path.join(staging, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(await regularFile(source, relative), destination);
    }
    if (!await verify(staging, manifest.files)) throw integrity();
    try { await lstat(directory); }
    catch (error) { if (error.code !== "ENOENT") throw integrity(); }
    // A caller holding the startup lock is the only writer of this build directory.
    if (hostIsAlive(await readHostState(directory))) throw integrity();
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
    return await withCopy({ directory, buildId: manifest.buildId });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
