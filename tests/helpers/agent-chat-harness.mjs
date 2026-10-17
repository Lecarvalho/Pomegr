// A Pomegr agent chat controller wired to fakes only: a fake monitor `fetch`, a fake provider run, a temporary data
// root, and fixed time. No provider process starts and no request leaves the test.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentChat } from "../../desktop/runtime/agent-chat.mjs";
import { createAgentChatImages } from "../../desktop/runtime/agent-chat-images.mjs";
import { AGENT_CHAT_DIRECTORY, createAgentChatStore } from "../../desktop/runtime/agent-chat-store.mjs";

export const repositoryId = "repo-0123456789abcdef01234567";
export const otherRepositoryId = "repo-fedcba9876543210fedcba98";
export const origin = "http://127.0.0.1:4317";
export const token = "synthetic-desktop-token-0123456789";
export const root = "C:\\Work\\private-repo";
export const claudeExecutable = "C:\\Users\\tester\\.local\\bin\\claude.exe";
export const codexExecutable = "C:\\Users\\tester\\.local\\bin\\codex.exe";
export const desktopExecutable = "C:\\Program Files\\Pomegr\\Pomegr.exe";
export const unpackedRoot = "C:\\Program Files\\Pomegr\\resources\\app.asar.unpacked";
export const mcpScript = path.join(unpackedRoot, "desktop", "workers", "agent-chat-mcp.cjs");
export const stamp = "2026-10-01T12:00:00.000Z";

export const sourceEnvironment = Object.freeze({
  USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Windows;C:\\Tools", HTTPS_PROXY: "http://proxy.test:8080",
  POMEGR_CLAUDE_EXECUTABLE: claudeExecutable, POMEGR_CODEX_EXECUTABLE: codexExecutable,
  POMEGR_MONITOR_TOKEN: "synthetic-private-monitor-value", POMEGR_MONITOR_ORIGIN: origin, POMEGR_TASK_TOKEN: "synthetic-task-value", POMEGR_START_ARGUMENTS: "x",
  ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", POMEGR_SMOKE_NO_SYSTEM_NODE: "1",
});

export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export function readyBoard() {
  return {
    readiness: "ready", repositoryId, repositoryRoot: root,
    columns: [{ id: "col-a", name: "Backlog" }, { id: "col-b", name: "Ready" }, { id: "col-c", name: "In progress" }, { id: "col-d", name: "Review" }, { id: "col-e", name: "Done" }],
    features: [{ id: "feat-1", name: "Auth", done: false }],
    queue: { status: "idle", order: [] },
    tasks: [
      { id: "T-1", text: "Existing task one", columnId: "col-a", state: "queued", featureId: "feat-1", run: { provider: "claude", model: "claude-opus-4-1", effort: "high" }, completeWhen: { checks: ["pr_open"], own: null } },
      { id: "T-2", text: "Existing task two", columnId: "col-a", state: "queued", featureId: "feat-1", run: { provider: "codex", model: null, effort: "low" }, completeWhen: { checks: [], own: null } },
      { id: "T-3", text: "Existing task three", columnId: "col-b", state: "queued", featureId: null },
    ],
  };
}

/** A fake provider run that the test finishes by hand: `run.resolve({ status, text })`. */
export function storedFiles(directory) {
  const found = {};
  if (!existsSync(directory)) return found;
  for (const repository of readdirSync(directory)) {
    // The images folder holds image files, not conversations.
    for (const name of readdirSync(path.join(directory, repository)).filter((entry) => entry !== "images")) found[`${repository}/${name}`] = JSON.parse(readFileSync(path.join(directory, repository, name), "utf8"));
  }
  return found;
}

export function fakeRuns() {
  const runs = [];
  const runTurn = (options) => {
    let resolve;
    let reject;
    const done = new Promise((resolveDone, rejectDone) => { resolve = resolveDone; reject = rejectDone; });
    const run = { options, stops: 0, resolve, reject, diskAtStart: null };
    runs.push(run);
    return { done, stop: () => { run.stops += 1; } };
  };
  return { runs, runTurn };
}

/**
 * `state` is the fake monitor: `board` answers GET /api/tasks, `agents` answers GET /api/agents, `rootAnswer` answers worktree-root, `actions(action,
 * payload)` answers every other task action, `gate` (a promise) holds the board read, and `fetchError` makes every
 * request throw. `calls` records each request, except a run's declaration and withdrawal, which `declarations` records
 * as `{ action, sessionId, call }`; `declarationError` makes those throw.
 */
export async function chatHarness(context, overrides = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-agent-chat-"));
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const directory = path.join(dataRoot, AGENT_CHAT_DIRECTORY);
  const state = { board: readyBoard(), agents: { runs: [] }, rootAnswer: { ok: true, root }, actions: () => ({ ok: true }), imageAdd: (call) => ({ ok: true, imageId: call.query.imageId }), gate: null, fetchError: null, calls: [], declarations: [], declarationError: null };
  const { viaDataRoot = false, files = [claudeExecutable, codexExecutable, mcpScript], ...rest } = overrides;
  let tick = 0;
  const now = () => new Date(Date.parse(stamp) + (tick += 1000));
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    // A JSON body is parsed; a binary body (an image) is kept as a copy of its bytes, with its query and content type.
    const binary = init.body instanceof Uint8Array ? new Uint8Array(init.body) : null;
    const call = {
      url, pathname: parsed.pathname, search: parsed.search, init, body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      query: Object.fromEntries(parsed.searchParams), bytes: binary, contentType: init.headers?.["content-type"] ?? null,
    };
    if (parsed.pathname.startsWith("/internal/agent-chat/run-")) {
      state.declarations.push({ action: parsed.pathname.slice("/internal/agent-chat/run-".length), sessionId: call.query.sessionId, call });
      if (state.declarationError ?? state.fetchError) throw state.declarationError ?? state.fetchError;
      return json({ ok: true });
    }
    state.calls.push(call);
    if (state.fetchError) throw state.fetchError;
    if (init.method === "GET" && parsed.pathname === "/api/tasks") {
      if (state.gate) await state.gate;
      return json(state.board);
    }
    if (init.method === "GET" && parsed.pathname === "/api/agents") return json(state.agents);
    if (parsed.pathname === "/internal/tasks/worktree-root") return json(state.rootAnswer);
    // The monitor's image route: `state.imageAdd(call)` answers it, and by default takes every image.
    if (parsed.pathname === "/internal/tasks/image-add") return json(await state.imageAdd(call));
    const action = parsed.pathname.replace("/internal/tasks/", "");
    return json(await state.actions(action, call.body?.payload, call.body, call));
  };
  const store = createAgentChatStore({ directory, now });
  const images = createAgentChatImages({ directory });
  const { runs, runTurn: startRun } = fakeRuns();
  // What is on disk at the moment a turn starts: the owner's message must already be stored.
  const runTurn = (options) => {
    const turn = startRun(options);
    runs.at(-1).diskAtStart = storedFiles(directory);
    return turn;
  };
  const spawn = () => { throw new Error("A test must never start a process."); };
  const chat = createAgentChat({
    fetch: fetchImpl, monitorOrigin: origin, authorizationToken: token, environment: { ...sourceEnvironment }, platform: "win32",
    fileExists: (file) => files.includes(file), now, runTurn, spawn,
    executable: desktopExecutable, unpackedRoot,
    ...(viaDataRoot ? { dataRoot } : { store, images }),
    ...rest,
  });
  context.after(() => chat.dispose());
  const calls = state.calls;
  // After an Apply or a Dismiss, Pomegr asks Aril for one follow-up: a run whose prompt ends with the outcome.
  const followUps = () => runs.filter((run) => run.options.prompt.includes("</proposal_outcome>"));
  const followUp = () => until(() => followUps().find((run) => !run.answered) ?? null);
  return {
    chat, state, runs, calls, declarations: state.declarations, dataRoot, directory, store, images, spawn, now, followUps, followUp,
    /** Answers the follow-up that runs or is about to, and waits until it is stored. */
    async finishFollowUp(conversationId, outcome = { status: "complete", text: "Noted." }, repository = repositoryId) {
      const run = await followUp();
      run.answered = true;
      return finishTurn({ handle: (operation, payload) => chat.handle(operation, payload) }, run, outcome, conversationId, repository);
    },
    image: (operation, payload) => chat.image(operation, payload),
    handle: (operation, payload) => chat.handle(operation, payload),
    /** The stored conversations as a new process would read them from disk. */
    reload: () => createAgentChatStore({ directory }),
    requests: (predicate = () => true) => calls.filter(predicate),
    imageCalls: () => calls.filter((call) => call.pathname === "/internal/tasks/image-add"),
    actionCalls: () => calls.filter((call) => call.pathname.startsWith("/internal/tasks/") && call.pathname !== "/internal/tasks/worktree-root" && call.pathname !== "/internal/tasks/image-add"),
  };
}

export const agentMessage = (index, extra = {}) => ({ id: `m-${index}`, role: "agent", text: "An answer", at: stamp, provider: "claude", model: null, status: "complete", ...extra });
export const userMessage = (index, text = "A question") => ({ id: `m-${index}`, role: "user", text, at: stamp });

/** Puts a conversation in the harness store, as an earlier run of the app would have left it. */
export async function seed(h, { messages = [], title = "Seeded", provider = "claude", model = null, repository = repositoryId } = {}) {
  const created = await h.store.create(repository, { provider, model, title });
  const saved = { ...created, messages };
  if (!await h.store.save(repository, saved)) throw new Error("The seeded conversation was refused.");
  return saved;
}

// Polls until the check holds. File writes take real time, so the wait is bounded by a deadline, not by a count.
export async function until(check, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("The condition was not met.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export const send = (h, overrides = {}) => h.handle("send", {
  repositoryId, conversationId: null, text: "What should I do first?", provider: "claude", model: null, ...overrides,
});

/** Finishes the running turn with an outcome and waits until the answer is stored. */
export async function finishTurn(h, run, outcome, conversationId, repository = repositoryId) {
  run.resolve(outcome);
  await until(async () => (await h.handle("read", { repositoryId: repository, conversationId })).turn === null);
  return (await h.handle("read", { repositoryId: repository, conversationId })).conversation;
}

export const pendingProposal = (overrides = {}) => ({
  id: "p-0123456789ab", summary: "Tidy the board", state: "pending",
  operations: [{ op: "update_task", id: "T-1", text: "Reworded" }, { op: "queue_task", id: "T-2" }],
  ...overrides,
});

export const withProposal = (proposal = pendingProposal(), extra = {}) => [userMessage(1), agentMessage(2, { text: "Here is a plan.", proposal, ...extra })];

// Leading bytes of each image type the chat accepts, followed by a marker so a test can tell two images apart.
const withTail = (head, marker) => Uint8Array.from([...head, ...[marker, marker + 1, marker + 2]]);
export const pngBytes = (marker = 1) => withTail([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], marker);
export const jpegBytes = (marker = 1) => withTail([0xff, 0xd8, 0xff, 0xe0], marker);
export const gifBytes = (marker = 1) => withTail([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], marker);
export const webpBytes = (marker = 1) => withTail([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], marker);

/** Adds one image through the chat's own image operation and answers its `{ id, type, bytes }`. */
export async function addImage(h, bytes = pngBytes(), repository = repositoryId) {
  const answer = await h.image("add", { repositoryId: repository, bytes });
  if (answer.ok !== true) throw new Error("The image was refused.");
  return answer.image;
}
