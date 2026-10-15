import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { claudeUsageEvidenceRecord, parseClaudeContextRecords } from "../../../../server/providers/claude/context.mjs";
import { buildCacheEvents } from "../../../../server/analytics/cache-events.mjs";

// Synthetic transcripts only. A refill whose request has left the 2 MiB record tail keeps its
// occurrence, because request evidence comes from the whole-transcript pass, not from the tail.
const clock = (seconds) => new Date(Date.parse("2026-08-10T10:00:00.000Z") + seconds * 1_000).toISOString();
const request = (id, seconds, read, write, diagnostic = null) => ({
  type: "assistant", timestamp: clock(seconds),
  message: {
    id, model: "claude-test", content: [{ type: "text", text: "PRIVATE_RESPONSE" }, { type: "tool_use", id: `use-${id}`, name: "Bash", input: { command: "PRIVATE_COMMAND" } }],
    usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } },
    ...(diagnostic ? { diagnostics: { cache_miss_reason: { type: diagnostic } } } : {}),
  },
});
const prompt = (seconds) => ({ type: "user", timestamp: clock(seconds), message: { content: "PRIVATE_PROMPT" } });
const result = (seconds, id) => ({ type: "user", timestamp: clock(seconds), message: { content: [{ type: "tool_result", tool_use_id: `use-${id}`, content: "PRIVATE_RESULT" }] } });
const padding = (seconds) => ({ type: "user", timestamp: clock(seconds), message: { content: "x".repeat(2_300_000) } });
const lines = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

// An idle gap longer than the one-hour lifetime, then a partial rewrite the provider reports as an
// unavailable cache entry; later a partial rewrite the provider diagnoses as changed tools.
const refills = (idleSeconds = 77 * 60, between = []) => [
  prompt(0), request("warm", 1, 150_000, 1_000), result(2, "warm"), request("reused", 3, 151_000, 500),
  prompt(3 + idleSeconds), ...between, request("expired", 4 + idleSeconds, 31_000, 126_000, "previous_message_not_found"),
  result(5 + idleSeconds, "expired"), request("rewarmed", 6 + idleSeconds, 157_000, 1_300),
  result(7 + idleSeconds, "rewarmed"), request("tools", 8 + idleSeconds, 36_000, 160_000, "tools_changed"),
];

async function occurrencesAfterTheTail(context, id, records) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-whole-refills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "projects", "fixture", `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  // The padding pushes every refill request out of the record tail before the first read.
  await writeFile(file, lines([...records, padding(9_000), request("latest", 9_001, 160_000, 900)]));
  const occurrences = async (provider) => {
    const evidence = await provider.readSession(id, { historical: true });
    const feed = buildCacheEvents({ sessionId: id, agents: evidence.agents, usageSnapshots: evidence.usageSnapshots, enabled: true });
    return feed.possibleFullRefills.flatMap(({ occurrences: items }) => items.map(({ observedAt, kind, reason, providerStatus, cacheLifetimeInference }) => ({
      observedAt, kind, reason, providerStatus, lifetime: cacheLifetimeInference?.cacheLifetime ?? null,
    })));
  };
  const open = () => createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects") });
  return { cold: await occurrences(open()), restarted: await occurrences(open()) };
}

test("refills whose requests left the transcript tail stay in the per-agent occurrences", async (context) => {
  const idle = 77 * 60;
  const expected = [
    { observedAt: clock(4 + idle), kind: "lifetime_elapsed", reason: null, providerStatus: "previous_cache_entry_unavailable", lifetime: "1h" },
    { observedAt: clock(8 + idle), kind: "provider_diagnosed", reason: "tools_changed", providerStatus: null, lifetime: null },
  ];
  const { cold, restarted } = await occurrencesAfterTheTail(context, "past-tail", refills(idle));
  assert.deepEqual(cold, expected, "a cold read of an ended session");
  assert.deepEqual(restarted, expected, "a restarted provider");
});

test("insufficient evidence past the tail still produces no refill occurrence", async (context) => {
  // A gap shorter than the lifetime supports no expiry, and without a recognized reason a partial rewrite is no occurrence.
  const short = await occurrencesAfterTheTail(context, "short-gap", refills(10 * 60).filter((record) => record.message?.id !== "tools"));
  assert.deepEqual(short.cold, []);
  // An unreadable record could be a request, so nothing compares across it.
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-whole-refills-gap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "projects", "fixture", "unreadable.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const records = refills().filter((record) => record.message?.id !== "tools");
  const expiredAt = records.findIndex((record) => record.message?.id === "expired");
  await writeFile(file, lines(records.slice(0, expiredAt)) + "{unreadable\n" + lines([...records.slice(expiredAt), padding(9_000), request("latest", 9_001, 160_000, 900)]));
  const evidence = await createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects") }).readSession("unreadable", { historical: true });
  assert.ok(evidence.usageSnapshots.some(({ dedupeId }) => dedupeId.endsWith(":expired")), "the request is retained");
  assert.deepEqual(buildCacheEvents({ sessionId: "unreadable", agents: evidence.agents, usageSnapshots: evidence.usageSnapshots, enabled: true }).possibleFullRefills, []);
});

test("a usage-evidence record keeps no content and parses to the same request snapshot", () => {
  const records = refills();
  const copies = records.map(claudeUsageEvidenceRecord);
  assert.doesNotMatch(JSON.stringify(copies), /PRIVATE_/u);
  const options = { actorId: "primary", completeHistory: true, includeToolUseIds: true, toolChangeCauses: new Map() };
  assert.deepEqual(parseClaudeContextRecords(copies, options), parseClaudeContextRecords(records, options));
});
