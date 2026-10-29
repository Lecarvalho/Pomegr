import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { VERSION } from "../terminal-host/protocol.mjs";
import { createTerminalHostClient } from "./terminal-host-client.mjs";

export const TERMINAL_CHANNEL = "pomegr:terminal";
export const TERMINAL_OUTPUT_CHANNEL = "pomegr:terminal-output";
const KEY = /^(repo-[a-f0-9]{24})\/(T-[1-9][0-9]{0,8})\/(review-)?[a-f0-9]{32}$/u;
const CONTINUE_KEY = /^continue\/(claude|codex)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/[a-f0-9]{32}$/iu;
const SESSION = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ATTACH = /^[A-Za-z0-9_-]{1,128}$/u;
// A session in one of these observed states is not answering; any other state, or none, counts as working.
const NOT_WORKING = new Set(["idle", "open", "stopped", "closed"]);
const failed = (status) => ({ ok: false, status });
const dimensions = (cols, rows) => Number.isInteger(cols) && cols >= 1 && cols <= 1000 && Number.isInteger(rows) && rows >= 1 && rows <= 1000;
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function terminalHostSource(resourcesPath = process.resourcesPath) {
  return resourcesPath && fileURLToPath(import.meta.url).includes(`${path.sep}app.asar${path.sep}`) ? path.join(resourcesPath, "terminal-runtime")
    : fileURLToPath(new URL("../../outputs/terminal-runtime", import.meta.url));
}

/** Desktop-main memory only: dispatch keys bind through tasks; Continue keys name the resumed session. */
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
  // The boards the last listing read, and the keys of working sessions the owner chose to keep running (this app run only).
  const boards = new Map();
  const kept = new Set();
  let ending = Promise.resolve();
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

  async function readReviewSession(repositoryId, taskId) {
    try {
      const response = await fetchImpl(`${origin}/internal/tasks/review-session`, {
        method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        headers: { [DESKTOP_AUTH_HEADER]: options.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId, payload: { id: taskId } }),
      });
      const answer = await response.json();
      if (!response.ok || answer?.ok !== true) return null;
      const valid = (value) => typeof value === "string" && SESSION.test(value);
      return { sessionId: valid(answer.sessionId) ? answer.sessionId : null,
        sessionIds: Array.isArray(answer.sessionIds) ? answer.sessionIds.filter(valid) : [] };
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
    const listed = new Set();
    for (const { connection, metadata } of sources) {
      try {
        const rows = await connection.list();
        listed.add(connection);
        for (const row of rows) {
          const match = typeof row.key === "string" && KEY.exec(row.key);
          const continued = typeof row.key === "string" && CONTINUE_KEY.exec(row.key);
          if (!match && !continued) continue;
          seen.add(row.key);
          const previous = records.get(row.key);
          const continuedFrom = continued ? `${continued[1]}:${continued[2]}` : null;
          let observed = null;
          if (continued && !row.exited && Number.isInteger(row.pid) && row.pid > 0) {
            try { observed = await options.sessionForProcess?.(row.pid); } catch { /* No identity claim without observation. */ }
          }
          records.set(row.key, { key: row.key, repositoryId: match ? match[1] : null, taskId: match ? match[2] : null,
            ...(match ? { role: match[3] ? "review" : "build" } : {}),
            sessionId: continued ? (typeof observed === "string" && SESSION.test(observed) ? observed : previous?.sessionId ?? continuedFrom) : previous?.sessionId ?? null,
            ...(continuedFrom ? { continuedFrom } : {}),
            state: row.exited === true ? "exited" : "starting", ...(row.exited === true && Number.isInteger(row.exitCode) ? { exitCode: row.exitCode } : {}), connection });
        }
      } catch { if (metadata) metadata.state = "host_unavailable"; }
    }
    // A host that answered no longer holds the key only after its process exited and the exit was acknowledged.
    for (const record of records.values()) if (!seen.has(record.key) && record.state !== "exited") record.state = listed.has(record.connection) ? "exited" : "host_unavailable";
    const repositories = [...new Set([...records.values()].map((row) => row.repositoryId).filter(Boolean))];
    const read = await Promise.all(repositories.map(async (id) => [id, await readBoard(id)]));
    for (const [id, board] of read) {
      if (board) boards.set(id, board); else boards.delete(id);
      for (const task of board?.tasks || []) for (const role of ["build", "review"]) {
        const taskRows = [...records.values()].filter((row) => row.repositoryId === id && row.taskId === task.id && row.role === role && (seen.has(row.key) || row.state === "exited"));
        const live = taskRows.filter((row) => row.state !== "exited");
        const candidates = live.length ? live : taskRows;
        if (role === "review") {
          const unresolved = taskRows.filter((row) => !row.sessionId);
          const linked = unresolved.length ? await readReviewSession(id, task.id) : null;
          if (!linked) continue;
          const claimed = new Set([...records.values()].map((row) => row.sessionId).filter(Boolean));
          // The current reviewer belongs to the one candidate key. Only an ended candidate falls back to the latest
          // kept reviewer: a live key whose review has not linked yet waits, or it would take an earlier reviewer.
          const only = candidates.length === 1 && !candidates[0].sessionId ? candidates[0] : null;
          const latest = only?.state === "exited" ? linked.sessionIds.filter((value) => !claimed.has(value)).at(-1) : null;
          const current = linked.sessionId && !claimed.has(linked.sessionId) ? linked.sessionId : latest;
          if (only && current) {
            only.sessionId = current;
            claimed.add(current);
          }
          // The store keeps every reviewer in link order, and one host lists ended reviews in creation order,
          // so the remaining ended keys pair with the unclaimed reviewers. Live keys stay unbound until their review links.
          const rest = unresolved.filter((row) => !row.sessionId && row.state === "exited");
          const open = linked.sessionIds.filter((value) => !claimed.has(value));
          if (rest.length > 0 && open.length === rest.length && rest.every((row) => row.connection === rest[0].connection)) {
            rest.forEach((row, index) => { row.sessionId = open[index]; });
          }
          continue;
        }
        if (candidates.length !== 1 || candidates[0].sessionId) continue;
        const linked = task.session?.id;
        if (typeof linked === "string" && SESSION.test(linked)) candidates[0].sessionId = linked;
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
        if (frame.event === "output" && typeof frame.data === "string") {
          value.data = frame.data;
          if (frame.replay === true) value.replay = true;
        }
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

  // A builder is working unless the monitor observes its linked session in a state above; a reviewer is working until its verdict.
  // A session that is not linked to the task yet has no observed state, so it counts as working.
  const isWorking = (record, task) => record.role === "review" ? !["passed", "failed"].includes(task.review?.state)
    : !(record.sessionId && task.session?.id === record.sessionId && NOT_WORKING.has(task.session.state));

  // The task keys that are running now, each with the task the monitor lists for it. A key of another kind never appears.
  async function liveTaskSessions({ repositoryId, taskId, done }) {
    if ((await snapshot()).ok !== true) return [];
    const found = [];
    for (const record of records.values()) {
      if (record.state !== "starting" || !record.role || (repositoryId && record.repositoryId !== repositoryId) || (taskId && record.taskId !== taskId)) continue;
      const task = boards.get(record.repositoryId)?.tasks.find((item) => item.id === record.taskId);
      if (task && (!done || task.state === "done")) found.push({ record, task });
    }
    return found;
  }

  // Ends the process tree of each running key of a Done task: a working one only when `endWorking` says so.
  // The owner's own settle (`owner`) remembers the working ones it left running, so a later pass does not end them.
  async function endNow({ repositoryId, taskId, endWorking = false, owner = false }) {
    let ended = 0;
    let working = 0;
    for (const { record, task } of await liveTaskSessions({ repositoryId, taskId, done: true })) {
      if (isWorking(record, task) && !endWorking) {
        working += 1;
        if (owner) kept.add(record.key);
        continue;
      }
      if (!owner && kept.has(record.key)) continue;
      try {
        // A key the host does not list as exited yet is left as it is; the next pass reads it again.
        if (await record.connection.end(record.key)) {
          record.state = "exited";
          kept.delete(record.key);
          await record.connection.detach(record.key, true).catch(() => {});
          ended += 1;
        }
      } catch { /* The host or the process could not be reached; the next pass asks again. */ }
    }
    // A host of an older build exits by itself once no connection holds it and no session runs.
    for (const [buildId, connection] of clients) {
      const busy = [...records.values()].some((record) => record.connection === connection && record.state === "starting")
        || [...attachments.values()].some((attachment) => attachment.connection === connection);
      if (!busy) { connection.close(); clients.delete(buildId); }
    }
    return { ended, working };
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
      if (typeof payload.key !== "string" || (!KEY.test(payload.key) && !CONTINUE_KEY.test(payload.key)) || attachments.has(payload.attachId)) return failed("invalid");
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
        const continued = typeof row.key === "string" && CONTINUE_KEY.exec(row.key);
        if ((!match && !continued) || row.exited !== true || !Number.isInteger(row.exitCode)) continue;
        const continuedFrom = continued ? `${continued[1]}:${continued[2]}` : null;
        records.set(row.key, { key: row.key, repositoryId: match ? match[1] : null, taskId: match ? match[2] : null,
          ...(match ? { role: match[3] ? "review" : "build" } : {}),
          sessionId: records.get(row.key)?.sessionId ?? continuedFrom, ...(continuedFrom ? { continuedFrom } : {}),
          state: "exited", exitCode: row.exitCode, connection: client });
        await client.detach(row.key, true);
      }
    },
    async create(plan) { if (!client || disposed) throw new Error("TERMINAL_UNAVAILABLE"); return client.create(plan); },
    // The process ID of a running terminal of this host; null once it exited or when unknown.
    async processOf(key) {
      if (!client || disposed) return null;
      try {
        const row = (await client.list()).find((item) => item.key === key);
        return row && row.exited !== true && Number.isInteger(row.pid) && row.pid > 0 ? row.pid : null;
      } catch { return null; }
    },
    // How many keys of one task run now and how many of them work, for the question the Done action asks.
    async taskSessions(repositoryId, taskId) {
      if (!client || disposed) return { live: 0, working: 0 };
      const found = await liveTaskSessions({ repositoryId, taskId, done: false });
      return { live: found.length, working: found.filter(({ record, task }) => isWorking(record, task)).length };
    },
    // Ends the sessions of Done tasks (every repository, or one task). Only the owner's Done action may pass `endWorking`.
    endDone(scope = {}) {
      if (!client || disposed) return Promise.resolve({ ended: 0, working: 0 });
      const next = ending.then(() => endNow(scope), () => endNow(scope));
      ending = next.catch(() => {});
      return next;
    },
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
