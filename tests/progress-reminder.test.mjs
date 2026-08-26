import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  handleProgressReminder,
  hashSessionId,
  readProgressPolicy,
} from "../scripts/progress-reminder.mjs";

const templatePath = path.resolve("plugins/pomegr/skills/init/references/policy-template.md");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-progress-reminder-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".pomegr"));
  const template = await readFile(templatePath, "utf8");
  await writeFile(path.join(root, ".pomegr", "signals.md"), template.replace("- Enabled: no", "- Enabled: yes"));
  const data = path.join(root, "plugin-data");
  return { root, data };
}

function payload(root, sessionId, timestamp, toolName, extra = {}) {
  return { hook_event_name: "PostToolUse", session_id: sessionId, cwd: root, timestamp, tool_name: toolName, ...extra };
}

test("reminds only after the time and completion thresholds, then repeats per cycle", async () => {
  const { root, data } = await fixture();
  try {
    const sessionId = "root-session";
    const t0 = Date.parse("2026-08-26T12:00:00Z");
    const options = { dataDirectory: data };
    assert.equal(readProgressPolicy(root).enabled, true);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0, "Bash"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 1_000, "Edit"), options), null);
    const reminder = handleProgressReminder(payload(root, sessionId, t0 + 10 * 60 * 1000, "Read"), options);
    assert.match(reminder.hookSpecificOutput.additionalContext, /progress reminder/i);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 11 * 60 * 1000, "Read"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 12 * 60 * 1000, "Read"), options), null);
    const repeat = handleProgressReminder(payload(root, sessionId, t0 + 20 * 60 * 1000, "Read"), options);
    assert.match(repeat.hookSpecificOutput.additionalContext, /progress reminder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy, disabled, subagent, and Pomegr tool events never qualify", async () => {
  const { root, data } = await fixture();
  try {
    const sessionId = "root-session";
    const options = { dataDirectory: data };
    const t0 = Date.parse("2026-08-26T12:00:00Z");
    for (const extra of [{ agent_id: "child" }, {}]) {
      assert.equal(handleProgressReminder(payload(root, sessionId, t0, "mcp__pomegr__report_session_signal", extra), options), null);
    }
    const disabled = path.join(root, ".pomegr", "signals.md");
    const text = await readFile(disabled, "utf8");
    await writeFile(disabled, text.replace("- Enabled: yes", "- Enabled: no"));
    assert.equal(handleProgressReminder(payload(root, sessionId, t0, "Bash"), options), null);
    await writeFile(disabled, text.replace("Policy version: 7", "Policy version: 6").replace(/\n## Session progress\n\n- Enabled: yes\n/, "\n"));
    assert.equal(readProgressPolicy(root).enabled, false);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0, "Bash"), options), null);
    assert.equal(hashSessionId(sessionId), hashSessionId(sessionId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("foreign progress-named tools cannot reset the Pomegr reminder window", async () => {
  const { root, data } = await fixture();
  try {
    const sessionId = "root-session";
    const options = { dataDirectory: data };
    const t0 = Date.parse("2026-08-26T12:00:00Z");
    assert.equal(handleProgressReminder(payload(root, sessionId, t0, "Bash"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 1_000, "Edit"), options), null);
    const reminder = handleProgressReminder(payload(root, sessionId, t0 + 10 * 60 * 1000, "mcp__other__report_session_progress"), options);
    assert.match(reminder.hookSpecificOutput.additionalContext, /progress reminder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production clock bounds future hook timestamps", async () => {
  const { root, data } = await fixture();
  try {
    const sessionId = "root-session";
    const t0 = Date.parse("2026-08-26T12:00:00Z");
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 60 * 60 * 1000, "Bash"), { dataDirectory: data, now: t0 }), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 1_000, "Edit"), { dataDirectory: data, now: t0 + 1_000 }), null);
    const reminder = handleProgressReminder(payload(root, sessionId, t0 + 10 * 60 * 1000, "Read"), { dataDirectory: data, now: t0 + 10 * 60 * 1000 });
    assert.match(reminder.hookSpecificOutput.additionalContext, /progress reminder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress report resets and clear suppresses until later activity", async () => {
  const { root, data } = await fixture();
  try {
    const sessionId = "root-session";
    const options = { dataDirectory: data };
    const t0 = Date.parse("2026-08-26T12:00:00Z");
    for (let i = 0; i < 3; i += 1) assert.equal(handleProgressReminder(payload(root, sessionId, t0 + i * 1000, "Bash"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 10 * 60 * 1000, "mcp__pomegr__report_session_progress"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 20 * 60 * 1000, "Bash"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 20 * 60 * 1000 + 1000, "mcp__pomegr__clear_session_progress"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 30 * 60 * 1000, "Bash"), options), null);
    assert.equal(handleProgressReminder(payload(root, sessionId, t0 + 40 * 60 * 1000, "Bash"), options), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old clear starts a fresh time epoch on the first later activity", async () => {
  const { root, data } = await fixture();
  try {
    const sessionId = "root-session";
    const options = { dataDirectory: data };
    const t0 = Date.parse("2026-08-26T12:00:00Z");
    assert.equal(handleProgressReminder(payload(root, sessionId, t0, "mcp__pomegr__clear_session_progress"), options), null);
    const first = t0 + 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      assert.equal(handleProgressReminder(payload(root, sessionId, first + i * 1000, "Bash"), options), null);
    }
    assert.equal(handleProgressReminder(payload(root, sessionId, first + 9 * 60 * 1000, "Read"), options), null);
    const reminder = handleProgressReminder(payload(root, sessionId, first + 10 * 60 * 1000, "Read"), options);
    assert.match(reminder.hookSpecificOutput.additionalContext, /progress reminder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
