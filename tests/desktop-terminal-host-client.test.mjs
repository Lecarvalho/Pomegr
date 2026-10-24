import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareTerminalHostCopy } from "../desktop/runtime/terminal-host-runtime.mjs";
import { createTerminalHostClient } from "../desktop/runtime/terminal-host-client.mjs";
import { startTerminalHost } from "../desktop/terminal-host/host.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t, label = "node") {
  const parent = path.resolve("outputs/terminal-client-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = path.join(root, "resource");
  await mkdir(source);
  await writeFile(path.join(source, "node.exe"), label);
  const files = { "node.exe": digest(label) };
  const buildId = digest(JSON.stringify(files));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ buildId, files }));
  return { source, userData: path.join(root, "profile"), buildId };
}

test("copy verifies hashes, rebuilds corrupted inactive files, and rejects corrupt source", async (t) => {
  const options = await fixture(t);
  const first = await prepareTerminalHostCopy(options);
  assert.equal(await readFile(path.join(first.directory, "node.exe"), "utf8"), "node");
  await writeFile(path.join(first.directory, "node.exe"), "corrupt");
  const rebuilt = await prepareTerminalHostCopy(options);
  assert.equal(await readFile(path.join(rebuilt.directory, "node.exe"), "utf8"), "node");
  await writeFile(path.join(options.source, "node.exe"), "corrupt source");
  await assert.rejects(prepareTerminalHostCopy(options), /TERMINAL_INTEGRITY/);
});

test("a corrupted folder used by a running host is never replaced", async (t) => {
  const options = await fixture(t);
  const copy = await prepareTerminalHostCopy(options);
  await writeFile(path.join(copy.directory, "host.json"), JSON.stringify({ pid: process.pid, protocol: 1, pipe: "fixture" }));
  await writeFile(path.join(copy.directory, "node.exe"), "corrupt");
  await assert.rejects(prepareTerminalHostCopy(options), /TERMINAL_INTEGRITY/);
  assert.equal(await readFile(path.join(copy.directory, "node.exe"), "utf8"), "corrupt");
});

test("manifest traversal and symlink entries cannot become copy destinations", async (t) => {
  const options = await fixture(t);
  const files = { "../outside.exe": digest("bad") };
  await writeFile(path.join(options.source, "manifest.json"), JSON.stringify({ buildId: digest(JSON.stringify(files)), files }));
  await assert.rejects(prepareTerminalHostCopy(options), /TERMINAL_INTEGRITY/);
  const linked = { "node.exe": digest("node"), "nested/node.exe": digest("node") };
  await symlink(options.source, path.join(options.source, "nested"), "junction");
  await writeFile(path.join(options.source, "manifest.json"), JSON.stringify({ buildId: digest(JSON.stringify(linked)), files: linked }));
  await assert.rejects(prepareTerminalHostCopy(options), /TERMINAL_INTEGRITY/);
});

test("client reuses a running host, discovers another build, and streams replay and output", async (t) => {
  const options = await fixture(t);
  const otherOptions = await fixture(t, "other node");
  otherOptions.userData = options.userData;
  const current = await prepareTerminalHostCopy(options);
  const other = await prepareTerminalHostCopy(otherOptions);
  const handlers = {};
  const host = await startTerminalHost({ runtimeDirectory: current.directory, spawnPty: (_file, _args, ptyOptions) => ({
    onData(callback) { handlers.data = callback; }, onExit(callback) { handlers.exit = callback; },
    write(data) { handlers.data(`echo:${data}`); }, resize(cols, rows) { handlers.data(`size:${cols}x${rows}`); },
    pid: 123, initialSize: ptyOptions.cols,
  }) });
  const otherHost = await startTerminalHost({ runtimeDirectory: other.directory, spawnPty() { throw new Error("unused"); } });
  t.after(async () => { await host.close(); await otherHost.close(); });
  const client = createTerminalHostClient({ ...options, spawn() { throw new Error("must reuse"); } });
  t.after(() => client.close());
  await client.ensureHost();
  assert.equal((await client.listHosts()).length, 2);
  await client.create({ executable: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, key: "fixture" });
  handlers.data("before attach\r\n");
  const stream = await client.attach("fixture");
  assert.equal(stream.readOnly, false);
  assert.equal((await stream.next()).value.data, "before attach\r\n");
  await client.input("fixture", "hello");
  assert.equal((await stream.next()).value.data, "echo:hello");
  await client.resize("fixture", 100, 40);
  assert.equal((await stream.next()).value.data, "size:100x40");
  handlers.exit({ exitCode: 7 });
  assert.equal((await stream.next()).value.exitCode, 7);
  assert.equal((await stream.next()).done, true);
  const exited = await client.attach("fixture");
  assert.equal(exited.readOnly, true);
  assert.equal((await exited.next()).value.exitCode, 7);
  assert.equal((await exited.next()).done, true);
  assert.equal((await client.list())[0].exitCode, 7);
  await client.detach("fixture", true);
  assert.deepEqual(await client.list(), []);
  assert.equal((await client.listHosts()).find((row) => row.buildId === other.buildId).protocol, 1);
});

test("ensureHost starts only the copied node with a detached argument-array launch", async (t) => {
  const options = await fixture(t);
  let host;
  let launch;
  const client = createTerminalHostClient({ ...options, spawn(executable, args, spawnOptions) {
    launch = { executable, args, options: spawnOptions };
    const child = new EventEmitter();
    child.unref = () => {};
    void startTerminalHost({ runtimeDirectory: spawnOptions.cwd, spawnPty() {} }).then((value) => { host = value; });
    return child;
  } });
  t.after(async () => { client.close(); await host?.close(); });
  await client.ensureHost();
  assert.equal(launch.executable, path.join(options.userData, "terminal-host", options.buildId, "node.exe"));
  assert.equal(launch.args.length, 1);
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.stdio, "ignore");
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.env.NODE_OPTIONS, undefined);
  assert.equal(launch.options.env.POMEGR_MONITOR_TOKEN, undefined);
});

test("a hard-killed host restarts on ensureHost and its old sessions are gone", { skip: process.platform !== "win32" }, async (t) => {
  const options = await fixture(t);
  const node = await readFile(process.execPath);
  const script = `import { startTerminalHost } from ${JSON.stringify(pathToFileURL(path.resolve("desktop/terminal-host/host.mjs")).href)};
await startTerminalHost({runtimeDirectory:process.cwd(), idleMilliseconds:2000, onIdle:()=>process.exit(0),
spawnPty:()=>({pid:process.pid,onData(){},onExit(){},write(){},resize(){}})});`;
  await mkdir(path.join(options.source, "desktop/terminal-host"), { recursive: true });
  await writeFile(path.join(options.source, "desktop/terminal-host/main.mjs"), script);
  await writeFile(path.join(options.source, "node.exe"), node);
  const files = { "desktop/terminal-host/main.mjs": digest(script), "node.exe": digest(node) };
  await writeFile(path.join(options.source, "manifest.json"), JSON.stringify({ buildId: digest(JSON.stringify(files)), files }));
  const children = [];
  const client = createTerminalHostClient({ ...options, spawn(...args) { const child = spawnChild(...args); children.push(child); return child; } });
  t.after(() => { client.close(); for (const child of children) if (child.exitCode === null) child.kill(); });
  await client.ensureHost();
  await client.create({ executable: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, key: "gone" });
  assert.equal((await client.list()).length, 1);
  const exited = new Promise((resolve) => children[0].once("exit", resolve));
  children[0].kill(); await exited;
  await assert.rejects(client.list(), /TERMINAL_UNAVAILABLE/);
  await client.ensureHost();
  assert.equal(children.length, 2);
  assert.deepEqual(await client.list(), []);
  const idle = new Promise((resolve) => children[1].once("exit", resolve));
  client.close(); await idle;
});
