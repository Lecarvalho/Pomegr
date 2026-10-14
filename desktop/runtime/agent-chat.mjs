// The Pomegr agent chat: the owner talks to Aril, an agent that reads the task board and proposes changes to it.
// Desktop main owns the whole of it. It starts one read-only provider run per message, keeps the conversations,
// and changes the board only when the owner approves a proposal, through the fixed task actions.

import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { CHAT_IMAGE_ID, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGES_PER_CONVERSATION, conversationImages, createAgentChatImages } from "./agent-chat-images.mjs";
import { composePrompt } from "./agent-chat-prompt.mjs";
import { applyOperations, chatImageIds, extractProposal, proposalImages, queueProposalState, START_FAILURES, startProposalTask, visibleAnswer } from "./agent-chat-proposal.mjs";
import { runChatTurn } from "./agent-chat-runner.mjs";
import { AGENT_CHAT_DIRECTORY, conversationTitle, createAgentChatStore, MESSAGE_LENGTH, MESSAGE_LIMIT, newProposalId } from "./agent-chat-store.mjs";
import { claudeDiscoveryEnvironment, resolveClaudeExecutable } from "./claude-auth.mjs";
import { userSessionEnvironment } from "./environment-policy.mjs";
import { resolveCodexExecutable } from "./plugin-cli.mjs";

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
const TASK_ACTIONS = new Set(["create", "update", "delete", "move", "feature_create", "queue_add", "queue_remove", "queue_group", "queue_ungroup", "after_set"]);
// The canonical queue control of the Tasks page. The chat sends it only for an approved queue proposal, with the one setting `on`.
const QUEUE_ACTION = "queue_settings";
const MONITOR_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported"]);
const MONITOR_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 20_000;

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
  // The desktop's manual start for a start the owner approved in the chat: `(event, repositoryId, taskId)` answers `{ status }`.
  const startTask = typeof options.startTask === "function" ? options.startTask : null;
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
    if (active === holder) active = null;
    startFollowUp();
  }

  // After the owner applied or dismissed a proposal, Aril answers once more in that conversation, with the outcome and
  // a board read after it. The follow-up is a read-only run like any turn: it applies nothing, retries nothing, and its
  // answer carries no proposal. Desktop main asks for it once per stored outcome, so no click, reconnect, or redraw of a
  // client can ask for a second one.
  function requestFollowUp(repositoryId, conversation, proposalId) {
    if (disposed) return;
    const key = `${repositoryId}/${proposalId}`;
    followUps.delete(key);
    followUps.set(key, { repositoryId, conversationId: conversation.id, proposalId, provider: conversation.provider, model: conversation.model, queuedAt: now().toISOString() });
    startFollowUp();
  }

  function startFollowUp() {
    if (active || disposed) return;
    const [key, next] = followUps.entries().next().value ?? [];
    if (!next) return;
    followUps.delete(key);
    const turn = {
      repositoryId: next.repositoryId, conversationId: next.conversationId, provider: next.provider, model: next.model, followUp: next.proposalId,
      startedAt: now().toISOString(), activity: "starting", text: "", stopped: false, stop: () => { turn.stopped = true; },
    };
    active = turn;
    void runFollowUp(turn);
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
      const [board, root] = await Promise.all([readBoard(turn.repositoryId), repositoryRoot(turn.repositoryId)]);
      if (disposed) return release(turn);
      if (turn.stopped) return await finishTurn(turn, { status: "stopped", text: "" });
      if (!board || !root) return await finishTurn(turn, null);
      const held = conversationImages(conversation.messages);
      const shown = images && held.length > 0 ? await images.files(turn.repositoryId, conversation.id, held) : [];
      const prompt = composePrompt({ board, repositoryName: path.basename(root), messages: conversation.messages, followUp: proposal, images: shown, now: now() });
      if (!prompt) return await finishTurn(turn, null);
      if (disposed) return release(turn);
      if (turn.stopped) return await finishTurn(turn, { status: "stopped", text: "" });
      const run = runTurn({
        spawn, executable: command, provider: turn.provider, model: turn.model, mcpServer, images: shown.length > 0 ? { folder: images.folder(turn.repositoryId, conversation.id), files: [] } : null,
        cwd: root, env: userSessionEnvironment(sourceEnvironment), prompt, timeoutMs: options.turnTimeoutMs,
        onText: (value) => { turn.text = value; },
        onActivity: (value) => { turn.activity = value; },
      });
      turn.stop = run.stop;
      void run.done.then((outcome) => finishTurn(turn, outcome), () => finishTurn(turn, null));
    } catch { await finishTurn(turn, null); }
  }

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
    let read = status === "complete" ? extractProposal(answer) : { text: visibleAnswer(answer), proposal: null, unreadable: false };
    try {
      const conversation = await store.read(turn.repositoryId, turn.conversationId);
      if (!conversation) return;
      // A proposal may name only images the owner sent in this conversation. One that names another is not offered.
      const sent = new Set(conversationImages(conversation.messages).map((image) => image.id));
      if (read.proposal && !proposalImages(read.proposal).every((id) => sent.has(id))) read = { text: read.text, proposal: null, unreadable: true };
      const at = now().toISOString();
      const message = { id: `m-${conversation.messages.length + 1}`, role: "agent", text: read.text, at, provider: turn.provider, model: turn.model, status };
      // A follow-up reports an outcome and offers nothing: a block in it is taken out of the text and never stored.
      if (turn.followUp) { message.followUp = turn.followUp; read = { text: read.text, proposal: null, unreadable: false }; }
      if (read.proposal) message.proposal = { id: newProposalId(), summary: read.proposal.summary, operations: read.proposal.operations, state: "pending" };
      if (read.unreadable) message.proposalUnreadable = true;
      await store.save(turn.repositoryId, { ...conversation, updatedAt: at, messages: [...conversation.messages, message] });
    } catch { /* The conversation keeps the owner's message; the next read marks the answer as interrupted. */ }
    finally { release(turn); }
  }

  async function send(payload) {
    const withImages = isPlainObject(payload) && Object.hasOwn(payload, "images");
    if (!exactly(payload, ["repositoryId", "conversationId", "text", "provider", "model", ...(withImages ? ["images"] : [])])) return INVALID;
    const { repositoryId, conversationId, provider, model } = payload;
    const imageIds = withImages ? chatImageIds(payload.images) : [];
    if (imageIds === null) return INVALID;
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
      const held = conversationImages(existing?.messages);
      if (imageIds.length > 0 && !images) return UNAVAILABLE;
      if (held.length + imageIds.length > CHAT_IMAGES_PER_CONVERSATION) return refused("limit");
      const [board, root] = await Promise.all([readBoard(repositoryId), repositoryRoot(repositoryId)]);
      if (!board || !root || disposed) return UNAVAILABLE;
      const conversation = existing ?? await store.create(repositoryId, { provider, model, title: conversationTitle(text) });
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
      const prompt = composePrompt({ board, repositoryName: path.basename(root), messages: existing?.messages ?? [], message: text, images: shown, attached, now: now() });
      if (!prompt) return abandoned(INVALID);
      const at = now().toISOString();
      const message = { id: `m-${conversation.messages.length + 1}`, role: "user", text, at, ...(attached.length > 0 ? { images: attached } : {}) };
      const next = { ...conversation, provider, model, updatedAt: at, messages: [...conversation.messages, message] };
      if (!await store.save(repositoryId, next)) return abandoned(UNAVAILABLE);
      // The run may read the folder of this conversation's images, and nothing else outside the repository.
      const newest = new Set(attached.map((image) => image.id));
      const runImages = shown.length > 0 ? { folder: images.folder(repositoryId, conversation.id), files: shown.filter((image) => newest.has(image.id)).map((image) => image.file) } : null;
      const turn = { repositoryId, conversationId: conversation.id, provider, model, startedAt: at, activity: "starting", text: "", stop: () => {} };
      active = turn;
      started = true;
      const run = runTurn({
        spawn, executable: command, provider, model, mcpServer, images: runImages, cwd: root, env: userSessionEnvironment(sourceEnvironment), prompt, timeoutMs: options.turnTimeoutMs,
        onText: (value) => { turn.text = value; },
        onActivity: (value) => { turn.activity = value; },
      });
      turn.stop = run.stop;
      void run.done.then((outcome) => finishTurn(turn, outcome), () => finishTurn(turn, null));
      return { ok: true, conversationId: conversation.id };
    } catch {
      return UNAVAILABLE;
    } finally {
      if (!started) release(reservation);
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
    // A follow-up that waits behind another turn reads as a turn that is starting, so the client keeps reading.
    const waiting = waitingOf(payload.repositoryId, conversation.id);
    const turn = turnOf(payload.repositoryId, conversation.id) ?? (waiting ? { conversationId: conversation.id, startedAt: waiting.queuedAt, provider: waiting.provider, model: waiting.model, activity: "starting", text: "" } : null);
    return {
      ok: true, conversation,
      turn: turn ? { conversationId: turn.conversationId, startedAt: turn.startedAt, provider: turn.provider, model: turn.model, activity: turn.activity, text: visibleAnswer(turn.text) } : null,
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
  // launch slot. The card's Start session is the owner's confirmation, so no native one follows. Only a launch answers
  // the proposal; a start that was held or failed keeps it pending with the fixed status, so the owner may apply it
  // again. Null when the start was cancelled (the app is closing), which stores nothing.
  async function startSession(event, repositoryId, taskId, proposal) {
    let status;
    try { status = (await startTask(event, repositoryId, taskId))?.status; } catch { status = "failed"; }
    if (status === "cancelled") return null;
    if (status === "started") return { ...proposal, state: "applied", results: [{ ok: true, start: "started" }] };
    return { ...proposal, state: "pending", results: [{ ok: false, error: "not_started", start: START_FAILURES.includes(status) ? status : "unavailable" }] };
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
    // Only the desktop window starts a session from the chat: the start needs its trusted event, and a paired device has none.
    if (startTaskId && !origin?.event) return refused("desktop_only");
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
      } else if (approve) {
        const board = await readBoard(repositoryId);
        if (!board) return UNAVAILABLE;
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
   * is `{ event }` only for a call the trusted desktop window made; without it the chat starts no session.
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
