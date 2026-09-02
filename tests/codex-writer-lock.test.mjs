import assert from "node:assert/strict";
import test from "node:test";
import { isActiveCodexWriterLock } from "../monitor/providers/codex-cli-observation.mjs";

function fileStat() {
  return { isFile: () => true };
}

function options(overrides = {}) {
  return {
    platform: "win32",
    statFileSync: fileStat,
    ...overrides,
  };
}

test("writer lock probe is Windows-only", () => {
  const calls = [];
  assert.equal(isActiveCodexWriterLock("writer.lock", options({
    platform: "linux",
    statFileSync: () => { calls.push("stat"); return fileStat(); },
    openFileSync: () => { calls.push("open"); return 1; },
    readSync: () => { calls.push("read"); return 1; },
  })), false);
  assert.deepEqual(calls, []);
});

test("missing or non-file lock paths do not open or read", () => {
  for (const statFileSync of [
    () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    () => ({ isFile: () => false }),
  ]) {
    const calls = [];
    assert.equal(isActiveCodexWriterLock("not-a-lock", options({
      statFileSync,
      openFileSync: () => { calls.push("open"); return 1; },
      readSync: () => { calls.push("read"); return 1; },
    })), false);
    assert.deepEqual(calls, []);
  }
});

test("writer lock probe opens read-only and reads one byte at offset zero", () => {
  const calls = [];
  const result = isActiveCodexWriterLock("writer.lock", options({
    openFileSync: (file, flags) => {
      calls.push(["open", file, flags]);
      return 23;
    },
    readSync: (...args) => calls.push(["read", ...args.slice(0, 1), args[2], args[3], args[4]]),
    closeFileSync: (descriptor) => calls.push(["close", descriptor]),
  }));

  assert.equal(result, false);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [["open", "writer.lock"], ["read", 23], ["close", 23]]);
  assert.equal(calls[0][2], "r");
  assert.equal(calls[1][2], 0);
  assert.equal(calls[1][3], 1);
  assert.equal(calls[1][4], 0);
});

test("empty writer-lock file is unlocked", () => {
  let closed = false;
  assert.equal(isActiveCodexWriterLock("empty.lock", options({
    openFileSync: () => 4,
    readSync: () => 0,
    closeFileSync: () => { closed = true; },
  })), false);
  assert.equal(closed, true);
});

test("read EBUSY after a successful read-only open means the writer lock is active", () => {
  let closed = false;
  const error = Object.assign(new Error("sharing violation"), { code: "EBUSY" });
  assert.equal(isActiveCodexWriterLock("active.lock", options({
    openFileSync: () => 9,
    readSync: () => { throw error; },
    closeFileSync: (descriptor) => { closed = descriptor === 9; },
  })), true);
  assert.equal(closed, true);
});

test("permission and other probe failures are not treated as an active lock", () => {
  for (const code of ["EACCES", "EPERM", "ENOENT", "EIO"]) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(isActiveCodexWriterLock("failed.lock", options({
      openFileSync: () => 12,
      readSync: () => { throw error; },
      closeFileSync: () => {},
    })), false, code);
  }
});

test("an open-time sharing violation is active but open-time permission failures are not", () => {
  const sharingViolation = Object.assign(new Error("sharing violation"), { code: "EBUSY" });
  assert.equal(isActiveCodexWriterLock("open-busy.lock", options({
    openFileSync: () => { throw sharingViolation; },
  })), true);
  for (const code of ["EACCES", "EPERM"]) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(isActiveCodexWriterLock("open-permission.lock", options({
      openFileSync: () => { throw error; },
    })), false, code);
  }
});

test("descriptor zero is read and cleaned up", () => {
  const calls = [];
  assert.equal(isActiveCodexWriterLock("zero.lock", options({
    openFileSync: () => 0,
    readSync: (descriptor, buffer, bufferOffset, length, position) => {
      calls.push([descriptor, buffer, bufferOffset, length, position]);
      return 1;
    },
    closeFileSync: (descriptor) => calls.push(["close", descriptor]),
  })), false);
  assert.equal(calls[0][0], 0);
  assert.equal(calls[0][1].byteLength, 1);
  assert.deepEqual(calls[0].slice(2), [0, 1, 0]);
  assert.deepEqual(calls[1], ["close", 0]);
});

test("cleanup failures do not turn a cold discovery probe into an error", () => {
  assert.doesNotThrow(() => {
    assert.equal(isActiveCodexWriterLock("cleanup.lock", options({
      openFileSync: () => 5,
      readSync: () => 1,
      closeFileSync: () => { throw new Error("close failed"); },
    })), false);
  });
});
