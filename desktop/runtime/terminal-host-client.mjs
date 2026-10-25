import { spawn as spawnChild } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { VERSION, encodeFrame, decodeFrames } from "../terminal-host/protocol.mjs";
import { hostIsAlive, prepareTerminalHostCopy, readHostState } from "./terminal-host-runtime.mjs";
import { minimalRuntimeEnvironment } from "./environment-policy.mjs";

const ERRORS = new Set(["TERMINAL_INVALID", "TERMINAL_NOT_FOUND", "TERMINAL_READ_ONLY", "TERMINAL_CAPACITY", "TERMINAL_SPAWN_FAILED", "UNKNOWN_COMMAND"]);
const unavailable = () => new Error("TERMINAL_UNAVAILABLE");

function outputStream(onReturn) {
  const queue = [];
  let bytes = 0;
  let waiter;
  let ended = false;
  return {
    readOnly: true,
    push(frame) {
      if (ended) return true;
      // A 256 KiB replay plus up to 4096 retained parts fits before attach resolves.
      const size = Buffer.byteLength(frame.data || "") + 32;
      if (bytes + size > 512 * 1024) return false;
      if (waiter) { const resolve = waiter; waiter = null; resolve({ value: frame, done: false }); }
      else { queue.push({ frame, size }); bytes += size; }
      return true;
    },
    end(reason) {
      if (reason && !ended) { queue.length = 0; bytes = 0; this.push({ event: "detached", reason }); }
      ended = true; waiter?.({ done: true }); waiter = null;
    },
    next() {
      if (queue.length) { const item = queue.shift(); bytes -= item.size; return Promise.resolve({ value: item.frame, done: false }); }
      if (ended) return Promise.resolve({ done: true });
      if (waiter) return Promise.reject(new Error("TERMINAL_INVALID"));
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() { queue.length = 0; bytes = 0; this.end(); await onReturn(); return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
}

/** Desktop-main only; tokens, process plans, and raw output never enter HTTP. */
export function createTerminalHostClient({ source, userData, spawn = spawnChild }) {
  let socket;
  let ensuring;
  let sequence = 0;
  const pending = new Map();
  const streams = new Map();

  function disconnected(connection) {
    if (connection !== socket) return;
    socket = null;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable()); }
    pending.clear();
    for (const stream of streams.values()) stream.end("host_unavailable");
    streams.clear();
  }

  function request(command, fields = {}) {
    if (!socket || socket.destroyed) return Promise.reject(unavailable());
    const connection = socket;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.destroy(); disconnected(connection); }, 5000);
      pending.set(id, { resolve, reject, timer });
      try {
        const frame = encodeFrame({ id, command, ...fields });
        if (command === "input" && frame.length > 16 * 1024) throw new Error("TERMINAL_INVALID");
        if (connection.writableLength + frame.length > 256 * 1024) throw new Error("TERMINAL_CAPACITY");
        connection.write(frame);
      } catch {
        pending.delete(id); clearTimeout(timer); reject(new Error("TERMINAL_INVALID"));
      }
    });
  }

  async function connect(directory, state) {
    if (state?.protocol !== VERSION) throw new Error("TERMINAL_PROTOCOL_MISMATCH");
    if (!state.pipe.startsWith("\\\\.\\pipe\\pomegr-")) throw unavailable();
    let token;
    try { token = (await readFile(path.join(directory, "host.token"), "utf8")).trim(); } catch { throw unavailable(); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw unavailable();
    const connection = net.createConnection(state.pipe);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.destroy(); reject(unavailable()); }, 2000);
      connection.once("connect", () => { clearTimeout(timer); resolve(); });
      connection.once("error", () => { clearTimeout(timer); reject(unavailable()); });
    });
    socket = connection;
    connection.on("error", () => { connection.destroy(); disconnected(connection); });
    connection.on("close", () => disconnected(connection));
    decodeFrames(connection, (frame) => {
      if (frame.event) {
        const stream = streams.get(frame.key);
        if (!stream) return;
        if (!stream.push(frame)) {
          stream.end("slow_client"); streams.delete(frame.key);
          void request("detach", { key: frame.key }).catch(() => {});
        }
        if (frame.event === "detached" || frame.event === "exit") { stream.end(); streams.delete(frame.key); }
        return;
      }
      const waiting = pending.get(frame.id);
      if (!waiting) return;
      pending.delete(frame.id); clearTimeout(waiting.timer);
      if (frame.ok === true) waiting.resolve(frame);
      else waiting.reject(new Error(ERRORS.has(frame.error) ? frame.error : "TERMINAL_UNAVAILABLE"));
    });
    try { await request("hello", { token, protocol: VERSION }); }
    catch (error) { connection.destroy(); disconnected(connection); throw error; }
  }

  async function ensureHost() {
    if (socket && !socket.destroyed) return;
    if (ensuring) return ensuring;
    ensuring = prepareTerminalHostCopy({ source, userData }, async ({ directory }) => {
      const state = await readHostState(directory);
      if (state && hostIsAlive(state)) { await connect(directory, state); return; }
      // No retry of a create: a timed-out launch may already have started a session.
      let failed = false;
      let child;
      try {
        child = spawn(path.join(directory, "node.exe"), [path.join(directory, "desktop", "terminal-host", "main.mjs")], {
          cwd: directory, env: minimalRuntimeEnvironment(process.env), detached: true,
          windowsHide: true, stdio: "ignore", shell: false,
        });
        child.once("error", () => { failed = true; });
        child.once("exit", () => { failed = true; });
        child.unref();
      } catch { throw unavailable(); }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !failed) {
        const candidate = await readHostState(directory);
        // A hard kill leaves the old state behind until the new host publishes it.
        if (!failed && candidate?.pid === child.pid && hostIsAlive(candidate)) { await connect(directory, candidate); return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw unavailable();
    }).finally(() => { ensuring = null; });
    return ensuring;
  }

  async function listHosts() {
    const parent = path.join(userData, "terminal-host");
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch { return []; }
    const hosts = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const state = await readHostState(path.join(parent, entry.name));
      if (hostIsAlive(state)) hosts.push({ buildId: entry.name, pid: state.pid, protocol: state.protocol });
    }
    return hosts;
  }

  async function detach(key, acknowledge = false) {
    const result = await request("detach", { key, acknowledge });
    streams.get(key)?.end(); streams.delete(key);
    return result;
  }

  return Object.freeze({
    ensureHost, listHosts,
    async connectHost(buildId) {
      if (!/^[a-f0-9]{64}$/.test(buildId)) throw unavailable();
      if (socket && !socket.destroyed) return;
      if (ensuring) return ensuring;
      ensuring = (async () => {
        const directory = path.join(userData, "terminal-host", buildId);
        const state = await readHostState(directory);
        if (!hostIsAlive(state)) throw unavailable();
        await connect(directory, state);
      })().finally(() => { ensuring = null; });
      return ensuring;
    },
    async create(plan) { return request("create", { plan }); },
    async list() { return (await request("list")).sessions; },
    async attach(key) {
      if (streams.has(key)) throw new Error("TERMINAL_INVALID");
      const stream = outputStream(() => streams.get(key) === stream ? detach(key).catch(() => {}) : Promise.resolve());
      streams.set(key, stream);
      try { stream.readOnly = (await request("attach", { key })).readOnly; return stream; }
      catch (error) { stream.end(); streams.delete(key); throw error; }
    },
    async input(key, data) {
      if (typeof data !== "string" || Buffer.byteLength(data) > 16 * 1024) throw new Error("TERMINAL_INVALID");
      // JSON escaping and the envelope count toward the host's smaller input-frame cap.
      // Queue a paste's chunks together so another input call cannot interleave them.
      const requests = [];
      let chunk = "";
      for (const character of data) {
        chunk += character;
        if (chunk.length >= 2048) { requests.push(request("input", { key, data: chunk })); chunk = ""; }
      }
      if (chunk || requests.length === 0) requests.push(request("input", { key, data: chunk }));
      await Promise.all(requests);
    },
    resize: (key, cols, rows) => request("resize", { key, cols, rows }),
    detach,
    close() { if (socket) { socket.destroy(); disconnected(socket); } },
  });
}
