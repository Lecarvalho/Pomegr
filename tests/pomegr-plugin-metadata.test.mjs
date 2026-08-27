import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  latestPomegrPluginMetadata,
  parsePomegrPluginMetadataText,
  pomegrPluginMetadataFromRecord,
  readLatestPomegrPluginMetadata,
} from "../monitor/providers/pomegr-plugin-metadata.mjs";

const marker = (version, policyStatus, policyVersion) => (
  `[Pomegr plugin metadata] ${JSON.stringify({ pluginVersion: version, policyStatus, policyVersion })}`
);

test("parses only bounded Pomegr plugin metadata", () => {
  assert.deepEqual(parsePomegrPluginMetadataText(marker("0.4.1", "valid", 7), "2026-08-26T12:00:00.000Z"), {
    status: "active",
    version: "0.4.1",
    policyStatus: "valid",
    policyVersion: 7,
    observedAt: "2026-08-26T12:00:00.000Z",
  });
  assert.equal(parsePomegrPluginMetadataText(marker("private-version", "valid", 7)), null);
  assert.equal(parsePomegrPluginMetadataText(marker("0.4.1", "private-status", 7)), null);
  assert.equal(parsePomegrPluginMetadataText(marker("0.4.1", "valid", 700)), null);
  assert.equal(parsePomegrPluginMetadataText("[Pomegr plugin metadata] not-json"), null);
});

test("accepts host metadata records and rejects user-authored lookalikes", () => {
  const metadata = marker("0.4.1", "missing", null);
  const claudeMeta = {
    type: "user",
    isMeta: true,
    timestamp: "2026-08-26T12:00:00.000Z",
    message: { role: "user", content: metadata },
  };
  const claudeAttachment = {
    type: "attachment",
    timestamp: "2026-08-26T12:00:01.000Z",
    attachment: {
      type: "hook_additional_context",
      hookName: "SessionStart",
      hookEvent: "SessionStart",
      content: [metadata],
    },
  };
  const claudeUser = { ...claudeMeta, isMeta: false };
  assert.equal(pomegrPluginMetadataFromRecord(claudeMeta, "claude")?.policyStatus, "missing");
  assert.equal(pomegrPluginMetadataFromRecord(claudeAttachment, "claude")?.version, "0.4.1");
  assert.equal(pomegrPluginMetadataFromRecord(claudeUser, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({ ...claudeMeta, type: "assistant" }, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({ ...claudeMeta, message: { role: "assistant", content: metadata } }, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({ type: "system", subtype: "away_summary", content: metadata }, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({ ...claudeAttachment, type: "user" }, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({
    ...claudeAttachment,
    attachment: { ...claudeAttachment.attachment, type: "hook_success", stdout: metadata },
  }, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({
    ...claudeAttachment,
    attachment: { ...claudeAttachment.attachment, hookName: "PreToolUse" },
  }, "claude"), null);
  assert.equal(pomegrPluginMetadataFromRecord({
    ...claudeAttachment,
    attachment: { ...claudeAttachment.attachment, hookEvent: "PreToolUse" },
  }, "claude"), null);

  const codexDeveloper = {
    type: "response_item",
    timestamp: "2026-08-26T12:01:00.000Z",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: metadata }] },
  };
  const codexUser = { ...codexDeveloper, payload: { ...codexDeveloper.payload, role: "user" } };
  assert.equal(pomegrPluginMetadataFromRecord(codexDeveloper, "codex")?.version, "0.4.1");
  assert.equal(pomegrPluginMetadataFromRecord(codexUser, "codex"), null);
  assert.equal(pomegrPluginMetadataFromRecord({ type: "turn_context", payload: { developer_instructions: metadata } }, "codex"), null);
});

test("keeps the latest recognized SessionStart observation", () => {
  const records = [
    {
      type: "turn_context",
      timestamp: "2026-08-26T12:00:00.000Z",
      payload: { developer_instructions: marker("0.4.0", "valid", 7) },
    },
    {
      type: "turn_context",
      timestamp: "2026-08-26T13:00:00.000Z",
      payload: { additional_context: marker("0.4.1", "invalid", 7) },
    },
  ];
  assert.deepEqual(latestPomegrPluginMetadata(records, "codex"), {
    status: "active",
    version: "0.4.1",
    policyStatus: "invalid",
    policyVersion: 7,
    observedAt: "2026-08-26T13:00:00.000Z",
  });
});

test("reads metadata without returning surrounding transcript content", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-plugin-metadata-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  await writeFile(file, `${JSON.stringify({
    type: "attachment",
    timestamp: "2026-08-26T12:00:00.000Z",
    attachment: {
      type: "hook_additional_context",
      hookName: "SessionStart",
      hookEvent: "SessionStart",
      content: [`${marker("0.4.1", "valid", 7)}\nPRIVATE_POLICY_TEXT_MUST_NOT_LEAK`],
    },
  })}\n`, "utf8");
  const result = await readLatestPomegrPluginMetadata(file, "claude");
  assert.equal(result.version, "0.4.1");
  assert.equal(JSON.stringify(result).includes("PRIVATE_POLICY_TEXT_MUST_NOT_LEAK"), false);

  await appendFile(file, `${JSON.stringify({
    type: "user",
    isMeta: true,
    timestamp: "2026-08-26T13:00:00.000Z",
    message: { role: "user", content: marker("0.4.2", "missing", null) },
  })}\n`, "utf8");
  const refreshed = await readLatestPomegrPluginMetadata(file, "claude");
  assert.equal(refreshed.version, "0.4.2");
  assert.equal(refreshed.policyStatus, "missing");

  const partialRecord = JSON.stringify({
    type: "user",
    isMeta: true,
    timestamp: "2026-08-26T14:00:00.000Z",
    message: { role: "user", content: marker("0.4.3", "valid", 7) },
  });
  const splitAt = Math.floor(partialRecord.length / 2);
  await appendFile(file, partialRecord.slice(0, splitAt), "utf8");
  assert.equal((await readLatestPomegrPluginMetadata(file, "claude")).version, "0.4.2");
  await appendFile(file, `${partialRecord.slice(splitAt)}\n`, "utf8");
  const completedPartial = await readLatestPomegrPluginMetadata(file, "claude");
  assert.equal(completedPartial.version, "0.4.3");
  assert.equal(completedPartial.policyStatus, "valid");
});
