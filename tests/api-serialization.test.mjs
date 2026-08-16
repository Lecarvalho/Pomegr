import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMonitorServer } from "../monitor/server.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import {
  assertNoPrivateFixtureSentinels,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

const SAFE_CWD = "C:\\synthetic\\pomegr-api-fixture";
const PRIVATE_RESOURCE_PID = 987_654_321;
const PRIVATE_RESOURCE_START = "PROCESS_START_MUST_NOT_LEAK";

function resourceUsageSamplerWithPrivateFields() {
  return {
    async sample() {},
    get() {
      return {
        status: "ready",
        reason: null,
        current: {
          cpuCores: 1.25,
          cpuMachinePercent: 15.625,
          memoryBytes: 2_048,
          readBytesPerSecond: 400,
          writeBytesPerSecond: 200,
          pid: PRIVATE_RESOURCE_PID,
          processStartIdentity: PRIVATE_RESOURCE_START,
          processName: "PROCESS_NAME_MUST_NOT_LEAK",
        },
        observedPeak: {
          memoryBytes: 4_096,
          pid: PRIVATE_RESOURCE_PID,
          processStartIdentity: PRIVATE_RESOURCE_START,
        },
        samples: [{
          timestamp: "2026-08-10T13:00:18.000Z",
          cpuCores: 1.25,
          cpuMachinePercent: 15.625,
          memoryBytes: 2_048,
          readBytesPerSecond: 400,
          writeBytesPerSecond: 200,
          command: "PROCESS_COMMAND_MUST_NOT_LEAK",
        }],
        intervalMs: 5_000,
      };
    },
  };
}

async function writeFixture(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function startSyntheticMonitor(context, options) {
  const server = createMonitorServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function codexAppThread() {
  return {
    id: "codex-fixture-parent",
    sessionId: "codex-fixture-parent",
    ephemeral: false,
    createdAt: Date.parse("2026-08-10T13:00:00.000Z") / 1_000,
    updatedAt: Date.parse("2026-08-10T13:00:17.000Z") / 1_000,
    source: "cli",
    cwd: SAFE_CWD,
    name: "Synthetic Codex API fixture",
    status: { type: "idle" },
    preview: "PROMPT_MUST_NOT_LEAK",
    authFile: "AUTH_FILE_MUST_NOT_LEAK",
    environment: { SECRET: "ENV_SECRET_MUST_NOT_LEAK" },
    turns: [{
      id: "turn-private",
      items: [
        { type: "userMessage", content: "PROMPT_MUST_NOT_LEAK" },
        { type: "agentMessage", content: "RESPONSE_MUST_NOT_LEAK" },
        { type: "futurePrivateItem", reasoning: "REASONING_MUST_NOT_LEAK" },
      ],
    }],
  };
}

function rateLimitsWithPrivateFields() {
  return {
    result: {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_786_363_200 },
          credits: { token: "OAUTH_TOKEN_MUST_NOT_LEAK" },
        },
      },
      authFile: "AUTH_FILE_MUST_NOT_LEAK",
      environmentSecret: "ENV_SECRET_MUST_NOT_LEAK",
      localPath: "PRIVATE_PATH_MUST_NOT_LEAK",
    },
  };
}

async function syntheticProviders(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-api-audit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const replacements = [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]];

  const claudeRoot = path.join(root, "claude");
  const claudeId = "claude-fixture-parent";
  const claudeFile = path.join(claudeRoot, "projects", "fixture", `${claudeId}.jsonl`);
  await writeFixture(claudeFile, "claude/session.jsonl", replacements);
  await writeFixture(
    path.join(claudeRoot, "projects", "fixture", claudeId, "subagents", "agent-child-fixture.jsonl"),
    "claude/subagent.jsonl",
    replacements,
  );
  await writeFixture(path.join(claudeRoot, "registry", `${claudeId}.json`), "claude/registry.json");
  await writeFixture(path.join(claudeRoot, "tasks", claudeId, "task-1.json"), "claude/task.json");
  const claude = createClaudeProvider({
    homeDir: claudeRoot,
    projectsRoot: path.join(claudeRoot, "projects"),
    registryRoot: path.join(claudeRoot, "registry"),
    tasksRoot: path.join(claudeRoot, "tasks"),
    explicitSession: claudeFile,
    usageRequest: async () => { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK AUTH_FILE_MUST_NOT_LEAK"); },
  });

  const codexRoot = path.join(root, "codex");
  const rolloutRoot = path.join(codexRoot, "sessions", "2026", "08", "10");
  await writeFixture(path.join(rolloutRoot, "rollout-parent.jsonl"), "codex/parent.jsonl", replacements);
  await writeFixture(path.join(rolloutRoot, "rollout-child.jsonl"), "codex/child.jsonl", replacements);
  const parent = codexAppThread();
  const codex = createCodexProvider({
    codexHome: codexRoot,
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async listThreads() { return { data: [parent] }; },
      async readThread({ threadId }) {
        if (threadId !== parent.id) throw new Error("PRIVATE_PATH_MUST_NOT_LEAK");
        return { thread: parent };
      },
      async readRateLimits() { return rateLimitsWithPrivateFields(); },
    },
  });
  return { claude, codex };
}

test("/api/state and /api/sessions serialize only allowlisted Claude and Codex metadata", async (context) => {
  const { claude, codex } = await syntheticProviders(context);
  const providerRegistry = createProviderRegistry([claude, codex]);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry,
    resourceUsageSampler: resourceUsageSamplerWithPrivateFields(),
    readGitState() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK ENV_SECRET_MUST_NOT_LEAK"); },
    async readPullRequests() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK TOOL_OUTPUT_MUST_NOT_LEAK"); },
  });

  const responses = await Promise.all([
    fetch(`${origin}/api/sessions`),
    fetch(`${origin}/api/state?sessionId=claude%3Aclaude-fixture-parent`),
    fetch(`${origin}/api/state?sessionId=codex%3Acodex-fixture-parent`),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  const serialized = await Promise.all(responses.map((response) => response.text()));
  serialized.forEach((body, index) => assertNoPrivateFixtureSentinels(body, `API response ${index + 1}`));
  assert.doesNotMatch(serialized.join("\n"), /AUTH_FILE_MUST_NOT_LEAK/);
  assert.doesNotMatch(
    serialized.join("\n"),
    /987654321|PROCESS_START_MUST_NOT_LEAK|PROCESS_NAME_MUST_NOT_LEAK|PROCESS_COMMAND_MUST_NOT_LEAK|processStartIdentity|"pid"|intervalMs/,
  );

  const catalog = JSON.parse(serialized[0]);
  assert.deepEqual(catalog.sessions.map(({ id, source }) => ({ id, source })).sort((left, right) => left.id.localeCompare(right.id)), [
    { id: "claude:claude-fixture-parent", source: "Claude Code" },
    { id: "codex:codex-fixture-parent", source: "Codex" },
  ]);
  const claudeState = JSON.parse(serialized[1]);
  const codexState = JSON.parse(serialized[2]);
  assert.equal(claudeState.session.repository.available, false, "Git failure degrades independently");
  assert.equal(codexState.session.repository.available, false, "Git failure degrades independently");
  assert.equal(claudeState.session.pullRequests.status, "unavailable");
  assert.equal(codexState.usageLimits.available, true);
  assert.equal(codexState.metrics.tokens.allAgents, 1_950);
  assert.equal(codexState.metrics.tokens.allAgents < 9_800, true, "cumulative total_token_usage is not exposed");
  assert.deepEqual(claudeState.metrics.tokens.contextHistory.boundaries.map(({ agentId, kind, preTokens }) => ({
    agentId, kind, preTokens,
  })), [{ agentId: "primary", kind: "automatic_compaction", preTokens: 180_000 }]);
  assert.equal(claudeState.metrics.tokens.cacheEvents.status, "ready");
  assert.equal(codexState.metrics.tokens.cacheEvents.status, "unavailable");
  for (const state of [claudeState, codexState]) {
    assert.equal(state.metrics.tokens.contextHistory.buckets.at(-1).total, state.metrics.tokens.allAgents);
    assert.equal(Array.isArray(state.metrics.tokens.contextHistory.boundaries), true);
    assert.equal(Array.isArray(state.metrics.tokens.cacheEvents.items), true);
    assert.equal(state.metrics.tokens.requestSnapshots.status, "ready");
    assert.equal(state.metrics.tokens.requestSnapshots.items.length > 0, true);
    for (const item of state.metrics.tokens.requestSnapshots.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        "agentId", "cacheReadTokens", "cacheWriteTokens", "id", "observedAt", "outputTokens", "totalTokens", "uncachedInputTokens",
      ]);
      assert.equal(item.totalTokens, item.uncachedInputTokens + item.cacheWriteTokens + item.cacheReadTokens + item.outputTokens);
      assert.match(item.id, /^request-[a-f0-9]{16}$/);
    }
    assert.equal(Object.hasOwn(state.metrics.tokens, "contextGrowthTimeline"), false);
    assert.deepEqual(state.metrics.resources, {
      status: "ready",
      reason: null,
      current: {
        cpuCores: 1.25,
        cpuMachinePercent: 15.625,
        memoryBytes: 2_048,
        readBytesPerSecond: 400,
        writeBytesPerSecond: 200,
      },
      observedPeak: { memoryBytes: 4_096 },
      samples: [{
        timestamp: "2026-08-10T13:00:18.000Z",
        cpuCores: 1.25,
        cpuMachinePercent: 15.625,
        memoryBytes: 2_048,
        readBytesPerSecond: 400,
        writeBytesPerSecond: 200,
      }],
    });
  }
});

test("missing and deleted history stays historical without current Git or usage data", async (context) => {
  const { claude, codex } = await syntheticProviders(context);
  let gitCalls = 0;
  let usageCalls = 0;
  const wrappedCodex = { ...codex, async readUsageLimits() { usageCalls += 1; return codex.readUsageLimits(); } };
  const providerRegistry = createProviderRegistry([claude, wrappedCodex]);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry,
    readGitState() { gitCalls += 1; throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    async readPullRequests() { return { status: "ready", checkedAt: null, items: [] }; },
  });
  const response = await fetch(`${origin}/api/state?sessionId=codex%3Adeleted-history`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assertNoPrivateFixtureSentinels(body, "deleted-history API response");
  const state = JSON.parse(body);
  assert.equal(state.view, "history");
  assert.equal(state.error, "The selected session is no longer available.");
  assert.equal(state.session, null);
  assert.equal(state.metrics.resources, null);
  assert.deepEqual(state.usageLimits.limits, []);
  assert.equal(gitCalls, 0);
  assert.equal(usageCalls, 0);
});

test("one provider failure cannot fail the other provider's API catalog or state", async (context) => {
  const { claude, codex } = await syntheticProviders(context);
  const brokenCodex = {
    ...codex,
    async listSessions() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
    async readSession() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
  };
  const providerRegistry = createProviderRegistry([claude, brokenCodex]);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry,
    readGitState() { return { available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }; },
    async readPullRequests() { return { status: "ready", checkedAt: null, items: [] }; },
  });
  const [catalogResponse, stateResponse] = await Promise.all([
    fetch(`${origin}/api/sessions`),
    fetch(`${origin}/api/state?sessionId=claude%3Aclaude-fixture-parent`),
  ]);
  assert.equal(catalogResponse.status, 200);
  assert.equal(stateResponse.status, 200);
  const catalog = await catalogResponse.json();
  const state = await stateResponse.json();
  assert.deepEqual(catalog.sessions.map(({ id }) => id), ["claude:claude-fixture-parent"]);
  assert.equal(state.source, "Claude Code");
  assertNoPrivateFixtureSentinels([catalog, state], "provider failure isolation API responses");
});

test("HTTP fallbacks never serialize arbitrary exception messages", async (context) => {
  const { claude } = await syntheticProviders(context);
  const runtime = {
    async sessionCatalog() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
    async analyze() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    analyzeEmpty() {
      return {
        connected: false,
        source: claude.source,
        capabilities: claude.capabilities,
        view: "live",
      };
    },
  };
  const origin = await startSyntheticMonitor(context, { runtime });
  const [sessions, state] = await Promise.all([
    fetch(`${origin}/api/sessions`),
    fetch(`${origin}/api/state`),
  ]);
  assert.equal(sessions.status, 500);
  assert.equal(state.status, 500);
  const serialized = `${await sessions.text()}\n${await state.text()}`;
  assert.doesNotMatch(serialized, /MUST_NOT_LEAK/);
  assert.match(serialized, /Session catalog error/);
  assert.match(serialized, /Monitor error/);
});
