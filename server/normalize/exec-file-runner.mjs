import { execFile } from "node:child_process";
import { SHARE_ENV, Worker } from "node:worker_threads";

const MAX_RUNNING = 8;

// Starting a child process is synchronous work in the thread that starts it. On Windows a
// start usually costs about 10 ms, but about one in ten takes 300 ms to 900 ms, and a read
// that started its Git commands together held the monitor's event loop for seconds, so every
// route waited. The monitor's child processes are therefore started by one worker thread
// that runs `execFile` and posts each result back.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { execFile } = require("node:child_process");
const children = new Map();
parentPort.on("message", (message) => {
  if (message.type === "cancel") {
    try { children.get(message.id)?.kill(); } catch {}
    return;
  }
  const { id, file, args, options, input } = message;
  const reply = (error, stdout, stderr) => {
    children.delete(id);
    parentPort.postMessage({ id, stdout: stdout ?? "", stderr: stderr ?? "", error: error ? {
      message: String(error.message || "Command failed"), code: error.code ?? null, killed: error.killed === true, signal: error.signal ?? null,
    } : null });
  };
  let child;
  try { child = execFile(file, args, options, reply); }
  catch (error) { reply(error, "", ""); return; }
  children.set(id, child);
  if (input !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  }
});
`;

// A Buffer arrives from the worker as a plain Uint8Array.
const output = (value) => typeof value === "string" ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

/**
 * `execFile` run on a worker thread. Options must be cloneable; `input` is written to the
 * process's standard input. Returns a function that ends the process.
 */
export function createThreadExecFile({ createWorker = () => new Worker(WORKER_SOURCE, { eval: true, env: SHARE_ENV }), fallback = execFile } = {}) {
  const pending = new Map();
  let worker = null;
  let nextId = 1;

  function failAll(code) {
    const callbacks = [...pending.values()];
    pending.clear();
    worker = null;
    for (const callback of callbacks) callback(Object.assign(new Error("Command runner stopped"), { code, killed: false, signal: null }), "", "");
  }

  function ensureWorker() {
    if (worker) return worker;
    const created = createWorker();
    created.unref();
    created.on("message", ({ id, error, stdout, stderr }) => {
      const callback = pending.get(id);
      if (!callback) return;
      pending.delete(id);
      if (pending.size === 0) created.unref();
      callback(error ? Object.assign(new Error(error.message), { code: error.code, killed: error.killed, signal: error.signal }) : null, output(stdout), output(stderr));
    });
    created.on("error", () => { if (worker === created) failAll("RUNNER_FAILED"); });
    created.on("exit", () => { if (worker === created) failAll("RUNNER_EXITED"); });
    worker = created;
    return created;
  }

  return function threadExecFile(file, args, options, callback) {
    const { input, ...execOptions } = options || {};
    let target;
    try { target = ensureWorker(); }
    catch {
      // No worker thread: the process starts here, as it did before.
      const child = fallback(file, args, execOptions, callback);
      if (input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
      return () => { try { child.kill(); } catch { /* already ended */ } };
    }
    const id = nextId;
    nextId += 1;
    pending.set(id, callback);
    target.ref();
    try { target.postMessage({ id, file, args, options: execOptions, input }); }
    catch (error) {
      pending.delete(id);
      if (pending.size === 0) target.unref();
      callback(error, "", "");
      return () => {};
    }
    return () => { if (pending.has(id)) target.postMessage({ type: "cancel", id }); };
  };
}

// At most one process starts per event-loop turn and at most eight run at once, so a burst
// of reads neither floods the machine nor queues its start messages in one turn. A
// command's timeout starts when its process starts, so waiting here never times it out.
export function createExecFileRunner({ execFile: run = createThreadExecFile(), maxRunning = MAX_RUNNING, defer = setImmediate } = {}) {
  const waiting = [];
  let running = 0;
  let scheduled = false;

  function schedule() {
    if (scheduled || running >= maxRunning || waiting.length === 0) return;
    scheduled = true;
    defer(start);
  }

  function start() {
    scheduled = false;
    if (running >= maxRunning || waiting.length === 0) return;
    const command = waiting.shift();
    running += 1;
    let released = false;
    const finish = (...result) => {
      if (released) return;
      released = true;
      running -= 1;
      schedule();
      command.callback(...result);
    };
    try { command.cancel = run(command.file, command.args, command.options, finish); }
    catch (error) { finish(error, "", ""); }
    if (command.cancelled) command.cancel?.();
    schedule();
  }

  /** Same arguments as `execFile` with a callback, plus `input`; returns a function that ends the command. */
  return function runExecFile(file, args, options, callback) {
    const command = { file, args, options, callback, cancel: null, cancelled: false };
    waiting.push(command);
    schedule();
    return () => {
      command.cancelled = true;
      const index = waiting.indexOf(command);
      if (index >= 0) {
        waiting.splice(index, 1);
        callback(Object.assign(new Error("Command cancelled"), { code: "ABORT_ERR", killed: true, signal: null }), "", "");
      } else command.cancel?.();
    };
  };
}

export const runExecFile = createExecFileRunner();
