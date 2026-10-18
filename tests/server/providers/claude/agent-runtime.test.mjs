import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { createClaudeSessionWorkStartReader } from "../../../../server/providers/claude/session-work-start.mjs";
import { projectSessionDomains } from "../../../../server/sessions/domain/session-domain-projection.mjs";
import { buildSessionReport } from "../../../../shared/session-report.mjs";
import { assertNoPrivateFixtureSentinels, monitorStateFromProviderEvidence } from "../../../helpers/provider-fixtures.mjs";

const at = "2026-08-12T14:00:00.000Z";
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const response = (model, effort) => ({ type: "assistant", timestamp: at, effort,
  message: { model, content: [{ type: "text", text: "RESPONSE_MUST_NOT_LEAK" }] } });
// The observed failure occurs when request metadata slides all assistant records out of the tail.
const requestMetadata = () => Array.from({ length: 4 }, () => ({
  type: "api-request-blob", data: "PROMPT_MUST_NOT_LEAK".repeat(40_000),
}));

test("Claude child runtime survives a metadata-only tail in live refresh, cold reads and history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-agent-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localId = "runtime-parent";
  const main = path.join(root, "projects", "fixture", `${localId}.jsonl`);
  const children = path.join(path.dirname(main), localId, "subagents");
  await mkdir(children, { recursive: true });
  await writeFile(main, jsonl([response("claude-parent", "high")]), "utf8");
  const known = path.join(children, "agent-known.jsonl");
  const missing = path.join(children, "agent-missing.jsonl");
  const different = path.join(children, "agent-different.jsonl");
  await writeFile(known, jsonl([response("claude-child", "medium")]), "utf8");
  await writeFile(different, jsonl([response("claude-other", "low")]), "utf8");
  await writeFile(missing, jsonl([{ type: "user", timestamp: at, message: { content: "PROMPT_MUST_NOT_LEAK" } }]), "utf8");
  let mutate = null;
  const create = () => createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects"),
    registryRoot: path.join(root, "registry"), tasksRoot: path.join(root, "tasks"), explicitSession: main,
    yieldControl: async () => { const next = mutate; mutate = null; await next?.(); },
    usageRequest: async () => { throw new Error("not requested"); } });
  const provider = create();

  function verify(evidence, knownRuntime = ["claude-child", "medium"]) {
    const state = monitorStateFromProviderEvidence("claude", evidence);
    const projection = projectSessionDomains(state.session.id, { publicState: state, evidence });
    const roster = projection.domains.get("agents").agents;
    const runtimes = Object.fromEntries(roster.map((agent) => [agent.id, [agent.model, agent.effort]]));
    assert.deepEqual(runtimes, { primary: ["claude-parent", "high"], "agent-known": knownRuntime,
      "agent-different": ["claude-other", "low"], "agent-missing": ["unknown", "unspecified"] });
    const report = buildSessionReport(state, new Date(at));
    assert.ok(report.includes(`| Agent 02 | — | ${knownRuntime[0]} | ${knownRuntime[1]} |`));
    assert.match(report, /\| Agent 01 \| — \| claude-other \| low \|/);
    assert.match(report, /\| Agent 03 \| — \| Unavailable \| Unavailable \|/);
    assertNoPrivateFixtureSentinels(evidence);
    assertNoPrivateFixtureSentinels(state);
    assertNoPrivateFixtureSentinels(roster);
    assertNoPrivateFixtureSentinels(report);
  }

  verify(await provider.readSession(localId, { historical: false }));
  for (const file of [known, missing, different]) await appendFile(file, jsonl(requestMetadata()));
  verify(await provider.readSession(localId, { historical: false }));
  verify(await provider.readSession(localId, { historical: false }));
  verify(await create().readSession(localId, { historical: false }));
  verify(await provider.readSession(localId, { historical: true }));
  verify(await provider.readSession(localId, { historical: true, completeHistory: true }));
  await appendFile(known, jsonl([response("claude-child", "medium")]));
  mutate = () => appendFile(known, jsonl([response("claude-newest", "low")]));
  verify(await create().readSession(localId, { historical: false }), ["claude-newest", "low"]);
  assert.equal(mutate, null, "the runtime appended after tail acquisition must win over the older tail");
});

test("Claude runtime facts update independently and rebuild only after a complete replacement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-runtime-facts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const other = path.join(root, "other.jsonl");
  const reader = createClaudeSessionWorkStartReader({ maximumEntries: 1, yieldControl: async () => {} });
  const read = async () => (await reader.readTranscriptFacts(file)).runtime;
  await writeFile(file, jsonl([response("claude-first", "high")]), "utf8");
  assert.deepEqual(await read(), { model: "claude-first", effort: "high" });
  await appendFile(file, jsonl([response("<synthetic>", "low"), response(undefined, "medium")]));
  assert.deepEqual(await read(), { model: "claude-first", effort: "medium" });
  await appendFile(file, jsonl([response("claude-second", undefined), ...requestMetadata()]));
  assert.deepEqual(await read(), { model: "claude-second", effort: "medium" });
  await writeFile(other, jsonl([response("claude-unrelated", "low")]), "utf8");
  await reader.readTranscriptFacts(other);
  assert.deepEqual(await read(), { model: "claude-second", effort: "medium" }, "eviction rebuilds from this source only");
  const previous = await stat(file);
  await writeFile(file, jsonl([response("claude-fresh", "high"), response("<synthetic>", "low"), response(undefined, "medium"),
    response("claude-newest", undefined), ...requestMetadata()]), "utf8");
  assert.equal((await stat(file)).size, previous.size, "replacement keeps the same size and metadata suffix");
  await utimes(file, previous.atime, new Date(previous.mtimeMs + 2_000));
  assert.deepEqual(await read(), { model: "claude-newest", effort: "medium" }, "changed same-size generation rebuilds earlier fields");
  await writeFile(file, '{"type":"assistant"', "utf8");
  assert.deepEqual(await read(), { model: "claude-newest", effort: "medium" }, "incomplete replacement retains committed facts");
  await writeFile(file, jsonl([{ type: "user", timestamp: at, message: { content: "PROMPT_MUST_NOT_LEAK" } }]), "utf8");
  assert.deepEqual(await read(), { model: "unknown", effort: "unspecified" }, "complete replacement never inherits old runtime");
  await appendFile(file, jsonl([response("claude-replacement", "low")]));
  assert.deepEqual(await read(), { model: "claude-replacement", effort: "low" });
});
