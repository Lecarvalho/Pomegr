import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import childProcess, { spawn as spawnChild } from "node:child_process";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareTerminalHostCopy } from "../desktop/runtime/terminal-host-runtime.mjs";
import { createTerminalHostClient } from "../desktop/runtime/terminal-host-client.mjs";
import { startTerminalHost } from "../desktop/terminal-host/host.mjs";
import { encodeFrame, decodeFrames } from "../desktop/terminal-host/protocol.mjs";

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
  const initialOutput = "before attach\r\n";
  handlers.data(initialOutput);
  const stream = await client.attach("fixture");
  assert.equal(stream.readOnly, false);
  const { default: headless } = await import("@xterm/headless");
  const { default: serialize } = await import("@xterm/addon-serialize");
  const screen = new headless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  const serializer = new serialize.SerializeAddon(); screen.loadAddon(serializer);
  await new Promise((resolve) => screen.write(initialOutput, resolve));
  assert.equal((await stream.next()).value.data, serializer.serialize({ scrollback: 5000 }));
  screen.dispose();
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

test("client buffers 4 MiB replay before attach reply while bounding unread live output", { timeout: 30000 }, async (t) => {
  const options = await fixture(t);
  const copy = await prepareTerminalHostCopy(options);
  const pipe = `\\\\.\\pipe\\pomegr-terminal-${digest(String(Math.random()))}`;
  const token = "a".repeat(64);
  await writeFile(path.join(copy.directory, "host.token"), token);
  await writeFile(path.join(copy.directory, "host.json"), JSON.stringify({ pid: process.pid, protocol: 1, pipe }));
  const server = net.createServer((socket) => decodeFrames(socket, (frame) => {
    if (frame.command === "attach") {
      if (frame.key === "budget") {
        // 4 MiB serialized screen plus one frame charge per 4096-character chunk.
        for (let index = 0; index < 1024; index++) socket.write(encodeFrame({ event: "output", key: "budget", data: "x".repeat(4096), replay: true }));
      }
      socket.write(encodeFrame({ id: frame.id, ok: true, readOnly: false }));
    } else if (frame.command === "list") {
      for (let index = 0; index < 8192; index++) socket.write(encodeFrame({ event: "output", key: "live", data: "x".repeat(64) }));
      socket.write(encodeFrame({ id: frame.id, ok: true, sessions: [] }));
    } else socket.write(encodeFrame({ id: frame.id, ok: true, protocol: 1 }));
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  let client;
  t.after(async () => { client?.close(); await new Promise((resolve) => server.close(resolve)); });
  client = createTerminalHostClient(options);
  await client.connectHost(copy.buildId);
  const stream = await client.attach("budget");
  assert.equal(stream.readOnly, false);
  let replay = "";
  while (replay.length < 4 * 1024 * 1024) {
    const { value, done } = await stream.next();
    if (done || value.event !== "output" || !value.replay) break;
    replay += value.data;
  }
  assert.equal(replay, "x".repeat(4 * 1024 * 1024));
  const live = await client.attach("live");
  await client.list();
  assert.deepEqual((await live.next()).value, { event: "detached", reason: "slow_client" });
});

test("end asks the host to stop one terminal and reports whether it is listed as exited", async (t) => {
  const options = await fixture(t);
  const copy = await prepareTerminalHostCopy(options);
  const handlers = {};
  const killed = [];
  const host = await startTerminalHost({ runtimeDirectory: copy.directory,
    killTree: async (pid) => { killed.push(pid); handlers.exit({ exitCode: 1 }); return true; },
    spawnPty: () => ({ onData(callback) { handlers.data = callback; }, onExit(callback) { handlers.exit = callback; }, write() {}, resize() {}, pid: 321 }) });
  t.after(() => host.close());
  const client = createTerminalHostClient({ ...options, spawn() { throw new Error("must reuse"); }, pause: async () => {} });
  t.after(() => client.close());
  await client.ensureHost();
  await client.create({ executable: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, key: "fixture" });
  assert.equal(await client.end("fixture"), true);
  assert.deepEqual(killed, [321]);
  assert.equal((await client.list())[0].exited, true);
  await client.detach("fixture", true);
  await assert.rejects(client.end("fixture"), { message: "TERMINAL_NOT_FOUND" });
});

test("a host of an older build has no end: its terminal is stopped by the process ID it lists", async (t) => {
  const options = await fixture(t);
  const copy = await prepareTerminalHostCopy(options);
  const pipe = `\\\\.\\pipe\\pomegr-terminal-${digest(String(Math.random()))}`;
  await writeFile(path.join(copy.directory, "host.token"), "b".repeat(64));
  await writeFile(path.join(copy.directory, "host.json"), JSON.stringify({ pid: process.pid, protocol: 1, pipe }));
  const commands = [];
  const rows = new Map([["gone", { key: "gone", pid: 4242, exited: false }], ["done", { key: "done", pid: 4343, exited: true, exitCode: 0 }]]);
  const server = net.createServer((socket) => decodeFrames(socket, (frame) => {
    commands.push(frame.command);
    if (frame.command === "list") socket.write(encodeFrame({ id: frame.id, ok: true, sessions: [...rows.values()] }));
    else if (frame.command === "hello") socket.write(encodeFrame({ id: frame.id, ok: true, protocol: 1 }));
    else socket.write(encodeFrame({ id: frame.id, ok: false, error: "UNKNOWN_COMMAND" }));
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  const killed = [];
  let outcome = true;
  let client;
  t.after(async () => { client?.close(); await new Promise((resolve) => server.close(resolve)); });
  client = createTerminalHostClient({ ...options, pause: async () => {}, killTree: async (pid) => {
    killed.push(pid);
    if (outcome) rows.set("gone", { key: "gone", pid, exited: true, exitCode: 1 });
    return outcome;
  } });
  await client.connectHost(copy.buildId);
  assert.equal(await client.end("gone"), true);
  assert.deepEqual(killed, [4242]);
  assert.equal(commands.filter((command) => command === "end").length, 1);
  // An exited terminal needs no stop, and an unknown key is not found.
  assert.equal(await client.end("done"), true);
  await assert.rejects(client.end("missing"), { message: "TERMINAL_NOT_FOUND" });
  assert.deepEqual(killed, [4242]);
  // A stop that fails is a failure; a stop the host never lists as exited answers false.
  rows.set("gone", { key: "gone", pid: 4242, exited: false });
  outcome = false;
  await assert.rejects(client.end("gone"), { message: "TERMINAL_UNAVAILABLE" });
  rows.set("slow", { key: "slow", pid: 4444, exited: false });
  client.close();
  client = createTerminalHostClient({ ...options, pause: async () => {}, killTree: async () => true });
  await client.connectHost(copy.buildId);
  assert.equal(await client.end("slow"), false);
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
