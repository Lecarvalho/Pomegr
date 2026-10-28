// Desktop main owns Aril's read-only runs, conversations, approved changes, grant writes, grant follow-ups, and direct rework records.

import { execFile as execFileChild, spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { RUN_MODEL_AGENTS_QUERY } from "../../shared/task-run-models.mjs";
import { CHAT_IMAGE_ID, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGES_PER_CONVERSATION, conversationImages, createAgentChatImages } from "./agent-chat-images.mjs";
import { createGrantFollowUps } from "./agent-chat-grant-follow-up.mjs";
import { chatTaskLog } from "./agent-chat-task-log.mjs";
import { AGENT_CHAT_INSTRUCTIONS, composePrompt, proposalOutcome } from "./agent-chat-prompt.mjs";
import { applyOperations, ARIL_OPERATIONS, chatImageIds, extractProposal, FEATURE_EDIT_OPERATIONS, proposalImages, queueProposalState, recordRework, START_FAILURES, startProposalTask, visibleAnswer, WORKTREE_RESULTS } from "./agent-chat-proposal.mjs";
import { CHAT_EFFORTS, runChatTurn, validInstructionsFile } from "./agent-chat-runner.mjs";
import { AGENT_CHAT_DIRECTORY, ANSWER_LENGTH, conversationTitle, createAgentChatStore, MESSAGE_LENGTH, MESSAGE_LIMIT, newProposalId } from "./agent-chat-store.mjs";
import { readWorkflowChanges } from "./agent-chat-workflow.mjs";
import { claudeDiscoveryEnvironment, resolveClaudeExecutable } from "./claude-auth.mjs";
import { userSessionEnvironment } from "./environment-policy.mjs";
import { resolveCodexExecutable } from "./plugin-cli.mjs";
import { createTaskWorktrees, TASK_WORKTREE_DIRECTORY } from "./task-worktree.mjs";
export { isWorkflowSourcePath, readWorkflowChanges, workflowSources } from "./agent-chat-workflow.mjs";

export const AGENT_CHAT_CHANNEL = "pomegr:agent-chat";
// The images the owner sends to Aril travel on a channel of their own, because they are bytes and not a JSON payload.
export const AGENT_CHAT_IMAGE_CHANNEL = "pomegr:agent-chat-image";
export const AGENT_CHAT_IMAGE_OPERATIONS = Object.freeze(["add", "read"]);
export const AGENT_CHAT_OPERATIONS = Object.freeze(["list", "read", "send", "stop", "apply", "dismiss", "delete"]);
export const AGENT_CHAT_ERRORS = Object.freeze(["invalid", "not_found", "busy", "limit", "cli_missing", "conflict", "unavailable", "desktop_only"]);
export const AGENT_CHAT_REQUEST_MAX_BYTES = 17 * 1024;

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
const PROPOSAL_ID = /^p-[0-9a-f]{12}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const MESSAGE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const EFFORTS = new Set(CHAT_EFFORTS);
// The effort a record carries: the field for a level, nothing for none, so an older record without one still reads as null.
const effortField = (effort) => (typeof effort === "string" && EFFORTS.has(effort) ? { effort } : {});
const TASK_ACTIONS = new Set(["create", "update", "delete", "move", "feature_create", "feature_update", "feature_delete", "queue_add", "queue_remove", "queue_group", "queue_ungroup", "after_set", "aril_settings_set", "aril_memory_add", "aril_memory_update", "aril_memory_remove"]);
// The canonical queue control of the Tasks page. The chat sends it only for an approved queue proposal, with the one setting `on`.
const QUEUE_ACTION = "queue_settings";
const MONITOR_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported"]);
const MONITOR_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 20_000;
const DECLARATION_TIMEOUT_MS = 2_000;

const MCP_WORKER = ["desktop", "workers", "agent-chat-mcp.cjs"];

// Only fixed instructions enter this file; an unavailable file leaves the turn's stdin form intact.
export async function prepareInstructionsFile(dataRoot, content = AGENT_CHAT_INSTRUCTIONS) {
  let temporary;
  try {
    if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) return null;
    const folder = path.join(dataRoot, AGENT_CHAT_DIRECTORY);
    const file = path.join(folder, `instructions-${createHash("sha256").update(content).digest("hex")}.md`);
    const instructions = { folder, file };
    if (!validInstructionsFile(instructions)) return null;
    if (await fs.readFile(file, "utf8").catch(() => null) === content) return instructions;
    await fs.mkdir(folder, { recursive: true });
    temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
    return instructions;
  } catch { return null; }
  finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
}

/** The chat's own MCP server: the desktop executable running the bundled read-only server as Node. Null when it is not built. */
export function agentChatMcpServer({ executable, unpackedRoot, fileExists = existsSync } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || typeof unpackedRoot !== "string" || !path.isAbsolute(unpackedRoot)) return null;
  const script = path.join(unpackedRoot, ...MCP_WORKER);
  let present = false;
  try { present = fileExists(script) === true; } catch { present = false; }
  return present ? Object.freeze({ command: executable, args: Object.freeze([script]), env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }) }) : null;
}

const refused = (error) => Object.freeze({ ok: false, error });
const INVALID = refused("invalid");
const UNAVAILABLE = refused("unavailable");

function trustedMonitorOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const exactly = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function summary(conversation) {
  return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, messages: conversation.messages.length };
}

/** Native-only owner of the chat. Every answer is built here from validated parts; no provider or monitor text passes through. */
export function createAgentChat(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const sourceEnvironment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const fileExists = options.fileExists || existsSync;
  const spawn = options.spawn || spawnChild;
  const execFile = options.execFile || execFileChild;
  const now = options.now || (() => new Date());
  const runTurn = options.runTurn || runChatTurn;
  // The desktop's manual start for a start the owner approved in the chat: `(event, repositoryId, taskId)` answers `{ status }`.
  const startTask = typeof options.startTask === "function" ? options.startTask : null;
  // The same Git worktrees as the dispatcher, found where it makes them. Their paths stay in this file's calls and never leave desktop main.
  const worktrees = options.worktrees || createTaskWorktrees({ root: options.dataRoot ? path.join(options.dataRoot, TASK_WORKTREE_DIRECTORY) : undefined, environment: sourceEnvironment, platform });
  // The repository's own GitHub merge settings, so Aril proposes merge settings that fit them: `read(repositoryId, root)`.
  const repositoryGithub = typeof options.repositoryGithub?.read === "function" ? options.repositoryGithub : null;
  const mcpServer = options.mcpServer === undefined ? agentChatMcpServer({ executable: options.executable, unpackedRoot: options.unpackedRoot, fileExists }) : options.mcpServer;
  const store = options.store || (typeof options.dataRoot === "string" && path.isAbsolute(options.dataRoot)
    ? createAgentChatStore({ directory: path.join(options.dataRoot, AGENT_CHAT_DIRECTORY), now }) : null);
  const images = options.images || (typeof options.dataRoot === "string" && path.isAbsolute(options.dataRoot)
    ? createAgentChatImages({ directory: path.join(options.dataRoot, AGENT_CHAT_DIRECTORY) }) : null);
  let disposed = false;
  // One turn at a time for the whole app: `{ repositoryId, conversationId, ... }` from the moment a send is accepted.
  let active = null;
  const applying = new Set();
  // The follow-ups that wait for the one turn: `repositoryId/proposalId` to `{ repositoryId, conversationId, proposalId,
  // provider, model, queuedAt }`. A proposal has at most one here, so a second answer to it replaces the first.
  const followUps = new Map();

  async function monitor(pathname, init) {
    const response = await fetchImpl(`${monitorOrigin}${pathname}`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? MONITOR_TIMEOUT_MS),
      ...init, headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, ...init?.headers },
    });
    return response.json();
  }

  // Claude Code registers even a chat run that keeps no session file. The run gets a session ID desktop main makes, and
  // the monitor holds that ID for the turn so the registration never shows as a session; the turn's end withdraws it,
  // and the monitor lets it expire on its own if desktop main is gone. A refused or late declaration still starts the
  // run: its row then shows while it answers. A Codex run keeps no thread and registers nothing, so it declares nothing.
  async function declareRun(provider) {
    if (provider !== "claude") return null;
    const sessionId = (options.newSessionId || randomUUID)();
    try {
      await monitor(`/internal/agent-chat/run-declare?${new URLSearchParams({ sessionId })}`, { method: "POST", signal: AbortSignal.timeout(DECLARATION_TIMEOUT_MS) });
    } catch { /* The run starts anyway. */ }
    return sessionId;
  }

  function withdrawRun(sessionId) {
    if (!sessionId) return;
    void monitor(`/internal/agent-chat/run-withdraw?${new URLSearchParams({ sessionId })}`, { method: "POST", signal: AbortSignal.timeout(DECLARATION_TIMEOUT_MS) }).catch(() => {});
  }

  const postAction = (route, repositoryId, payload) => monitor(`/internal/tasks/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId, payload }),
  });

  async function readBoard(repositoryId) {
    try {
      const board = await monitor(`/api/tasks?${new URLSearchParams({ repositoryId })}`, { method: "GET" });
      return isPlainObject(board) && board.readiness === "ready" && board.repositoryId === repositoryId ? board : null;
    } catch { return null; }
  }

  async function readTaskLog(repositoryId) {
    try { return chatTaskLog(await postAction("log-read", repositoryId, { limit: 100 })); } catch { return null; }
  }

  // One memory-only capability per turn. Only this bridge knows the repository and desktop credential.
  async function taskReadServer(turn) {
    if (!mcpServer) return null;
    const key = randomBytes(32).toString("base64url");
    const server = createServer(async (request, response) => {
      const supplied = request.headers["x-pomegr-chat-task-key"];
      const authenticated = typeof supplied === "string" && /^[A-Za-z0-9_-]{43}$/u.test(supplied)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(key));
      let url = null;
      try { url = new URL(request.url || "/", "http://127.0.0.1"); } catch { /* malformed request is refused */ }
      const taskId = url?.searchParams.get("task_id");
      const listing = url?.pathname === "/tasks";
      const filters = ["query", "state", "feature", "editable"];
      const listValid = listing && [...url.searchParams.keys()].every((name) => filters.includes(name))
        && [...url.searchParams.keys()].length === new Set(url.searchParams.keys()).size;
      const valid = authenticated && request.headers.origin === undefined
        && request.headers.host === `127.0.0.1:${server.address()?.port}`
        && request.method === "GET" && (listing ? listValid : url?.pathname === "/task" && TASK_ID.test(taskId ?? "")
          && [...url.searchParams.keys()].length === 1) && !request.headers["transfer-encoding"]
        && !(Number(request.headers["content-length"] || 0) > 0) && active === turn && !disposed && !turn.stopped;
      let answer = { ok: false };
      if (valid) {
        try {
          const params = listing ? Object.fromEntries(url.searchParams) : { taskId };
          answer = await monitor(`/internal/agent-chat/task?${new URLSearchParams({ repositoryId: turn.repositoryId, ...params })}`, { method: "GET" });
        }
        catch { /* fixed unavailable answer */ }
      }
      response.writeHead(valid ? 200 : 403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(answer));
    });
    const close = () => { server.close(); server.closeAllConnections(); };
    turn.closeTaskRead = close;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      if (disposed || turn.stopped || active !== turn) { close(); return null; }
    return { ...mcpServer, env: { ...mcpServer.env,
        POMEGR_CHAT_TASK_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        POMEGR_CHAT_TASK_KEY: key,
      } };
    } catch { close(); return mcpServer; }
  }

  // The Pomegr task worktrees still on disk, as facts only (never a path). A turn goes on without them when they cannot be read.
  async function readWorktrees(repositoryId, root, board) {
    try {
      const rows = await worktrees.inventory({ repositoryRoot: root, repositoryId, tasks: board.tasks, columns: board.columns });
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  // The observed runs the task form's Claude model list reads, cut to the source and the model of each. A committed GET;
  // no answer leaves the Claude list to the board's own tasks.
  async function readRuns() {
    try {
      const agents = await monitor(`/api/agents?${new URLSearchParams({ ...RUN_MODEL_AGENTS_QUERY, days: String(RUN_MODEL_AGENTS_QUERY.days) })}`, { method: "GET" });
      return (Array.isArray(agents?.runs) ? agents.runs : []).filter(isPlainObject).map((run) => ({ source: run.source, model: run.model }));
    } catch { return []; }
  }

  async function repositoryRoot(repositoryId) {
    try {
      const answer = await postAction("worktree-root", repositoryId, {});
      const root = isPlainObject(answer) && answer.ok === true ? answer.root : null;
      return typeof root === "string" && path.isAbsolute(root) && !/[\u0000\r\n"]/u.test(root) ? root : null;
    } catch { return null; }
  }

  const monitorRefusal = (answer) => refused(isPlainObject(answer) && typeof answer.error === "string" && MONITOR_ERRORS.has(answer.error) ? answer.error : "unavailable");

  // The applier's one way to the board: the fixed task actions, validated by the monitor like any desktop action.
  async function taskAction(repositoryId, action, payload) {
    if (!TASK_ACTIONS.has(action)) return refused("invalid");
    try {
      const answer = await postAction(action, repositoryId, payload);
      if (isPlainObject(answer) && answer.ok === true) {
        return { ok: true, board: isPlainObject(answer.board) ? answer.board : null, taskId: typeof answer.taskId === "string" && TASK_ID.test(answer.taskId) ? answer.taskId : null };
      }
      return monitorRefusal(answer);
    } catch { return UNAVAILABLE; }
  }

  // One image the owner sent in the conversation, stored on a task through the monitor's own image route, as the Task
  // form stores one. The bytes come from the chat's own file; the monitor checks the type, the bounds, and the task.
  async function attachImage(repositoryId, conversation, taskId, imageId) {
    const image = conversationImages(conversation.messages).find((candidate) => candidate.id === imageId);
    if (!images || !image || !TASK_ID.test(String(taskId))) return refused("not_found");
    try {
      const bytes = await images.read(repositoryId, conversation.id, image);
      if (!bytes) return refused("not_found");
      const answer = await monitor(`/internal/tasks/image-add?${new URLSearchParams({ repositoryId, taskId, imageId })}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        signal: AbortSignal.timeout(options.imageTimeoutMs ?? IMAGE_TIMEOUT_MS),
      });
      return isPlainObject(answer) && answer.ok === true && answer.imageId === imageId ? { ok: true } : monitorRefusal(answer);
    } catch { return UNAVAILABLE; }
  }

  // An approved queue proposal: the desired state and nothing else, so no threshold or schedule rides along and a
  // repeated request never reverses the queue. The monitor judges it as it does for the Board's own control, and only
  // the desktop queue runner starts anything afterwards.
  async function setQueue(repositoryId, on) {
    try {
      const answer = await postAction(QUEUE_ACTION, repositoryId, { on });
      if (!isPlainObject(answer) || answer.ok !== true) return monitorRefusal(answer);
      const status = isPlainObject(answer.board) && isPlainObject(answer.board.queue) ? answer.board.queue.status : null;
      return { ok: true, queue: !on ? "off" : status === "blocked" ? "blocked" : "on" };
    } catch { return UNAVAILABLE; }
  }

  function executable(provider) {
    try {
      return provider === "claude"
        ? resolveClaudeExecutable(claudeDiscoveryEnvironment(sourceEnvironment), fileExists)
        : resolveCodexExecutable(sourceEnvironment, fileExists, { platform });
    } catch { return null; }
  }

  const turnOf = (repositoryId, conversationId) => (active && !active.reserved && active.repositoryId === repositoryId && active.conversationId === conversationId ? active : null);
  const waitingOf = (repositoryId, conversationId) => [...followUps.values()].find((entry) => entry.repositoryId === repositoryId && entry.conversationId === conversationId) ?? null;

  // The one turn is free again: the oldest follow-up that waits takes it.
  function release(holder) {
    holder?.closeTaskRead?.();
    if (active === holder) active = null;
    startFollowUp();
  }

  // After the owner applied or dismissed a proposal, Aril answers once more in that conversation, with the outcome and
  // a board read after it. The follow-up is a read-only run like any turn: it applies nothing, retries nothing, and its
  // next proposal waits for owner approval. Desktop main asks once per stored outcome, so no click, reconnect, or redraw of a
  // client can ask for a second one.
  function requestFollowUp(repositoryId, conversation, proposalId) {
    if (disposed) return;
    const key = `${repositoryId}/${proposalId}`;
    followUps.delete(key);
    followUps.set(key, { repositoryId, conversationId: conversation.id, proposalId, provider: conversation.provider, model: conversation.model, effort: conversation.effort ?? null, queuedAt: now().toISOString() });
    startFollowUp();
  }

  function startFollowUp() {
    if (active || disposed) return;
    const [key, next] = followUps.entries().next().value ?? [];
    if (!next) return;
    followUps.delete(key);
    const turn = {
      repositoryId: next.repositoryId, conversationId: next.conversationId, provider: next.provider, model: next.model, effort: next.effort, followUp: next.proposalId,
      startedAt: now().toISOString(), activity: "starting", text: "", stopped: false, stop: () => { turn.stopped = true; },
    };
    active = turn;
    void runFollowUp(turn);
  }

  async function lastCompletedAnswer(repositoryId) {
    const times = (await store.list(repositoryId)).flatMap((conversation) => conversation.messages)
      .filter((message) => message.role === "agent" && message.status === "complete" && message.grantFollowUp !== true).map((message) => Date.parse(message.at));
    return times.length > 0 ? Math.max(...times) : null;
  }

  async function runFollowUp(turn) {
    try {
      const conversation = await store.read(turn.repositoryId, turn.conversationId);
      const proposal = conversation?.messages.find((entry) => entry.role === "agent" && entry.proposal?.id === turn.followUp)?.proposal;
      // The conversation is gone or full, or the app is closing: nothing is asked and nothing is stored.
      if (!proposal || conversation.messages.length >= MESSAGE_LIMIT || disposed) return release(turn);
      // No provider, no board, or no repository root: the follow-up is stored as failed. The proposal keeps its outcome.
      const command = executable(turn.provider);
      if (!command) return await finishTurn(turn, null);
      const [board, root, runs] = await Promise.all([readBoard(turn.repositoryId), repositoryRoot(turn.repositoryId), readRuns()]);
      if (disposed) return release(turn);
      if (turn.stopped) return await finishTurn(turn, { status: "stopped", text: "" });
      if (!board || !root) return await finishTurn(turn, null);
      const held = conversationImages(conversation.messages);
      const shown = images && held.length > 0 ? await images.files(turn.repositoryId, conversation.id, held) : [];
      turn.followUpOutcome = proposalOutcome(proposal)?.outcome;
      const workflowChanges = await readWorkflowChanges(root, board.aril, { execFile });
      const instructionsFile = turn.provider === "claude" ? await prepareInstructionsFile(options.dataRoot) : null;
      const prompt = composePrompt({ includeInstructions: !instructionsFile, board, lastCompletedAt: await lastCompletedAnswer(turn.repositoryId), repositoryName: path.basename(root), runs, workflowChanges, messages: conversation.messages, followUp: proposal, images: shown, now: now() });
      if (!prompt) return await finishTurn(turn, null);
      if (disposed) return release(turn);
      if (turn.stopped) return await finishTurn(turn, { status: "stopped", text: "" });
      const sessionId = await declareRun(turn.provider);
      if (disposed || turn.stopped) {
        withdrawRun(sessionId);
        return disposed ? release(turn) : await finishTurn(turn, { status: "stopped", text: "" });
      }
      const taskServer = await taskReadServer(turn);
      if (disposed || turn.stopped) {
        withdrawRun(sessionId);
        return disposed ? release(turn) : await finishTurn(turn, { status: "stopped", text: "" });
      }
      const run = runTurn({ instructionsFile,
        spawn, executable: command, provider: turn.provider, model: turn.model, effort: turn.effort, mcpServer: taskServer, images: shown.length > 0 ? { folder: images.folder(turn.repositoryId, conversation.id), files: [] } : null, sessionId,
        cwd: root, env: userSessionEnvironment(sourceEnvironment), prompt, timeoutMs: options.turnTimeoutMs,
        onText: (value) => { turn.text = value; },
        onActivity: (value) => { turn.activity = value; },
      });
      turn.stop = () => { turn.stopped = true; turn.closeTaskRead?.(); run.stop(); };
      void run.done.finally(() => { turn.closeTaskRead?.(); withdrawRun(sessionId); }).then((outcome) => finishTurn(turn, outcome), () => finishTurn(turn, null));
    } catch { await finishTurn(turn, null); }
  }

  // A conversation that ends on the owner's message with no run behind it lost its answer (the app closed mid-turn).
  async function settled(repositoryId, conversation) {
    const last = conversation.messages.at(-1);
    if (!last || last.role !== "user" || (active && active.repositoryId === repositoryId && active.conversationId === conversation.id)) return conversation;
    const at = now().toISOString();
    const repaired = { ...conversation, updatedAt: at, messages: [...conversation.messages, {
      id: `m-${conversation.messages.length + 1}`, role: "agent", text: "", at, provider: conversation.provider, model: conversation.model, ...effortField(conversation.effort), status: "interrupted",
    }] };
    return await store.save(repositoryId, repaired) ? repaired : conversation;
  }

  async function finishTurn(turn, outcome) {
    const status = ["complete", "stopped", "timed_out"].includes(outcome?.status) ? outcome.status : "failed";
    if (status === "complete" && turn.logThrough > 0) {
      void postAction("log-ack", turn.repositoryId, { consumer: "aril", through: turn.logThrough }).catch(() => {});
    }
    const answer = typeof outcome?.text === "string" ? outcome.text : "";
    let read = status === "complete" ? extractProposal(answer, { grantWrite: Boolean(turn.grantPlans) }) : { text: visibleAnswer(answer), proposal: null, unreadable: false };
    try {
      const conversation = await store.read(turn.repositoryId, turn.conversationId);
      if (!conversation) return;
      // A proposal may name only images the owner sent in this conversation. One that names another is not offered.
      const sent = new Set(conversationImages(conversation.messages).map((image) => image.id));
      if (read.proposal && !proposalImages(read.proposal).every((id) => sent.has(id))) read = { text: read.text, proposal: null, unreadable: true };
      if (turn.grantPlans && read.proposal && !read.proposal.operations.every((operation, index) => (operation.after ?? [])
        .every((id) => id.startsWith("#") ? Number(id.slice(1)) <= index : turn.taskIds.has(id)))) {
        read = { text: read.text, proposal: null, unreadable: true };
      }
      read = await recordRework(read, (payload) => disposed || turn.stopped ? UNAVAILABLE : monitor("/internal/tasks/aril-declare-rework", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId: turn.repositoryId, ...payload }),
      }), ANSWER_LENGTH);
      const message = { id: `m-${conversation.messages.length + 1}`, role: "agent", text: read.text, at: now().toISOString(), provider: turn.provider, model: turn.model, ...effortField(turn.effort), status };
      // Only a successful or partial outcome may offer another board proposal. It still waits for the owner.
      if (turn.followUp) {
        message.followUp = turn.followUp;
        if (read.proposal && (!["applied", "partial"].includes(turn.followUpOutcome)
          || startProposalTask(read.proposal) || queueProposalState(read.proposal) !== null || read.proposal.operations.some(({ op }) => op === "remove_worktree" || ARIL_OPERATIONS.includes(op)))) {
          read = { text: read.text, proposal: null, unreadable: true };
        }
      }
      if (read.proposal) message.proposal = { id: newProposalId(), summary: read.proposal.summary, operations: read.proposal.operations, state: "pending" };
      if (turn.grantPlans && message.proposal) {
        let result = UNAVAILABLE;
        try {
          if (!disposed && !turn.stopped) result = await monitor("/internal/tasks/grant-write-tasks", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ repositoryId: turn.repositoryId, plan: turn.grantPlans[0],
              tasks: read.proposal.operations.map(({ text, completeWhen, after }) => ({ text, ...(completeWhen ? { completeWhen } : {}), ...(after ? { after } : {}) })) }),
          });
        } catch { /* Record a fixed refusal; no retry or follow-up. */ }
        const taskIds = result?.ok === true && Array.isArray(result.taskIds) && result.taskIds.length === read.proposal.operations.length
          && result.taskIds.every((id) => typeof id === "string" && TASK_ID.test(id)) ? result.taskIds : null;
        const error = ["not_active", "not_allowed"].includes(result?.error) ? "conflict"
          : ["limit", "invalid"].includes(result?.error) ? result.error : "unavailable";
        message.proposal = { ...message.proposal, state: "applied", appliedBy: "grant", summary: "Applied by grant.",
          results: read.proposal.operations.map((_, index) => taskIds ? { ok: true, taskId: taskIds[index] } : { ok: false, error }) };
      }
      if (read.unreadable) message.proposalUnreadable = true;
      return await store.save(turn.repositoryId, { ...conversation, updatedAt: message.at, messages: [...conversation.messages, message] });
    } catch { /* The conversation keeps the owner's message; the next read marks the answer as interrupted. */ }
    finally { release(turn); }
  }

  async function send(payload) {
    const withImages = isPlainObject(payload) && Object.hasOwn(payload, "images");
    // `effort` is optional: a client that names none reads as null, as a record without one does.
    const withEffort = isPlainObject(payload) && Object.hasOwn(payload, "effort");
    if (!exactly(payload, ["repositoryId", "conversationId", "text", "provider", "model", ...(withEffort ? ["effort"] : []), ...(withImages ? ["images"] : [])])) return INVALID;
    const { repositoryId, conversationId, provider, model } = payload;
    const effort = withEffort ? payload.effort : null;
    const imageIds = withImages ? chatImageIds(payload.images) : [];
    if (imageIds === null) return INVALID;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!REPOSITORY_ID.test(String(repositoryId)) || !(conversationId === null || (typeof conversationId === "string" && CONVERSATION_ID.test(conversationId)))
      || !text || text.length > MESSAGE_LENGTH || !MESSAGE_TEXT.test(text) || !PROVIDERS.has(provider)
      || !(model === null || (typeof model === "string" && MODEL.test(model)))
      || !(effort === null || (typeof effort === "string" && EFFORTS.has(effort)))) return INVALID;
    if (active) return refused("busy");
    const reservation = { reserved: true, repositoryId, conversationId };
    active = reservation;
    let started = false;
    let turn = null;
    let sessionId = null;
    try {
      const command = executable(provider);
      if (!command) return refused("cli_missing");
      const existing = conversationId === null ? null : await store.read(repositoryId, conversationId);
      if (conversationId !== null && !existing) return refused("not_found");
      if (existing && existing.messages.length > MESSAGE_LIMIT - 2) return refused("limit");
      const held = conversationImages(existing?.messages);
      if (imageIds.length > 0 && !images) return UNAVAILABLE;
      if (held.length + imageIds.length > CHAT_IMAGES_PER_CONVERSATION) return refused("limit");
      const [board, root, runs, taskLog] = await Promise.all([readBoard(repositoryId), repositoryRoot(repositoryId), readRuns(), readTaskLog(repositoryId)]);
      if (!board || !root || disposed) return UNAVAILABLE;
      let github;
      if (repositoryGithub) {
        try { github = await repositoryGithub.read(repositoryId, root); } catch { github = null; }
        if (disposed) return UNAVAILABLE;
      }
      const conversation = existing ?? await store.create(repositoryId, { provider, model, effort, title: conversationTitle(text) });
      if (!conversation) return refused("limit");
      // A conversation that was made for this message is not kept when the message is refused.
      const abandoned = async (answer) => {
        if (!existing) { await store.remove(repositoryId, conversation.id); await images?.removeConversation(repositoryId, conversation.id); }
        return answer;
      };
      // The images wait in the staged folder since the owner added them; the message that names them takes them.
      const attached = imageIds.length > 0 ? await images.claim(repositoryId, conversation.id, imageIds) : [];
      if (!attached) return abandoned(INVALID);
      const shown = images && held.length + attached.length > 0 ? await images.files(repositoryId, conversation.id, [...held, ...attached]) : [];
      const workflowChanges = await readWorkflowChanges(root, board.aril, { execFile });
      const inventory = await readWorktrees(repositoryId, root, board);
      const instructionsFile = provider === "claude" ? await prepareInstructionsFile(options.dataRoot) : null;
      const prompt = composePrompt({ includeInstructions: !instructionsFile, board, lastCompletedAt: await lastCompletedAnswer(repositoryId), repositoryName: path.basename(root), runs, taskLog, workflowChanges, worktrees: inventory, messages: existing?.messages ?? [], message: text, images: shown, attached, repositoryGithub: github, now: now() });
      if (!prompt) return abandoned(INVALID);
      const at = now().toISOString();
      const message = { id: `m-${conversation.messages.length + 1}`, role: "user", text, at, ...(attached.length > 0 ? { images: attached } : {}) };
      const next = { ...conversation, provider, model, effort, updatedAt: at, messages: [...conversation.messages, message] };
      if (!await store.save(repositoryId, next)) return abandoned(UNAVAILABLE);
      // The run may read the folder of this conversation's images, and nothing else outside the repository.
      const newest = new Set(attached.map((image) => image.id));
      const runImages = shown.length > 0 ? { folder: images.folder(repositoryId, conversation.id), files: shown.filter((image) => newest.has(image.id)).map((image) => image.file) } : null;
      sessionId = await declareRun(provider);
      if (disposed) { withdrawRun(sessionId); return UNAVAILABLE; }
      turn = { repositoryId, conversationId: conversation.id, provider, model, effort, startedAt: at, activity: "starting", text: "", stopped: false,
        logThrough: Math.max(0, ...(taskLog?.entries ?? []).map((entry) => entry.id)),
        stop: () => { turn.stopped = true; turn.closeTaskRead?.(); } };
      active = turn;
      started = true;
      const taskServer = await taskReadServer(turn);
      if (disposed || turn.stopped) {
        withdrawRun(sessionId);
        await finishTurn(turn, { status: "stopped", text: "" });
        return UNAVAILABLE;
      }
      const run = runTurn({ instructionsFile,
        spawn, executable: command, provider, model, effort, mcpServer: taskServer, images: runImages, sessionId, cwd: root, env: userSessionEnvironment(sourceEnvironment), prompt, timeoutMs: options.turnTimeoutMs,
        onText: (value) => { turn.text = value; },
        onActivity: (value) => { turn.activity = value; },
      });
      turn.stop = () => { turn.stopped = true; turn.closeTaskRead?.(); run.stop(); };
      void run.done.finally(() => { turn.closeTaskRead?.(); withdrawRun(sessionId); }).then((outcome) => finishTurn(turn, outcome), () => finishTurn(turn, null));
      return { ok: true, conversationId: conversation.id };
    } catch {
      return UNAVAILABLE;
    } finally {
      if (!started) release(reservation);
    }
  }

  // Internal grant action only. Its promise holds the runner's slot until the answer and outcome are stored.
  async function grantWrite({ repositoryId, plans }) {
    if (active) return refused("busy");
    if (disposed || !store || !monitorOrigin || !authorizationToken) return UNAVAILABLE;
    if (!REPOSITORY_ID.test(String(repositoryId)) || !Array.isArray(plans) || plans.length === 0 || plans.length > 20
      || !plans.every((plan) => typeof plan === "string" && plan.length <= 200 && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/u.test(plan)
        && !plan.split("/").some((part) => part === "." || part === ".."))) return INVALID;
    const reservation = { reserved: true, repositoryId };
    active = reservation;
    let turn = null;
    let sessionId = null;
    try {
      const [board, root, runs, taskLog] = await Promise.all([readBoard(repositoryId), repositoryRoot(repositoryId), readRuns(), readTaskLog(repositoryId)]);
      if (!board || !root || disposed) return UNAVAILABLE;
      const provider = board.aril?.settings?.reviewer?.provider ?? (executable("claude") ? "claude" : "codex");
      const command = PROVIDERS.has(provider) ? executable(provider) : null;
      if (!command) return refused("cli_missing");
      const workflowChanges = await readWorkflowChanges(root, board.aril, { execFile });
      const inventory = await readWorktrees(repositoryId, root, board);
      const instructionsFile = provider === "claude" ? await prepareInstructionsFile(options.dataRoot) : null;
      const prompt = composePrompt({ includeInstructions: !instructionsFile, board, lastCompletedAt: await lastCompletedAnswer(repositoryId), repositoryName: path.basename(root), runs, taskLog, workflowChanges, worktrees: inventory, grantPlans: plans, now: now() });
      if (!prompt) return INVALID;
      const conversation = await store.create(repositoryId, { provider, model: null, title: conversationTitle(`Grant: tasks from ${path.posix.basename(plans[0])}`) });
      if (!conversation) return refused("limit");
      if (!await store.save(repositoryId, conversation)) { await store.remove(repositoryId, conversation.id); return UNAVAILABLE; }
      turn = { repositoryId, conversationId: conversation.id, provider, model: null, startedAt: now().toISOString(), activity: "starting", text: "", stopped: false,
        grantPlans: [...plans], taskIds: new Set(board.tasks.map(({ id }) => id)),
        logThrough: Math.max(0, ...(taskLog?.entries ?? []).map((entry) => entry.id)),
        stop: () => { turn.stopped = true; turn.closeTaskRead?.(); } };
      active = turn;
      sessionId = await declareRun(provider);
      const taskServer = await taskReadServer(turn);
      if (disposed || turn.stopped) { await finishTurn(turn, { status: "stopped", text: "" }); return UNAVAILABLE; }
      const run = runTurn({ instructionsFile, spawn, executable: command, provider, model: null, mcpServer: taskServer, images: null, sessionId,
        cwd: root, env: userSessionEnvironment(sourceEnvironment), prompt, timeoutMs: options.turnTimeoutMs,
        onText: (value) => { turn.text = value; }, onActivity: (value) => { turn.activity = value; } });
      turn.stop = () => { turn.stopped = true; turn.closeTaskRead?.(); run.stop(); };
      return await finishTurn(turn, await run.done) ? { ok: true, conversationId: conversation.id } : UNAVAILABLE;
    } catch {
      if (turn) await finishTurn(turn, null);
      return UNAVAILABLE;
    } finally {
      withdrawRun(sessionId);
      release(turn ?? reservation);
    }
  }

  // Internal grant action only: a fixed follow-up line in the grant's own conversation, asked again while it is answering.
  const grantFollowUp = createGrantFollowUps({ store, now, provider: () => (executable("claude") || !executable("codex") ? "claude" : "codex"),
    busy: (repositoryId, id) => Boolean(turnOf(repositoryId, id) || waitingOf(repositoryId, id) || (active?.reserved && active.repositoryId === repositoryId)) });

  async function list(payload) {
    if (!exactly(payload, ["repositoryId"]) || !REPOSITORY_ID.test(String(payload.repositoryId))) return INVALID;
    const conversations = await store.list(payload.repositoryId);
    const running = active && !active.reserved && active.repositoryId === payload.repositoryId ? active.conversationId : null;
    return { ok: true, conversations: conversations.map(summary), running };
  }

  async function located(payload, keys) {
    if (!exactly(payload, keys) || !REPOSITORY_ID.test(String(payload.repositoryId)) || typeof payload.conversationId !== "string" || !CONVERSATION_ID.test(payload.conversationId)) return null;
    return { conversation: await store.read(payload.repositoryId, payload.conversationId) };
  }

  async function read(payload) {
    const found = await located(payload, ["repositoryId", "conversationId"]);
    if (!found) return INVALID;
    if (!found.conversation) return refused("not_found");
    const conversation = await settled(payload.repositoryId, found.conversation);
    // A follow-up that waits behind another turn reads as a turn that is starting, so the client keeps reading.
    const waiting = waitingOf(payload.repositoryId, conversation.id);
    const turn = turnOf(payload.repositoryId, conversation.id) ?? (waiting ? { conversationId: conversation.id, startedAt: waiting.queuedAt, provider: waiting.provider, model: waiting.model, ...effortField(waiting.effort), activity: "starting", text: "" } : null);
    return {
      ok: true, conversation: Object.fromEntries(Object.entries(conversation).filter(([key]) => key !== "grantFollowUps")),
      turn: turn ? { conversationId: turn.conversationId, startedAt: turn.startedAt, provider: turn.provider, model: turn.model, ...effortField(turn.effort), activity: turn.activity, text: visibleAnswer(turn.text) } : null,
    };
  }

  async function stop(payload) {
    const found = await located(payload, ["repositoryId", "conversationId"]);
    if (!found) return INVALID;
    const turn = turnOf(payload.repositoryId, payload.conversationId);
    if (turn) { turn.stop(); return { ok: true }; }
    // Stop also takes back the follow-ups of this conversation that have not started.
    const waiting = [...followUps].filter(([, entry]) => entry.repositoryId === payload.repositoryId && entry.conversationId === payload.conversationId);
    if (waiting.length === 0) return refused("not_found");
    for (const [key] of waiting) followUps.delete(key);
    return { ok: true };
  }

  async function remove(payload) {
    const found = await located(payload, ["repositoryId", "conversationId"]);
    if (!found) return INVALID;
    if (!found.conversation) return refused("not_found");
    if (active && active.repositoryId === payload.repositoryId && active.conversationId === payload.conversationId) return refused("busy");
    if (!await store.remove(payload.repositoryId, payload.conversationId)) return UNAVAILABLE;
    for (const [key, entry] of [...followUps]) if (entry.repositoryId === payload.repositoryId && entry.conversationId === payload.conversationId) followUps.delete(key);
    await images?.removeConversation(payload.repositoryId, payload.conversationId);
    return { ok: true };
  }

  // The owner adds an image to a message that is not sent yet. Only its ID, type, and size go back.
  async function addImage(payload) {
    if (!exactly(payload, ["repositoryId", "bytes"]) || !REPOSITORY_ID.test(String(payload.repositoryId))) return INVALID;
    const { bytes } = payload;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > CHAT_IMAGE_MAX_BYTES) return INVALID;
    const image = await images.stage(payload.repositoryId, bytes);
    return image ? { ok: true, image } : INVALID;
  }

  // The bytes of one image, only when a message of that conversation names it.
  async function readImage(payload) {
    const found = await located(payload, ["repositoryId", "conversationId", "imageId"]);
    if (!found || typeof payload.imageId !== "string" || !CHAT_IMAGE_ID.test(payload.imageId)) return INVALID;
    const image = conversationImages(found.conversation?.messages).find((candidate) => candidate.id === payload.imageId);
    if (!image) return refused("not_found");
    const bytes = await images.read(payload.repositoryId, payload.conversationId, image);
    return bytes ? { ok: true, type: image.type, bytes } : refused("not_found");
  }

  // An approved start goes to the manual start of the Tasks page and to nothing else: the same start plan, gates, and
  // launch slot and native confirmation. Only a confirmed launch answers
  // the proposal; a start that was held or failed keeps it pending with the fixed status, so the owner may apply it
  // again. Null when the start was cancelled (the app is closing), which stores nothing.
  async function startSession(event, repositoryId, taskId, proposal) {
    let status;
    try { status = (await startTask(event, repositoryId, taskId))?.status; } catch { status = "failed"; }
    if (status === "cancelled") return null;
    if (status === "started") return { ...proposal, state: "applied", results: [{ ok: true, start: "started" }] };
    return { ...proposal, state: "pending", results: [{ ok: false, error: "not_started", start: START_FAILURES.includes(status) ? status : "unavailable" }] };
  }

  async function removeWorktree(repositoryId, operation) {
    try {
      const board = await readBoard(repositoryId);
      if (!board) return "failed";
      const task = board.tasks.find(({ id }) => id === operation.id);
      if (task?.review?.state === "running") return "in_use";
      // A task with no outcome yet may have a session or a live dispatch.
      if (task && !["needs_review", "stalled", "blocked", "done"].includes(task.state)) {
        if (task.session) return "in_use";
        // The board omits dispatch tokens. Its existing private task read also checks an unbound live dispatch.
        const read = await monitor(`/internal/agent-chat/task?${new URLSearchParams({ repositoryId, taskId: task.id })}`, { method: "GET" });
        if (read?.ok !== true || typeof read.task?.editable !== "boolean") return "failed";
        if (!read.task.editable) return "in_use";
      }
      const root = await repositoryRoot(repositoryId);
      if (!root) return "failed";
      const request = { repositoryRoot: root, repositoryId, taskId: operation.id };
      if (!await worktrees.locate(request)) return "not_found";
      const result = await worktrees.remove({ ...request, deleteBranch: operation.branch, detailed: true });
      return WORKTREE_RESULTS.includes(result) ? result : "failed";
    } catch { return "failed"; }
  }

  // Apply and Dismiss are the owner's answer to one proposal; each proposal takes one answer.
  async function resolve(payload, approve, origin) {
    const found = await located(payload, ["repositoryId", "conversationId", "proposalId"]);
    if (!found || typeof payload.proposalId !== "string" || !PROPOSAL_ID.test(payload.proposalId)) return INVALID;
    const { repositoryId, proposalId } = payload;
    const message = found.conversation?.messages.find((entry) => entry.role === "agent" && entry.proposal?.id === proposalId);
    if (!message) return refused("not_found");
    if (message.proposal.state !== "pending") return refused("conflict");
    const startTaskId = approve ? startProposalTask(message.proposal) : null;
    const removeWorktrees = approve && message.proposal.operations.every(({ op }) => op === "remove_worktree");
    // Only the desktop window starts a session from the chat: the start needs its trusted event, and a paired device has none.
    if ((startTaskId || removeWorktrees) && !origin?.event) return refused("desktop_only");
    if (startTaskId && !startTask) return UNAVAILABLE;
    const queueOn = approve ? queueProposalState(message.proposal) : null;
    const key = `${repositoryId}/${proposalId}`;
    if (applying.has(key)) return refused("busy");
    applying.add(key);
    try {
      let proposal = { ...message.proposal, state: "dismissed" };
      if (startTaskId) {
        proposal = await startSession(origin.event, repositoryId, startTaskId, message.proposal);
        if (!proposal) return { ok: true };
      } else if (queueOn !== null) {
        // Only a change the monitor accepted answers the proposal. One it refused, or that never reached it, keeps the
        // proposal pending with the fixed error, so the owner may apply the same desired state again.
        const result = await setQueue(repositoryId, queueOn);
        proposal = { ...message.proposal, state: result.ok ? "applied" : "pending", results: [{ ...result }] };
      } else if (removeWorktrees) {
        const results = [];
        for (const operation of message.proposal.operations) {
          const worktree = await removeWorktree(repositoryId, operation);
          results.push({ ok: worktree === "removed", worktree, ...(worktree === "removed" ? {} : { error: worktree }) });
        }
        proposal = { ...message.proposal, state: results.every(({ ok }) => ok) ? "applied" : "partial", results };
      } else if (approve) {
        const board = await readBoard(repositoryId);
        if (!board) return UNAVAILABLE;
        // Only the trusted window edits a feature, and applies Aril settings or memory freely; those need the paired-device switch.
        if (!origin?.event && message.proposal.operations.some(({ op }) => FEATURE_EDIT_OPERATIONS.includes(op)
          || (ARIL_OPERATIONS.includes(op) && board.aril?.settings?.pairedDevices !== true))) return refused("desktop_only");
        const results = await applyOperations(message.proposal.operations, {
          board, post: (action, body) => taskAction(repositoryId, action, body),
          attach: (taskId, imageId) => attachImage(repositoryId, found.conversation, taskId, imageId),
        });
        proposal = { ...message.proposal, state: results.every((result) => result.ok === true) ? "applied" : "partial", results };
      }
      // The turn may have added a message meanwhile, so the newest stored conversation takes the outcome.
      const latest = await store.read(repositoryId, payload.conversationId);
      if (!latest) return refused("not_found");
      const saved = await store.save(repositoryId, { ...latest, updatedAt: now().toISOString(), messages: latest.messages.map((entry) => (entry.id === message.id ? { ...entry, proposal } : entry)) });
      if (!saved) return UNAVAILABLE;
      // The outcome is stored; only then is Aril asked to answer it. A follow-up that cannot run changes none of it.
      requestFollowUp(repositoryId, latest, proposalId);
      return { ok: true };
    } finally {
      applying.delete(key);
    }
  }

  const handlers = { list, read, send, stop, delete: remove, apply: (payload, origin) => resolve(payload, true, origin), dismiss: (payload) => resolve(payload, false) };

  /**
   * One operation for the owner: from the desktop window, or from a paired device through the LAN gateway. `origin`
   * is `{ event }` for the trusted desktop window and `{ paired: true }` for the LAN gateway; only the window starts sessions.
   */
  async function handle(operation, payload, origin) {
    if (typeof operation !== "string" || !Object.hasOwn(handlers, operation) || !isPlainObject(payload)) return INVALID;
    try {
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > AGENT_CHAT_REQUEST_MAX_BYTES) return INVALID;
    } catch { return INVALID; }
    if (disposed || !store || !monitorOrigin || !authorizationToken) return UNAVAILABLE;
    try { return await handlers[operation](payload, origin); } catch { return UNAVAILABLE; }
  }

  const imageHandlers = { add: addImage, read: readImage };

  /** One image operation for the owner, from the desktop window or a paired device: `add` takes bytes, `read` answers them. */
  async function image(operation, payload) {
    if (typeof operation !== "string" || !Object.hasOwn(imageHandlers, operation) || !isPlainObject(payload)) return INVALID;
    if (disposed || !store || !images) return UNAVAILABLE;
    try { return await imageHandlers[operation](payload); } catch { return UNAVAILABLE; }
  }

  return Object.freeze({
    handle,
    image,
    grantWrite,
    grantFollowUp: (request) => (disposed ? Promise.resolve(UNAVAILABLE) : grantFollowUp(request)),
    /** Ends Pomegr's own running turn; no session the owner started is touched. */
    dispose() { disposed = true; followUps.clear(); try { active?.stop?.(); } catch { /* already gone */ } },
  });
}

export function installAgentChatIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Agent chat requires ipcMain");
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const chat = options.chat || createAgentChat(options);
  ipcMain.removeHandler(AGENT_CHAT_CHANNEL);
  ipcMain.handle(AGENT_CHAT_CHANNEL, async (event, operation, payload) => {
    if (!isTrustedEvent(event)) return INVALID;
    try { return await chat.handle(operation, payload, { event }); } catch { return UNAVAILABLE; }
  });
  ipcMain.removeHandler(AGENT_CHAT_IMAGE_CHANNEL);
  ipcMain.handle(AGENT_CHAT_IMAGE_CHANNEL, async (event, operation, payload) => {
    if (!isTrustedEvent(event)) return INVALID;
    try { return await chat.image?.(operation, payload) ?? UNAVAILABLE; } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(AGENT_CHAT_CHANNEL); ipcMain.removeHandler(AGENT_CHAT_IMAGE_CHANNEL); chat.dispose?.(); };
}
