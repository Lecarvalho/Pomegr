import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { VERSION } from "../terminal-host/protocol.mjs";
import { createTerminalHostClient } from "./terminal-host-client.mjs";

export const TERMINAL_CHANNEL = "pomegr:terminal";
export const TERMINAL_OUTPUT_CHANNEL = "pomegr:terminal-output";
const KEY = /^(repo-[a-f0-9]{24})\/(T-[1-9][0-9]{0,8})\/[a-f0-9]{32}$/u;
const SESSION = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ATTACH = /^[A-Za-z0-9_-]{1,128}$/u;
const failed = (status) => ({ ok: false, status });
const dimensions = (cols, rows) => Number.isInteger(cols) && cols >= 1 && cols <= 1000 && Number.isInteger(rows) && rows >= 1 && rows <= 1000;
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function terminalHostSource(resourcesPath = process.resourcesPath) {
  return resourcesPath && fileURLToPath(import.meta.url).includes(`${path.sep}app.asar${path.sep}`) ? path.join(resourcesPath, "terminal-runtime")
    : fileURLToPath(new URL("../../outputs/terminal-runtime", import.meta.url));
}

/** Desktop-main memory only: host keys identify tasks; only their confirmed task link identifies a session. */
export function createTerminalController(options = {}) {
  const source = options.terminalSource || terminalHostSource();
  const userData = options.userData || (options.worktreeRoot ? path.dirname(options.worktreeRoot) : null);
  const makeClient = options.createClient || createTerminalHostClient;
  const clientOptions = { source, userData };
  const client = options.client || (userData ? makeClient(clientOptions) : null);
  const clients = new Map();
  const records = new Map();
  const attachments = new Map();
  const watched = new Map();
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  let origin;
  try {
    const url = new URL(options.monitorOrigin);
    if (url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) origin = url.origin;
  } catch { /* Unavailable until configured. */ }
  let disposed = false;
  const trusted = (event) => !disposed && isTrustedEvent(event) && event.senderFrame
    && event.senderFrame === event.sender?.mainFrame && !event.sender.isDestroyed();

  async function readBoard(repositoryId) {
    if (!origin || !options.authorizationToken) return null;
    try {
      const response = await fetchImpl(`${origin}/api/tasks?${new URLSearchParams({ repositoryId })}`, {
        method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        headers: { [DESKTOP_AUTH_HEADER]: options.authorizationToken },
      });
      const board = await response.json();
      return response.ok && board?.readiness === "ready" && board.repositoryId === repositoryId && Array.isArray(board.tasks) ? board : null;
    } catch { return null; }
  }

  async function snapshot() {
    if (!client) return failed("host_unavailable");
    const hosts = [];
    const seen = new Set();
    const discovered = await client.listHosts();
    const alive = new Set(discovered.map((host) => host.buildId));
    for (const [buildId, connection] of clients) {
      if (!alive.has(buildId)) { connection.close(); clients.delete(buildId); }
    }
    const sources = [];
    for (const host of discovered) {
      const metadata = { buildId: host.buildId, protocol: host.protocol, state: host.protocol === VERSION ? "ready" : "incompatible_host" };
      hosts.push(metadata);
      if (host.protocol !== VERSION) continue;
      let connection = clients.get(host.buildId);
      if (!connection) { connection = makeClient(clientOptions); clients.set(host.buildId, connection); }
      try { await connection.connectHost(host.buildId); sources.push({ connection, metadata }); }
      catch { metadata.state = "host_unavailable"; }
    }
    // Injected clients need no runtime-directory discovery.
    if (options.client) sources.push({ connection: client });
    for (const { connection, metadata } of sources) {
      try {
        const rows = await connection.list();
        for (const row of rows) {
          const match = typeof row.key === "string" && KEY.exec(row.key);
          if (!match) continue;
          seen.add(row.key);
          const previous = records.get(row.key);
          records.set(row.key, { key: row.key, repositoryId: match[1], taskId: match[2], sessionId: previous?.sessionId ?? null,
            state: row.exited === true ? "exited" : "starting", ...(row.exited === true && Number.isInteger(row.exitCode) ? { exitCode: row.exitCode } : {}), connection });
        }
      } catch { if (metadata) metadata.state = "host_unavailable"; }
    }
    for (const record of records.values()) if (!seen.has(record.key) && record.state !== "exited") record.state = "host_unavailable";
    const repositories = [...new Set([...records.values()].map((row) => row.repositoryId))];
    const boards = await Promise.all(repositories.map(async (id) => [id, await readBoard(id)]));
    for (const [id, board] of boards) {
      for (const task of board?.tasks || []) {
        const taskRows = [...records.values()].filter((row) => row.repositoryId === id && row.taskId === task.id && (seen.has(row.key) || row.state === "exited"));
        const live = taskRows.filter((row) => row.state !== "exited");
        const candidates = live.length ? live : taskRows;
        const linked = typeof task.session?.id === "string" && SESSION.test(task.session.id) ? task.session.id : null;
        // More than one key cannot be reconstructed from a store that keeps only the current link.
        if (candidates.length === 1 && linked && !candidates[0].sessionId) candidates[0].sessionId = linked;
      }
    }
    const sessions = [...records.values()].map(({ connection: _connection, ...row }) => ({ ...row, state: row.state === "starting" && row.sessionId ? "live" : row.state }));
    return { ok: true, status: "ready", sessions, hosts };
  }

  async function detach(attachment) {
    if (attachments.get(attachment.id) !== attachment) return;
    attachments.delete(attachment.id);
    attachment.cancelled = true;
    try { await attachment.stream?.return(); } catch { /* Detach never stops the PTY. */ }
    if (attachment.exited) {
      try { await attachment.connection.detach(attachment.key, true); } catch { /* An exited process is already read-only. */ }
    }
  }

  function watch(sender) {
    if (watched.has(sender)) return;
    const detachAll = () => { for (const attachment of attachments.values()) if (attachment.event.sender === sender) void detach(attachment); };
    const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) detachAll(); };
    sender.on("did-start-navigation", navigation);
    sender.on("render-process-gone", detachAll);
    sender.on("destroyed", detachAll);
    watched.set(sender, () => { sender.removeListener("did-start-navigation", navigation); sender.removeListener("render-process-gone", detachAll); sender.removeListener("destroyed", detachAll); });
  }

  async function pump(attachment) {
    try {
      for await (const frame of attachment.stream) {
        if (attachments.get(attachment.id) !== attachment || !trusted(attachment.event)) break;
        const value = { attachId: attachment.id, event: frame.event };
        if (frame.event === "output" && typeof frame.data === "string") value.data = frame.data;
        else if (frame.event === "exit" && Number.isInteger(frame.exitCode)) {
          value.exitCode = frame.exitCode;
          attachment.exited = true;
          const record = records.get(attachment.key);
          if (record) { record.state = "exited"; record.exitCode = frame.exitCode; }
        }
        else if (frame.event === "detached") value.reason = ["slow_client", "host_unavailable"].includes(frame.reason) ? frame.reason : "host_unavailable";
        else continue;
        attachment.event.senderFrame.send(TERMINAL_OUTPUT_CHANNEL, value);
      }
    } catch { /* Output stays on this frame only. */ }
    finally { await detach(attachment); }
  }

  async function run(event, operation, payload) {
    if (!trusted(event)) return failed("invalid");
    if (operation === "list") return payload === undefined || (plain(payload) && Object.keys(payload).length === 0) ? snapshot() : failed("invalid");
    if (!["attach", "input", "resize", "detach"].includes(operation) || !plain(payload)
      || typeof payload.attachId !== "string" || !ATTACH.test(payload.attachId)) return failed("invalid");
    const expected = operation === "attach" ? ["key", "attachId"] : operation === "input" ? ["attachId", "data"] : operation === "resize" ? ["attachId", "cols", "rows"] : ["attachId"];
    if (Object.keys(payload).length !== expected.length || expected.some((name) => !Object.hasOwn(payload, name))) return failed("invalid");
    if (operation === "input" && (typeof payload.data !== "string" || Buffer.byteLength(payload.data) > 16 * 1024)) return failed("invalid");
    if (operation === "resize" && !dimensions(payload.cols, payload.rows)) return failed("invalid");
    if (operation === "attach") {
      if (typeof payload.key !== "string" || !KEY.test(payload.key) || attachments.has(payload.attachId)) return failed("invalid");
      await snapshot();
      const record = records.get(payload.key);
      if (!record) return failed("not_found");
      if (record.state === "host_unavailable") return failed("host_unavailable");
      if ([...attachments.values()].some((item) => item.key === payload.key)) return failed("read_only");
      const attachment = { id: payload.attachId, key: payload.key, event, connection: record.connection };
      attachments.set(attachment.id, attachment); watch(event.sender);
      try {
        attachment.stream = await record.connection.attach(payload.key);
        if (attachment.cancelled || !trusted(event)) { await attachment.stream.return(); return failed("host_unavailable"); }
        void pump(attachment);
        return { ok: true, status: "attached", readOnly: attachment.stream.readOnly };
      } catch { await detach(attachment); return failed("host_unavailable"); }
    }
    const attachment = attachments.get(payload.attachId);
    if (!attachment || attachment.event.senderFrame !== event.senderFrame) return failed("not_found");
    if (operation === "detach") { await detach(attachment); return { ok: true, status: "detached" }; }
    if (!attachment.stream || attachment.stream.readOnly) return failed("read_only");
    try {
      if (operation === "input") await attachment.connection.input(attachment.key, payload.data);
      else await attachment.connection.resize(attachment.key, payload.cols, payload.rows);
      return { ok: true, status: "ready" };
    } catch (error) { return failed(error.message === "TERMINAL_READ_ONLY" ? "read_only" : "host_unavailable"); }
  }

  return Object.freeze({ run,
    async ensureHost() {
      if (!client || disposed) throw new Error("TERMINAL_UNAVAILABLE");
      await client.ensureHost();
      if (disposed) { client.close(); return; }
      // Unviewed queue sessions must not occupy the host's capacity after they exit.
      for (const row of await client.list()) {
        const match = typeof row.key === "string" && KEY.exec(row.key);
        if (!match || row.exited !== true || !Number.isInteger(row.exitCode)) continue;
        records.set(row.key, { key: row.key, repositoryId: match[1], taskId: match[2], sessionId: records.get(row.key)?.sessionId ?? null,
          state: "exited", exitCode: row.exitCode, connection: client });
        await client.detach(row.key, true);
      }
    },
    async create(plan) { if (!client || disposed) throw new Error("TERMINAL_UNAVAILABLE"); return client.create(plan); },
    dispose() {
      disposed = true;
      for (const attachment of attachments.values()) void detach(attachment);
      for (const remove of watched.values()) remove(); watched.clear();
      client?.close(); for (const connection of clients.values()) connection.close();
    },
  });
}

export function installTerminalIpc({ ipcMain, controller }) {
  ipcMain.removeHandler(TERMINAL_CHANNEL);
  ipcMain.handle(TERMINAL_CHANNEL, async (event, operation, payload) => {
    try { return await controller.run(event, operation, payload); } catch { return failed("host_unavailable"); }
  });
  return () => { ipcMain.removeHandler(TERMINAL_CHANNEL); };
}
