import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contextMachineryFromRecord, latestContextMachinery, readLatestContextMachinery } from "../monitor/context-machinery.mjs";

function contextRecord(timestamp, skillTokens = "~90") {
  return {
    type: "system",
    subtype: "local_command",
    timestamp,
    content: `<local-command-stdout>## Context Usage

**Model:** claude-test-1
**Tokens:** 12.5k / 200k (6%)

### Estimated usage by category

| Percentage | Category | Tokens |
|------------|----------|--------|
| 1.2% | System prompt | 2.5k |
| 0.4% | Repository rules | 750 |
| 4.9% | Messages | 9.8k |
| 93.5% | Free space | 187k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| project-review | Project | ${skillTokens} |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | C:\\Users\\PRIVATE_USER\\private-repo\\CLAUDE.md | 640 |

### Output Styles

| Style | Origin | Tokens |
|-------|--------|--------|
| terse | Project | < 50 |
</local-command-stdout>`,
  };
}

function terminalContextRecord(timestamp) {
  const chart = "⛶ ".repeat(20);
  return {
    type: "system",
    subtype: "local_command",
    timestamp,
    content: `<local-command-stdout> \u001b[1mContext Usage\u001b[22m
${chart}  Opus 5
${chart}  claude-opus-5
${chart}  45.4k/1m tokens (5%)
${chart}  Estimated usage by category
${chart}  ⛁ System prompt: 4.9k tokens (0.5%)
${chart}  ⛁ System tools: 19.8k tokens (2.0%)
${chart}  ⛁ MCP tools: 942 tokens (0.1%)
${chart}  ⛁ Custom agents: 511 tokens (0.1%)
${chart}  ⛁ Memory files: 13.1k tokens (1.3%)
                                          ⛁ Skills: 6.1k tokens (0.6%)
                                          ⛁ Messages: 8 tokens (0.0%)
                                          ⛶ Free space: 954.6k (95.5%)

MCP tools · /mcp (loaded on-demand)
└ 43 tools · 942 tokens

/context all to expand</local-command-stdout>`,
  };
}

test("parses context tables dynamically and sanitizes memory paths", () => {
  const snapshot = contextMachineryFromRecord(contextRecord("2026-08-06T20:00:00.000Z"));

  assert.equal(snapshot.model, "claude-test-1");
  assert.deepEqual(snapshot.total, { used: "12.5k", limit: "200k", percentage: 6 });
  assert.equal(snapshot.machineryTokens, 3250);
  assert.deepEqual(snapshot.categories.map(({ name }) => name), ["System prompt", "Repository rules"]);
  assert.doesNotMatch(JSON.stringify(snapshot.categories), /Messages|Free space/);
  assert.deepEqual(snapshot.groups.map(({ label }) => label), ["Skills", "Memory Files", "Output Styles"]);
  assert.deepEqual(snapshot.groups[0].items[0], { name: "project-review", detail: "Project", tokens: "~90" });
  assert.deepEqual(snapshot.groups[1].items[0], { name: "CLAUDE.md", detail: "Project", tokens: "640" });
  assert.deepEqual(snapshot.groups[2].items[0], { name: "terse", detail: "Project", tokens: "< 50" });
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_USER|private-repo|local-command-stdout/);
});

test("keeps only the latest valid context snapshot", async (context) => {
  const older = contextRecord("2026-08-06T20:00:00.000Z", "~80");
  const newer = contextRecord("2026-08-06T20:05:00.000Z", "~95");
  assert.equal(latestContextMachinery([older, { type: "user", message: { content: "PRIVATE PROMPT" } }, newer]).groups[0].items[0].tokens, "~95");

  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-context-machinery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, [JSON.stringify(older), "not-json", JSON.stringify(newer)].join("\n"), "utf8");
  assert.equal((await readLatestContextMachinery(file)).observedAt, newer.timestamp);
});

test("parses the ANSI terminal summary emitted by current Claude Code", () => {
  const snapshot = contextMachineryFromRecord(terminalContextRecord("2026-08-10T16:06:45.118Z"));

  assert.equal(snapshot.model, "claude-opus-5");
  assert.deepEqual(snapshot.total, { used: "45.4k", limit: "1m", percentage: 5 });
  assert.equal(snapshot.machineryTokens, 45_353);
  assert.deepEqual(snapshot.categories.map(({ name }) => name), [
    "System prompt",
    "System tools",
    "MCP tools",
    "Custom agents",
    "Memory files",
    "Skills",
  ]);
  assert.deepEqual(snapshot.groups, []);
  assert.doesNotMatch(JSON.stringify(snapshot.categories), /Messages|Free space/);
});

test("ignores unrelated local command output", () => {
  assert.equal(contextMachineryFromRecord({ type: "system", subtype: "local_command", content: "PRIVATE COMMAND OUTPUT" }), null);
});
