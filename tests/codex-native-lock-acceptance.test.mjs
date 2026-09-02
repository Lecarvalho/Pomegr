import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isActiveCodexWriterLock } from "../monitor/providers/codex-cli-observation.mjs";
import { probeNativeWriterOwner } from "./helpers/codex-native-owner-probe.mjs";
import { createCodexWriterPresence, queryCodexWriterOwners } from "../monitor/providers/codex-writer-presence.mjs";

// This is deliberately opt-in. It launches the installed native client and is
// therefore not suitable for the ordinary hermetic test run.
const requestedExecutable = process.env.POMEGR_CODEX_NATIVE_TEST_EXECUTABLE?.trim() || "";
const executable = requestedExecutable;
const optIn = requestedExecutable.length > 0;
const executableExists = (() => {
  try { return fs.statSync(executable).isFile(); } catch { return false; }
})();

const REQUEST_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 3_000;
const LOCK_TIMEOUT_MS = 4_000;
const POLL_MS = 50;
const MAX_PROTOCOL_LINE_BYTES = 256 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeEnvironment(root, codexHome, tempRoot) {
  const env = {};
  // Keep only the OS/runtime values needed to launch a Windows executable.
  // In particular, do not inherit account tokens, MCP settings, or arbitrary
  // user-defined environment values into the native child.
  for (const key of ["Path", "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  // Explicitly sever all account/configuration paths and credentials. The
  // native child sees only the synthetic CODEX_HOME and workspace below.
  env.CODEX_HOME = codexHome;
  env.HOME = root;
  env.USERPROFILE = root;
  env.APPDATA = path.join(root, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(root, "AppData", "Local");
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  return env;
}

function lockProbe(lockFile) {
  let exists = false;
  try {
    exists = fs.statSync(lockFile).isFile();
  } catch (error) {
    // ENOENT is the only absence that proves the lock file is gone. Other
    // failures (permissions, I/O, etc.) remain an unknown release state.
    return { exists: false, opened: false, readSucceeded: false, busy: false, released: error?.code === "ENOENT" };
  }
  if (!exists) return { exists: false, opened: false, readSucceeded: false, busy: false, released: false };

  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, "r");
    try {
      fs.readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
      return { exists: true, opened: true, readSucceeded: true, busy: false, released: true };
    } catch (error) {
      return { exists: true, opened: true, readSucceeded: false, busy: error?.code === "EBUSY", released: false };
    }
  } catch (error) {
    return { exists: true, opened: false, readSucceeded: false, busy: error?.code === "EBUSY", released: error?.code === "ENOENT" };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* the child owns the lock */ }
    }
  }
}

async function waitForLock(lockFile, predicate, timeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let current = lockProbe(lockFile);
  while (!predicate(current) && Date.now() < deadline) {
    await delay(POLL_MS);
    current = lockProbe(lockFile);
  }
  return current;
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { cleanup(); resolve(true); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, EXIT_TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timer); child.off("exit", onExit); };
    child.once("exit", onExit);
  });
}

async function terminateChild(child, graceful) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { exited: true, forced: false };
  if (graceful) {
    try { child.stdin.end(); } catch { /* already closed */ }
    if (await childExit(child)) return { exited: true, forced: false };
  }
  // This signal targets exactly the process spawned by this test. On Windows
  // SIGKILL maps to TerminateProcess and does not search for sibling clients.
  try { child.kill("SIGKILL"); } catch { /* process may have exited concurrently */ }
  return { exited: await childExit(child), forced: true };
}

class JsonRpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(String(chunk)));
    // Never forward native stderr: it may contain paths, account details, or
    // other provider-owned diagnostics.
    child.stderr.resume();
    child.stdin.on("error", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("native app-server input unavailable"));
      }
      this.pending.clear();
    });
    child.on("exit", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("native app-server exited"));
      }
      this.pending.clear();
    });
    child.on("error", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("native app-server process error"));
      }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) this.buffer = "";
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!Object.prototype.hasOwnProperty.call(message, "id")) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("native app-server request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("native app-server request failed"));
      }
    });
  }

  notify(method, params = {}) {
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); } catch { /* shutdown race */ }
  }
}

function responseResult(response) {
  return response && !response.error && response.result && typeof response.result === "object"
    ? response.result
    : null;
}

async function startServer({ cwd, env }) {
  const child = spawn(executable, ["app-server", "--stdio"], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new JsonRpcClient(child);
  try {
    const initialize = responseResult(await client.request("initialize", {
      clientInfo: { name: "pomegr-native-lock-acceptance", title: "Pomegr native lock acceptance", version: "0.2.0" },
      capabilities: {},
    }));
    assert.ok(initialize, "native app-server initialization failed");
    client.notify("initialized", {});
    return client;
  } catch {
    await terminateChild(child, false);
    throw new Error("native app-server initialization failed");
  }
}

async function startSyntheticThread(client, cwd) {
  const result = responseResult(await client.request("thread/start", { cwd }));
  const id = result?.thread?.id;
  assert.equal(typeof id, "string", "native thread start did not return a thread");
  return id;
}

async function loadedContains(client, threadId) {
  const result = responseResult(await client.request("thread/loaded/list"));
  return Array.isArray(result?.data) && result.data.includes(threadId);
}

async function readIsIdle(client, threadId) {
  const result = responseResult(await client.request("thread/read", { threadId, includeTurns: false }));
  return result?.thread?.status?.type === "idle";
}

test("native Codex app-server owns synthetic writer locks and releases them on shutdown", {
  skip: process.platform !== "win32"
    ? "Windows-native writer-lock acceptance"
    : !optIn
      ? "opt in with POMEGR_CODEX_NATIVE_TEST_EXECUTABLE"
      : undefined,
}, async (t) => {
  assert.equal(path.isAbsolute(executable), true, "native executable must be explicitly selected by absolute path");
  assert.equal(executableExists, true, "requested native Codex executable is not present");

  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-native-lock-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const tempRoot = path.join(root, "temp");
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(tempRoot, { recursive: true })]);
  const env = safeEnvironment(root, codexHome, tempRoot);
  const writerRoot = path.join(codexHome, "thread-writer-locks");
  let firstClient;
  let secondClient;
  let firstId;
  let secondId;
  const proof = {
    firstLockHeld: false,
    firstLoaded: false,
    firstReadIdle: false,
    secondLockHeld: false,
    secondLoaded: false,
    secondReadIdle: false,
    unsubscribeAccepted: false,
    firstRetainedAfterUnsubscribe: false,
    archiveAccepted: false,
    gracefulExit: false,
    gracefulLocksReleased: false,
    forcedExit: false,
    forcedLockReleased: false,
  };

  try {
    firstClient = await startServer({ cwd: workspace, env });
    firstId = await startSyntheticThread(firstClient, workspace);
    const firstLock = path.join(writerRoot, `${firstId}.lock`);
    const firstHeld = await waitForLock(firstLock, (probe) => probe.exists && probe.opened && probe.busy);
    proof.firstLockHeld = firstHeld.exists && firstHeld.opened && firstHeld.busy;
    assert.equal(proof.firstLockHeld, true, "native writer lock was not read as EBUSY");
    assert.equal(fs.statSync(firstLock).size, 0, "fixture must exercise a zero-byte native lock");
    assert.equal(isActiveCodexWriterLock(firstLock), true, "production probe must detect the native lock");
    const owner = await probeNativeWriterOwner(firstLock, executable);
    assert.equal(owner.nativeOwner, true, "native owner image and start identity must match");
    const wrongOwner = await probeNativeWriterOwner(firstLock, process.execPath);
    assert.equal(wrongOwner.nativeOwner, false, "a different executable cannot claim the native lock");
    // Exercise real filesystem acquisition at the full retained-candidate bound,
    // with one native owner and 499 unlocked stale fixtures. No transcript reads.
    const retained = [{ localId: firstId }];
    for (let index = 0; index < 499; index += 1) {
      const localId = `stale-fixture-${index}`;
      fs.writeFileSync(path.join(writerRoot, `${localId}.lock`), "", { flag: "wx" });
      retained.push({ localId });
    }
    let queries = 0;
    let yields = 0;
    const collector = createCodexWriterPresence({
      writerLocksRoot: writerRoot, resolveExecutables: () => [path.resolve(executable)],
      async queryOwners(files, executables, signal) {
        queries += 1;
        return queryCodexWriterOwners(files, executables, { signal });
      },
      async yieldFn() { yields += 1; await new Promise((resolve) => setImmediate(resolve)); },
    });
    const probeStartedAt = performance.now();
    await collector.refresh(retained);
    assert.ok(collector.current(firstId), "production collector must confirm the native idle owner");
    assert.equal(retained.slice(1).every(({ localId }) => collector.current(localId) === null), true);
    assert.equal(queries, 1, "500 retained candidates use one owner-query process");
    assert.ok(yields >= 15, "filesystem batches yield to the serving event loop");
    t.diagnostic(JSON.stringify({ retainedCandidates: retained.length, ownerQueryProcesses: queries,
      cooperativeYields: yields, probeMilliseconds: Math.round(performance.now() - probeStartedAt) }));
    collector.close();
    assert.equal(isActiveCodexWriterLock(firstLock), true, "closing the observer must not control the provider");

    // The regression involved 69 held locks, not one held lock among stale
    // files. Exercise actual retained native tasks without sending model turns.
    const heldIds = [firstId];
    for (let index = 1; index < 70; index += 1) heldIds.push(await startSyntheticThread(firstClient, workspace));
    const heldFiles = heldIds.map((id) => path.join(writerRoot, `${id}.lock`));
    assert.equal(heldFiles.every((file) => lockProbe(file).busy), true);
    const batchStart = performance.now();
    const batchOwners = await queryCodexWriterOwners(heldFiles, [path.resolve(executable)]);
    assert.equal(batchOwners.length, heldIds.length, "all 70 retained native locks must resolve within the bounded helper deadline");
    assert.equal(new Set(batchOwners.map((item) => `${item.pid}:${item.processStartIdentity}`)).size, 1);
    assert.equal(new Set(batchOwners.map((item) => item.index)).size, heldIds.length);
    t.diagnostic(JSON.stringify({ heldCandidates: heldIds.length, confirmedOwners: batchOwners.length,
      groupedProbeMilliseconds: Math.round(performance.now() - batchStart) }));

    // A grouped RM result is a union, never a file-to-process mapping. A second
    // native owner requires partitioning; an extra foreign file user must make
    // that individual lock ambiguous without poisoning the other partition.
    secondClient = await startServer({ cwd: workspace, env });
    const otherId = await startSyntheticThread(secondClient, workspace);
    const otherLock = path.join(writerRoot, `${otherId}.lock`);
    assert.equal((await waitForLock(otherLock, (probe) => probe.busy)).busy, true);
    const mixedOwners = await queryCodexWriterOwners([firstLock, otherLock], [path.resolve(executable)]);
    assert.equal(mixedOwners.length, 2, "two native owners must be resolved separately");
    assert.equal(new Set(mixedOwners.map((item) => `${item.pid}:${item.processStartIdentity}`)).size, 2);
    const foreignHandle = fs.openSync(firstLock, "r");
    try {
      const ambiguous = await queryCodexWriterOwners([firstLock, otherLock], [path.resolve(executable)]);
      assert.deepEqual(ambiguous.map((item) => item.index), [1], "a foreign file user must not be attributed to the native owner");
    } finally { fs.closeSync(foreignHandle); }
    await terminateChild(secondClient.child, true);
    secondClient = undefined;
    proof.firstLoaded = await loadedContains(firstClient, firstId);
    proof.firstReadIdle = await readIsIdle(firstClient, firstId);
    assert.equal(proof.firstLoaded, true, "native loaded-thread listing omitted the first thread");
    assert.equal(proof.firstReadIdle, true, "native thread/read did not report idle");

    // Keep two idle synthetic tasks loaded at once; no turn or model operation
    // is sent by this test.
    secondId = await startSyntheticThread(firstClient, workspace);
    const secondLock = path.join(writerRoot, `${secondId}.lock`);
    const secondHeld = await waitForLock(secondLock, (probe) => probe.exists && probe.opened && probe.busy);
    proof.secondLockHeld = secondHeld.exists && secondHeld.opened && secondHeld.busy;
    assert.equal(proof.secondLockHeld, true, "native second writer lock was not read as EBUSY");
    proof.secondLoaded = await loadedContains(firstClient, secondId);
    proof.secondReadIdle = await readIsIdle(firstClient, secondId);
    assert.equal(proof.secondLoaded, true, "native loaded-thread listing omitted the second thread");
    assert.equal(proof.secondReadIdle, true, "native second thread/read did not report idle");

    const unsubscribe = responseResult(await firstClient.request("thread/unsubscribe", { threadId: firstId }));
    proof.unsubscribeAccepted = unsubscribe?.status === "unsubscribed";
    assert.equal(proof.unsubscribeAccepted, true, "native unsubscribe was not accepted");
    proof.firstRetainedAfterUnsubscribe = await loadedContains(firstClient, firstId);
    assert.equal(proof.firstRetainedAfterUnsubscribe, true, "unsubscribed thread was unloaded before the grace period");

    // Archiving is safe here because this thread was created in the isolated
    // CODEX_HOME. A native version may reject archiving a currently loaded
    // thread; that outcome is recorded as a bounded boolean and is not used
    // to claim immediate lock release (the documented grace period is 30m).
    try {
      proof.archiveAccepted = Boolean(responseResult(await firstClient.request("thread/archive", { threadId: firstId })));
    } catch {
      proof.archiveAccepted = false;
    }

    const gracefulStop = await terminateChild(firstClient.child, true);
    proof.gracefulExit = gracefulStop.exited && !gracefulStop.forced;
    assert.equal(proof.gracefulExit, true, "native app-server did not exit after stdin close");
    const firstReleased = await waitForLock(firstLock, (probe) => probe.released);
    const secondReleased = await waitForLock(secondLock, (probe) => probe.released);
    proof.gracefulLocksReleased = firstReleased.released && secondReleased.released;
    assert.equal(proof.gracefulLocksReleased, true, "native writer locks remained held after graceful exit");
    assert.equal(isActiveCodexWriterLock(secondLock), false, "production probe must stop confirming the exited owner");
    firstClient = undefined;

    // A fresh process proves that release does not depend on an orderly
    // protocol close. It uses the same isolated home and creates one more
    // synthetic idle thread, then only that child is force-terminated.
    secondClient = await startServer({ cwd: workspace, env });
    const forcedId = await startSyntheticThread(secondClient, workspace);
    const forcedLock = path.join(writerRoot, `${forcedId}.lock`);
    const forcedHeld = await waitForLock(forcedLock, (probe) => probe.exists && probe.opened && probe.busy);
    assert.equal(forcedHeld.exists && forcedHeld.opened && forcedHeld.busy, true, "native forced-exit lock was not read as EBUSY");
    const forcedStop = await terminateChild(secondClient.child, false);
    proof.forcedExit = forcedStop.exited && forcedStop.forced;
    assert.equal(proof.forcedExit, true, "native app-server did not exit after forced termination");
    const forcedReleased = await waitForLock(forcedLock, (probe) => probe.released);
    proof.forcedLockReleased = forcedReleased.released;
    assert.equal(proof.forcedLockReleased, true, "native writer lock remained held after forced exit");
    secondClient = undefined;
  } finally {
    if (firstClient) await terminateChild(firstClient.child, false);
    if (secondClient) await terminateChild(secondClient.child, false);
    t.diagnostic(JSON.stringify(proof));
    // Windows can release a just-terminated native handle slightly after the
    // child emits exit. Retry only this test-owned temporary root.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
