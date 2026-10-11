// The Pomegr agent chat: the owner talks to Aril, an agent that reads the task board and proposes changes to it.
// Desktop main owns the whole of it. It starts one read-only provider run per message, keeps the conversations,
// and changes the board only when the owner approves a proposal, through the fixed task actions.

import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { composePrompt } from "./agent-chat-prompt.mjs";
import { applyOperations, extractProposal, visibleAnswer } from "./agent-chat-proposal.mjs";
import { runChatTurn } from "./agent-chat-runner.mjs";
import { AGENT_CHAT_DIRECTORY, conversationTitle, createAgentChatStore, MESSAGE_LENGTH, MESSAGE_LIMIT, newProposalId } from "./agent-chat-store.mjs";
import { claudeDiscoveryEnvironment, resolveClaudeExecutable } from "./claude-auth.mjs";
import { userSessionEnvironment } from "./environment-policy.mjs";
import { resolveCodexExecutable } from "./plugin-cli.mjs";

export const AGENT_CHAT_CHANNEL = "pomegr:agent-chat";
export const AGENT_CHAT_OPERATIONS = Object.freeze(["list", "read", "send", "stop", "apply", "dismiss", "delete"]);
export const AGENT_CHAT_ERRORS = Object.freeze(["invalid", "not_found", "busy", "limit", "cli_missing", "conflict", "unavailable"]);
export const AGENT_CHAT_REQUEST_MAX_BYTES = 17 * 1024;

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
const PROPOSAL_ID = /^p-[0-9a-f]{12}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const MESSAGE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const TASK_ACTIONS = new Set(["create", "update", "delete", "move", "feature_create", "queue_add", "queue_remove", "queue_reorder"]);
const MONITOR_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported"]);
const MONITOR_TIMEOUT_MS = 10_000;

const MCP_WORKER = ["desktop", "workers", "agent-chat-mcp.cjs"];

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
  const now = options.now || (() => new Date());
  const runTurn = options.runTurn || runChatTurn;
  const mcpServer = options.mcpServer === undefined ? agentChatMcpServer({ executable: options.executable, unpackedRoot: options.unpackedRoot, fileExists }) : options.mcpServer;
  const store = options.store || (typeof options.dataRoot === "string" && path.isAbsolute(options.dataRoot)
    ? createAgentChatStore({ directory: path.join(options.dataRoot, AGENT_CHAT_DIRECTORY), now }) : null);
  let disposed = false;
  // One turn at a time for the whole app: `{ repositoryId, conversationId, ... }` from the moment a send is accepted.
  let active = null;
  const applying = new Set();

  async function monitor(pathname, init) {
    const response = await fetchImpl(`${monitorOrigin}${pathname}`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? MONITOR_TIMEOUT_MS),
      ...init, headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, ...init?.headers },
    });
    return response.json();
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

  async function repositoryRoot(repositoryId) {
    try {
      const answer = await postAction("worktree-root", repositoryId, {});
      const root = isPlainObject(answer) && answer.ok === true ? answer.root : null;
      return typeof root === "string" && path.isAbsolute(root) && !/[\u0000\r\n"]/u.test(root) ? root : null;
    } catch { return null; }
  }

  // The applier's one way to the board: the fixed task actions, validated by the monitor like any desktop action.
  async function taskAction(repositoryId, action, payload) {
    if (!TASK_ACTIONS.has(action)) return refused("invalid");
    try {
      const answer = await postAction(action, repositoryId, payload);
      if (isPlainObject(answer) && answer.ok === true) {
        return { ok: true, board: isPlainObject(answer.board) ? answer.board : null, taskId: typeof answer.taskId === "string" && TASK_ID.test(answer.taskId) ? answer.taskId : null };
      }
      return refused(isPlainObject(answer) && typeof answer.error === "string" && MONITOR_ERRORS.has(answer.error) ? answer.error : "unavailable");
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

  // A conversation that ends on the owner's message with no run behind it lost its answer (the app closed mid-turn).
  async function settled(repositoryId, conversation) {
    const last = conversation.messages.at(-1);
    if (!last || last.role !== "user" || (active && active.repositoryId === repositoryId && active.conversationId === conversation.id)) return conversation;
    const at = now().toISOString();
    const repaired = { ...conversation, updatedAt: at, messages: [...conversation.messages, {
      id: `m-${conversation.messages.length + 1}`, role: "agent", text: "", at, provider: conversation.provider, model: conversation.model, status: "interrupted",
    }] };
    return await store.save(repositoryId, repaired) ? repaired : conversation;
  }

  async function finishTurn(turn, outcome) {
    const status = ["complete", "stopped", "timed_out"].includes(outcome?.status) ? outcome.status : "failed";
    const answer = typeof outcome?.text === "string" ? outcome.text : "";
    const read = status === "complete" ? extractProposal(answer) : { text: visibleAnswer(answer), proposal: null, unreadable: false };
    try {
      const conversation = await store.read(turn.repositoryId, turn.conversationId);
      if (!conversation) return;
      const at = now().toISOString();
      const message = { id: `m-${conversation.messages.length + 1}`, role: "agent", text: read.text, at, provider: turn.provider, model: turn.model, status };
      if (read.proposal) message.proposal = { id: newProposalId(), summary: read.proposal.summary, operations: read.proposal.operations, state: "pending" };
      if (read.unreadable) message.proposalUnreadable = true;
      await store.save(turn.repositoryId, { ...conversation, updatedAt: at, messages: [...conversation.messages, message] });
    } catch { /* The conversation keeps the owner's message; the next read marks the answer as interrupted. */ }
    finally { if (active === turn) active = null; }
  }

  async function send(payload) {
    if (!exactly(payload, ["repositoryId", "conversationId", "text", "provider", "model"])) return INVALID;
    const { repositoryId, conversationId, provider, model } = payload;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!REPOSITORY_ID.test(String(repositoryId)) || !(conversationId === null || (typeof conversationId === "string" && CONVERSATION_ID.test(conversationId)))
      || !text || text.length > MESSAGE_LENGTH || !MESSAGE_TEXT.test(text) || !PROVIDERS.has(provider)
      || !(model === null || (typeof model === "string" && MODEL.test(model)))) return INVALID;
    if (active) return refused("busy");
    const reservation = { reserved: true, repositoryId, conversationId };
    active = reservation;
    let started = false;
    try {
      const command = executable(provider);
      if (!command) return refused("cli_missing");
      const existing = conversationId === null ? null : await store.read(repositoryId, conversationId);
      if (conversationId !== null && !existing) return refused("not_found");
      if (existing && existing.messages.length > MESSAGE_LIMIT - 2) return refused("limit");
      const [board, root] = await Promise.all([readBoard(repositoryId), repositoryRoot(repositoryId)]);
      if (!board || !root || disposed) return UNAVAILABLE;
      const prompt = composePrompt({ board, repositoryName: path.basename(root), messages: existing?.messages ?? [], message: text, now: now() });
      if (!prompt) return INVALID;
      const conversation = existing ?? await store.create(repositoryId, { provider, model, title: conversationTitle(text) });
      if (!conversation) return refused("limit");
      const at = now().toISOString();
      const next = { ...conversation, provider, model, updatedAt: at, messages: [...conversation.messages, { id: `m-${conversation.messages.length + 1}`, role: "user", text, at }] };
      if (!await store.save(repositoryId, next)) {
        if (!existing) await store.remove(repositoryId, conversation.id);
        return UNAVAILABLE;
      }
      const turn = { repositoryId, conversationId: conversation.id, provider, model, startedAt: at, activity: "starting", text: "", stop: () => {} };
      active = turn;
      started = true;
      const run = runTurn({
        spawn, executable: command, provider, model, mcpServer, cwd: root, env: userSessionEnvironment(sourceEnvironment), prompt, timeoutMs: options.turnTimeoutMs,
        onText: (value) => { turn.text = value; },
        onActivity: (value) => { turn.activity = value; },
      });
      turn.stop = run.stop;
      void run.done.then((outcome) => finishTurn(turn, outcome), () => finishTurn(turn, null));
      return { ok: true, conversationId: conversation.id };
    } catch {
      return UNAVAILABLE;
    } finally {
      if (!started && active === reservation) active = null;
    }
  }

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
    const turn = turnOf(payload.repositoryId, conversation.id);
    return {
      ok: true, conversation,
      turn: turn ? { conversationId: turn.conversationId, startedAt: turn.startedAt, provider: turn.provider, model: turn.model, activity: turn.activity, text: visibleAnswer(turn.text) } : null,
    };
  }

  async function stop(payload) {
    const found = await located(payload, ["repositoryId", "conversationId"]);
    if (!found) return INVALID;
    const turn = turnOf(payload.repositoryId, payload.conversationId);
    if (!turn) return refused("not_found");
    turn.stop();
    return { ok: true };
  }

  async function remove(payload) {
    const found = await located(payload, ["repositoryId", "conversationId"]);
    if (!found) return INVALID;
    if (!found.conversation) return refused("not_found");
    if (active && active.repositoryId === payload.repositoryId && active.conversationId === payload.conversationId) return refused("busy");
    return await store.remove(payload.repositoryId, payload.conversationId) ? { ok: true } : UNAVAILABLE;
  }

  // Apply and Dismiss are the owner's answer to one proposal; each proposal takes one answer.
  async function resolve(payload, approve) {
    const found = await located(payload, ["repositoryId", "conversationId", "proposalId"]);
    if (!found || typeof payload.proposalId !== "string" || !PROPOSAL_ID.test(payload.proposalId)) return INVALID;
    const { repositoryId, proposalId } = payload;
    const message = found.conversation?.messages.find((entry) => entry.role === "agent" && entry.proposal?.id === proposalId);
    if (!message) return refused("not_found");
    if (message.proposal.state !== "pending") return refused("conflict");
    const key = `${repositoryId}/${proposalId}`;
    if (applying.has(key)) return refused("busy");
    applying.add(key);
    try {
      let proposal = { ...message.proposal, state: "dismissed" };
      if (approve) {
        const board = await readBoard(repositoryId);
        if (!board) return UNAVAILABLE;
        const results = await applyOperations(message.proposal.operations, { board, post: (action, body) => taskAction(repositoryId, action, body) });
        proposal = { ...message.proposal, state: results.every((result) => result.ok === true) ? "applied" : "partial", results };
      }
      // The turn may have added a message meanwhile, so the newest stored conversation takes the outcome.
      const latest = await store.read(repositoryId, payload.conversationId);
      if (!latest) return refused("not_found");
      const saved = await store.save(repositoryId, { ...latest, updatedAt: now().toISOString(), messages: latest.messages.map((entry) => (entry.id === message.id ? { ...entry, proposal } : entry)) });
      return saved ? { ok: true } : UNAVAILABLE;
    } finally {
      applying.delete(key);
    }
  }

  const handlers = { list, read, send, stop, delete: remove, apply: (payload) => resolve(payload, true), dismiss: (payload) => resolve(payload, false) };

  /** One operation for the owner: from the desktop window, or from a paired device through the LAN gateway. */
  async function handle(operation, payload) {
    if (typeof operation !== "string" || !Object.hasOwn(handlers, operation) || !isPlainObject(payload)) return INVALID;
    try {
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > AGENT_CHAT_REQUEST_MAX_BYTES) return INVALID;
    } catch { return INVALID; }
    if (disposed || !store || !monitorOrigin || !authorizationToken) return UNAVAILABLE;
    try { return await handlers[operation](payload); } catch { return UNAVAILABLE; }
  }

  return Object.freeze({
    handle,
    /** Ends Pomegr's own running turn; no session the owner started is touched. */
    dispose() { disposed = true; try { active?.stop?.(); } catch { /* already gone */ } },
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
    try { return await chat.handle(operation, payload); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(AGENT_CHAT_CHANNEL); chat.dispose?.(); };
}
