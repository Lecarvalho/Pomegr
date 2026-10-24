import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import childProcess, { spawn as spawnChild } from "node:child_process";
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

test("copy reuse does not reapply the directory ACL", async (t) => {
  const options = await fixture(t);
  const copy = await prepareTerminalHostCopy(options);
  t.mock.method(childProcess.ChildProcess.prototype, "spawn", () => { throw new Error("unexpected ACL subprocess"); });
  assert.deepEqual(await prepareTerminalHostCopy(options), copy);
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
  const older = createTerminalHostClient({ ...options, spawn() { throw new Error("existing builds never spawn"); } });
  t.after(() => older.close());
  await older.connectHost(other.buildId);
  assert.deepEqual(await older.list(), []);
  await client.create({ executable: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, key: "fixture" });
  handlers.data("before attach\r\n");
  const stream = await client.attach("fixture");
  assert.equal(stream.readOnly, false);
  assert.equal((await stream.next()).value.data, "before attach\r\n");
  await client.input("fixture", "hello");
  assert.equal((await stream.next()).value.data, "echo:hello");
  await client.input("fixture", "x".repeat(16 * 1024));
  let accepted = "";
  const echoed = `echo:${"x".repeat(2048)}`.repeat(8);
  while (accepted.length < echoed.length) accepted += (await stream.next()).value.data;
  assert.equal(accepted, echoed);
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
    child.pid = process.pid;
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

test("ensureHost notices startup exit before unref and fails without waiting for the deadline", async (t) => {
  const options = await fixture(t);
  const client = createTerminalHostClient({ ...options, spawn() {
    const child = new EventEmitter();
    child.unref = () => {
      child.emit("exit", 1, null);
      t.mock.method(globalThis, "setTimeout", () => { assert.fail("an exited host must not poll until the startup deadline"); });
    };
    return child;
  } });
  await assert.rejects(client.ensureHost(), { message: "TERMINAL_UNAVAILABLE" });
});

test("a hard-killed host restarts on ensureHost and its old sessions are gone", { skip: process.platform !== "win32" }, async (t) => {
  const children = [];
  let client;
  // Stop and reap our children before fixture cleanup removes their copied executable.
  t.after(async () => {
    client?.close();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.ref();
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });
  const options = await fixture(t);
  const node = await readFile(process.execPath);
  // This fixture lives until the test kills it; idle exit is covered by the host tests.
  const script = `import { startTerminalHost } from ${JSON.stringify(pathToFileURL(path.resolve("desktop/terminal-host/host.mjs")).href)};
await startTerminalHost({runtimeDirectory:process.cwd(),
spawnPty:()=>({pid:process.pid,onData(){},onExit(){},write(){},resize(){}})});`;
  await mkdir(path.join(options.source, "desktop/terminal-host"), { recursive: true });
  await writeFile(path.join(options.source, "desktop/terminal-host/main.mjs"), script);
  await writeFile(path.join(options.source, "node.exe"), node);
  const files = { "desktop/terminal-host/main.mjs": digest(script), "node.exe": digest(node) };
  await writeFile(path.join(options.source, "manifest.json"), JSON.stringify({ buildId: digest(JSON.stringify(files)), files }));
  const diagnostics = [];
  client = createTerminalHostClient({ ...options, spawn(executable, args, spawnOptions) {
    const diagnostic = { stderr: "", exitCode: null, signal: null };
    diagnostics.push(diagnostic);
    const child = spawnChild(executable, args, { ...spawnOptions, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => { diagnostic.stderr = (diagnostic.stderr + data).slice(-8192); });
    child.on("exit", (code, signal) => { diagnostic.exitCode = code; diagnostic.signal = signal; });
    children.push(child);
    return child;
  } });
  async function ensureWithDiagnostics() {
    try { await client.ensureHost(); }
    catch (error) { assert.fail(`${error.message}; host startup: ${JSON.stringify(diagnostics)}`); }
  }
  await ensureWithDiagnostics();
  await client.create({ executable: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, key: "gone" });
  assert.equal((await client.list()).length, 1);
  children[0].ref();
  const closed = once(children[0], "close");
  assert.equal(children[0].kill(), true);
  await closed;
  await assert.rejects(client.list(), /TERMINAL_UNAVAILABLE/);
  // The dead host's record remains until its replacement atomically publishes a new one.
  const buildDirectory = path.join(options.userData, "terminal-host", digest(JSON.stringify(files)));
  assert.equal(JSON.parse(await readFile(path.join(buildDirectory, "host.json"))).pid, children[0].pid);
  const oldToken = await readFile(path.join(buildDirectory, "host.token"), "utf8");
  await ensureWithDiagnostics();
  assert.equal(children.length, 2);
  assert.notEqual(children[1].pid, children[0].pid);
  assert.equal((await client.listHosts())[0].pid, children[1].pid);
  assert.equal(JSON.parse(await readFile(path.join(buildDirectory, "host.json"))).pid, children[1].pid);
  assert.notEqual(await readFile(path.join(buildDirectory, "host.token"), "utf8"), oldToken);
  assert.deepEqual(await client.list(), []);
});
