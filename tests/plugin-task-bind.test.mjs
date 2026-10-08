import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runClaudeBindTaskHook } from "../plugin-src/claude-bind-task.mjs";
import {
  AGENT_QUERY_AUTH_HEADER,
  AGENT_QUERY_DESCRIPTOR_FILENAME,
  AGENT_TASK_ADD_PATH,
  AGENT_TASK_BIND_PATH,
  AGENT_TASK_WRITE_PATHS,
  createAgentQueryCapability,
} from "../shared/agent-query-transport.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "claude-code");
const bundlePath = path.join(pluginRoot, "scripts", "bind-task.bundle.mjs");
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const TASK_TOKEN = "Kq3_vN8xZp-2LmT7yR5wBd0HsJ6cEa1U";
const BIND_SCRIPT = "scripts/bind-task.bundle.mjs";

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-bind-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A loopback monitor that records every request and answers with `reply`. */
async function withMonitor(reply, run) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      reply(response);
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run({ origin: `http://127.0.0.1:${server.address().port}`, requests });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const answer = (status, body) => (response) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function writeDescriptor(dataRoot, origin, token) {
  await writeFile(path.join(dataRoot, AGENT_QUERY_DESCRIPTOR_FILENAME), `${JSON.stringify({ version: 1, origin, token })}\n`);
}

function hookInput(overrides = {}) {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: SESSION_ID,
    transcript_path: path.join(os.tmpdir(), `${SESSION_ID}.jsonl`),
    cwd: os.tmpdir(),
    ...overrides,
  });
}

/** Runs the generated bundle the way Claude Code does. Async, because the monitor lives in this process. */
function runBundle({ script = bundlePath, dataRoot, taskToken, input, extraEnv = {} }) {
  const env = { ...process.env, NODE_PATH: "", POMEGR_DATA_DIR: dataRoot, ...extraEnv };
  delete env.POMEGR_TASK_TOKEN;
  if (taskToken !== undefined) env.POMEGR_TASK_TOKEN = taskToken;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, cwd: dataRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function assertSilentSuccess(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

test("without POMEGR_TASK_TOKEN the hook sends nothing and prints nothing", async () => {
  await withTemporaryDirectory((dataRoot) => withMonitor(answer(200, { schemaVersion: 1, ok: true }), async ({ origin, requests }) => {
    await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
    assertSilentSuccess(await runBundle({ dataRoot, input: hookInput() }));
    assert.equal(requests.length, 0);
  }));
});

test("a malformed POMEGR_TASK_TOKEN sends nothing and prints nothing", async () => {
  const malformed = ["", "short-token", "a".repeat(15), "a".repeat(129), `${TASK_TOKEN}!`, `${TASK_TOKEN} `, "tok en/with+bad=chars-0123456789"];
  await withTemporaryDirectory((dataRoot) => withMonitor(answer(200, { schemaVersion: 1, ok: true }), async ({ origin, requests }) => {
    await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
    for (const taskToken of malformed) {
      const result = await runBundle({ dataRoot, taskToken, input: hookInput() });
      assertSilentSuccess(result);
    }
    assert.equal(requests.length, 0);
  }));
});

test("a token with a session id posts exactly one authorized bind request and prints nothing", async () => {
  await withTemporaryDirectory((dataRoot) => withMonitor(answer(200, { schemaVersion: 1, ok: true }), async ({ origin, requests }) => {
    const capability = createAgentQueryCapability();
    await writeDescriptor(dataRoot, origin, capability);
    const result = await runBundle({ dataRoot, taskToken: TASK_TOKEN, input: hookInput() });
    assertSilentSuccess(result);
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, AGENT_TASK_BIND_PATH);
    assert.equal(request.headers[AGENT_QUERY_AUTH_HEADER], capability);
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body), { token: TASK_TOKEN, sessionRef: `claude:${SESSION_ID}` });
    assert.equal(request.body, JSON.stringify({ token: TASK_TOKEN, sessionRef: `claude:${SESSION_ID}` }));
    assert.doesNotMatch(request.url, new RegExp(TASK_TOKEN, "u"));
    assert.equal(JSON.stringify(request.headers).includes(TASK_TOKEN), false);
  }));
});

test("the installed copy binds without node_modules and still prints nothing", async () => {
  await withTemporaryDirectory((temporaryRoot) => withMonitor(answer(200, { schemaVersion: 1, ok: true }), async ({ origin, requests }) => {
    const installed = path.join(temporaryRoot, "installed-pomegr");
    const dataRoot = path.join(temporaryRoot, "data");
    await cp(pluginRoot, installed, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
    const result = await runBundle({
      script: path.join(installed, "scripts", "bind-task.bundle.mjs"),
      dataRoot,
      taskToken: TASK_TOKEN,
      input: hookInput(),
    });
    assertSilentSuccess(result);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, AGENT_TASK_BIND_PATH);
  }));
});

test("monitor refusals, errors and an unreachable monitor leave the hook silent and successful", async () => {
  const replies = {
    not_found: answer(404, { schemaVersion: 1, ok: false, reason: "not_found" }),
    invalid: answer(422, { schemaVersion: 1, ok: false, reason: "invalid" }),
    unavailable: answer(503, { schemaVersion: 1, ok: false, reason: "unavailable" }),
    unauthorized: answer(401, "forbidden"),
    server_error: answer(500, "<html>boom</html>"),
    not_an_object: answer(200, "[1]"),
    destroyed: (response) => response.socket.destroy(),
  };
  for (const [name, reply] of Object.entries(replies)) {
    await withTemporaryDirectory((dataRoot) => withMonitor(reply, async ({ origin, requests }) => {
      await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
      const result = await runBundle({ dataRoot, taskToken: TASK_TOKEN, input: hookInput() });
      assertSilentSuccess(result);
      assert.equal(requests.length, 1, name);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${TASK_TOKEN}|${SESSION_ID}|forbidden|boom`, "u"), name);
    }));
  }

  // Connection refused: a descriptor that points at a port nothing listens on.
  await withTemporaryDirectory(async (dataRoot) => {
    const origin = await withMonitor(answer(200, {}), async ({ origin: closedLater }) => closedLater);
    await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
    assertSilentSuccess(await runBundle({ dataRoot, taskToken: TASK_TOKEN, input: hookInput() }));
  });
  // An unusable descriptor stops the attempt before any request. A missing descriptor is not
  // exercised here: it would fall back to the fixed dev monitor, which may be running.
  await withTemporaryDirectory(async (dataRoot) => {
    await writeFile(path.join(dataRoot, AGENT_QUERY_DESCRIPTOR_FILENAME), "{}");
    assertSilentSuccess(await runBundle({ dataRoot, taskToken: TASK_TOKEN, input: hookInput() }));
  });
});

test("a monitor that never answers cannot hold the hook past its timeout", async () => {
  await withTemporaryDirectory((dataRoot) => withMonitor(() => undefined, async ({ origin, requests }) => {
    await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
    const started = Date.now();
    const result = await runBundle({ dataRoot, taskToken: TASK_TOKEN, input: hookInput() });
    assertSilentSuccess(result);
    assert.equal(requests.length, 1);
    assert.ok(Date.now() - started < 5_000, "the hook must finish below its 5 second timeout");
  }));
});

test("hook input without a bindable root startup session sends nothing", async () => {
  const unbindable = [
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify({ hook_event_name: "SessionStart" }),
    hookInput({ session_id: undefined }),
    hookInput({ session_id: "not-a-uuid" }),
    hookInput({ session_id: `${SESSION_ID}/../x` }),
    hookInput({ session_id: 7 }),
    hookInput({ source: "resume" }),
    hookInput({ source: "clear" }),
    hookInput({ agent_id: "a1b2c3" }),
  ];
  await withTemporaryDirectory((dataRoot) => withMonitor(answer(200, { schemaVersion: 1, ok: true }), async ({ origin, requests }) => {
    await writeDescriptor(dataRoot, origin, createAgentQueryCapability());
    for (const input of unbindable) {
      assertSilentSuccess(await runBundle({ dataRoot, taskToken: TASK_TOKEN, input }));
    }
    assert.equal(requests.length, 0);
  }));
});

test("the hook function reports a plain status and never leaks the token", async () => {
  const calls = [];
  const run = (post, { environment = { POMEGR_TASK_TOKEN: TASK_TOKEN }, input = hookInput() } = {}) =>
    runClaudeBindTaskHook({ stream: Readable.from([input]), environment, post });
  const record = (result) => async (pathname, body) => {
    calls.push({ pathname, body });
    if (result instanceof Error) throw result;
    return result;
  };

  assert.equal(await run(record({ schemaVersion: 1, ok: true })), "bound");
  assert.deepEqual(calls, [{ pathname: AGENT_TASK_BIND_PATH, body: { token: TASK_TOKEN, sessionRef: `claude:${SESSION_ID}` } }]);
  assert.equal(await run(record({ schemaVersion: 1, ok: false, reason: "not_found" })), "refused");
  assert.equal(await run(record(null)), "refused");
  assert.equal(await run(record(new Error(`boom ${TASK_TOKEN}`))), "unavailable");
  assert.equal(calls.length, 4);

  // The model-visible environment cannot widen what is sent: only the two fixed fields.
  for (const call of calls) assert.deepEqual(Object.keys(call.body), ["token", "sessionRef"]);

  const before = calls.length;
  assert.equal(await run(record({ ok: true }), { environment: {} }), "skipped");
  assert.equal(await run(record({ ok: true }), { environment: { POMEGR_TASK_TOKEN: "short" } }), "skipped");
  assert.equal(await run(record({ ok: true }), { input: hookInput({ session_id: "nope" }) }), "skipped");
  assert.equal(calls.length, before);
});

test("the Claude hooks declare the bind hook on startup only, in source and generated form", async () => {
  for (const file of [path.join(repositoryRoot, "plugin-src", "claude-hooks.json"), path.join(pluginRoot, "hooks", "hooks.json")]) {
    const hooks = JSON.parse(await readFile(file, "utf8")).hooks;
    const declared = [];
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (hook.args?.some((argument) => argument.includes("bind-task"))) declared.push({ event, group, hook });
        }
      }
    }
    assert.equal(declared.length, 1, file);
    const [{ event, group, hook }] = declared;
    assert.equal(event, "SessionStart");
    assert.equal(group.matcher, "startup");
    assert.equal(group.hooks.length, 1);
    assert.deepEqual(hook, { type: "command", command: "node", args: [`\${CLAUDE_PLUGIN_ROOT}/${BIND_SCRIPT}`], timeout: 5 });
    // The policy hook keeps its own entry and its wider matcher.
    const policy = hooks.SessionStart.find((entry) => entry.hooks.some((candidate) => candidate.args?.includes("hook")));
    assert.equal(policy.matcher, "startup|resume|fork|clear|compact");
  }
  const source = await readFile(path.join(repositoryRoot, "plugin-src", "claude-hooks.json"), "utf8");
  const generated = await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8");
  assert.equal(generated.replace(/\r\n/gu, "\n"), source.replace(/\r\n/gu, "\n"));
});

test("the generated bundle holds no token and has no output path", async () => {
  const bundle = await readFile(bundlePath, "utf8");
  assert.ok(bundle.includes("POMEGR_TASK_TOKEN"));
  assert.ok(bundle.includes(AGENT_TASK_BIND_PATH));
  assert.equal(bundle.includes(TASK_TOKEN), false);
  assert.doesNotMatch(bundle, /POMEGR_TASK_TOKEN\s*[:=]\s*["'`][A-Za-z0-9_-]{16,}/u);
  assert.doesNotMatch(bundle, /console\.|process\.stdout|process\.stderr|stdout\.write|stderr\.write|appendFile|createWriteStream/u);
  assert.equal(await readFile(path.join(pluginRoot, "README.md"), "utf8").then((text) => /POMEGR_TASK_TOKEN=/u.test(text)), false);
});

test("the agent write transport carries exactly the add and bind paths", () => {
  assert.deepEqual([...AGENT_TASK_WRITE_PATHS], [AGENT_TASK_ADD_PATH, AGENT_TASK_BIND_PATH]);
  assert.equal(Object.isFrozen(AGENT_TASK_WRITE_PATHS), true);
  assert.equal(AGENT_TASK_BIND_PATH, "/api/agent/v1/tasks/bind");
});
