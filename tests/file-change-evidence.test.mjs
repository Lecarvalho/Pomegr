import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundedFileChanges, buildActivityFeed } from "../monitor/activity-events.mjs";
import {
  claudeFileChangeCandidates,
  claudeToolOutcomes,
  firstSuccessfulClaudeToolOutcome,
} from "../monitor/providers/claude-tool-detail.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { parseCodexActivityRecords, parseCodexCanonicalTurns } from "../monitor/providers/codex-activity-events.mjs";
import { parseProviderSessionEvidence } from "../monitor/providers/provider-contract.mjs";
import { SessionObservationCheckpointStore } from "../monitor/session-observation-checkpoints.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
  readProviderJsonFixture,
} from "./helpers/provider-fixtures.mjs";

async function realTempDir(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// ---------------------------------------------------------------------------
// boundedFileChanges: the shared mapper both providers funnel through.
// ---------------------------------------------------------------------------

test("boundedFileChanges rebases absolute targets, drops forbidden shapes, and bounds/dedupes entries", async (t) => {
  const cwd = await realTempDir(t, "pomegr-file-change-bounded-");
  const forbiddenRoot = path.join(cwd, "private-root");

  assert.deepEqual(boundedFileChanges([
    { target: path.join(cwd, "src", "created.ts"), kind: "created" },
    { target: "src/edited.ts", kind: "edited" },
    { target: "src/edited.ts", kind: "edited" }, // duplicate (path, kind) dropped
  ], cwd), [
    { path: "src/created.ts", kind: "created", previousPath: null },
    { path: "src/edited.ts", kind: "edited", previousPath: null },
  ]);

  // Absolute target outside cwd.
  assert.equal(boundedFileChanges([{ target: path.join(os.tmpdir(), "outside.ts"), kind: "edited" }], cwd), null);
  // Traversal.
  assert.equal(boundedFileChanges([{ target: "../escape.ts", kind: "edited" }], cwd), null);
  // Win32 drive-relative.
  assert.equal(boundedFileChanges([{ target: "C:file.ts", kind: "edited" }], cwd), null);
  // Windows device name segment.
  assert.equal(boundedFileChanges([{ target: "src/CON", kind: "edited" }], cwd), null);
  // UNC-style.
  assert.equal(boundedFileChanges([{ target: "\\\\server\\share\\file.ts", kind: "edited" }], cwd), null);
  // Control character.
  assert.equal(boundedFileChanges([{ target: "src/\u0007file.ts", kind: "edited" }], cwd), null);
  // Monitor-private root segment.
  assert.equal(boundedFileChanges([{ target: ".claude/settings.json", kind: "edited" }], cwd), null);
  // Over the 512-char bound.
  assert.equal(boundedFileChanges([{ target: `src/${"a".repeat(510)}.ts`, kind: "edited" }], cwd), null);
  // Unrecognized kind.
  assert.equal(boundedFileChanges([{ target: "src/x.ts", kind: "renamed" }], cwd), null);
  // Explicit forbidden root (a transcript-style private location) even though it sits under cwd.
  assert.equal(boundedFileChanges([{ target: path.join(forbiddenRoot, "secret.ts"), kind: "edited" }], cwd, {
    forbiddenRoots: [forbiddenRoot],
  }), null);
  // No cwd at all: never throws, always degrades to null.
  assert.equal(boundedFileChanges([{ target: "src/x.ts", kind: "edited" }], null), null);

  // Moved: previousPath validated the same way; an invalid previous target drops the whole entry.
  assert.deepEqual(boundedFileChanges([{ target: "src/new.ts", kind: "moved", previousTarget: "src/old.ts" }], cwd), [
    { path: "src/new.ts", kind: "moved", previousPath: "src/old.ts" },
  ]);
  assert.equal(boundedFileChanges([{ target: "src/new.ts", kind: "moved", previousTarget: "../escape.ts" }], cwd), null);

  // Bounded at 64 entries.
  const many = Array.from({ length: 100 }, (_, index) => ({ target: `src/file-${index}.ts`, kind: "edited" }));
  assert.equal(boundedFileChanges(many, cwd).length, 64);
});

// ---------------------------------------------------------------------------
// Claude: candidate mapping and success-outcome gating.
// ---------------------------------------------------------------------------

test("claudeFileChangeCandidates maps Write/Edit/Bash to the right candidate kind", () => {
  assert.deepEqual(claudeFileChangeCandidates("Write", { file_path: "src/a.ts" }, { type: "create" }), [
    { target: "src/a.ts", kind: "created" },
  ]);
  assert.deepEqual(claudeFileChangeCandidates("Write", { file_path: "src/a.ts" }, { type: "update" }), [
    { target: "src/a.ts", kind: "edited" },
  ]);
  assert.deepEqual(claudeFileChangeCandidates("Write", { file_path: "src/a.ts" }, null), [
    { target: "src/a.ts", kind: "edited" },
  ]);
  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    assert.deepEqual(claudeFileChangeCandidates(tool, { file_path: "src/a.ts" }, {}), [
      { target: "src/a.ts", kind: "edited" },
    ]);
  }
  assert.deepEqual(claudeFileChangeCandidates("Bash", { command: "mv src/a.ts src/b.ts" }, {}), [
    { target: "src/b.ts", kind: "moved", previousTarget: "src/a.ts" },
  ]);
  assert.deepEqual(claudeFileChangeCandidates("Bash", { command: "mv -f src/a.ts src/b.ts" }, {}), []);
  assert.deepEqual(claudeFileChangeCandidates("Read", { file_path: "src/a.ts" }, {}), []);
});

test("claudeToolOutcomes only reports the first non-error result at or after a call's start", () => {
  const records = [
    { type: "user", timestamp: "2026-09-22T10:00:01.000Z", message: { content: [
      { type: "tool_result", tool_use_id: "ok", is_error: false },
    ] }, toolUseResult: { type: "create" } },
    { type: "user", timestamp: "2026-09-22T10:00:02.000Z", message: { content: [
      { type: "tool_result", tool_use_id: "failed", is_error: true },
    ] }, toolUseResult: {} },
  ];
  const outcomes = claudeToolOutcomes(records);
  const ok = firstSuccessfulClaudeToolOutcome(outcomes, "ok", "2026-09-22T10:00:00.000Z");
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.toolUseResult, { type: "create" });
  assert.equal(firstSuccessfulClaudeToolOutcome(outcomes, "failed", "2026-09-22T10:00:00.000Z"), null);
  assert.equal(firstSuccessfulClaudeToolOutcome(outcomes, "missing", "2026-09-22T10:00:00.000Z"), null);
  // A result recorded before the call started never counts as its outcome.
  assert.equal(firstSuccessfulClaudeToolOutcome(outcomes, "ok", "2026-09-22T10:05:00.000Z"), null);
});

function claudeAssistantToolUse(id, name, input, timestamp, cwd) {
  return { type: "assistant", timestamp, ...(cwd === undefined ? {} : { cwd }), message: { model: "claude-test", content: [{ type: "tool_use", id, name, input }] } };
}

/** Real Claude records carry the process cwd; give it to every record that has none. */
function withRecordCwd(records, cwd) {
  return records.map((record) => (Object.hasOwn(record, "cwd") ? record : { ...record, cwd }));
}

function claudeUserToolResult(id, { isError = false, toolUseResult = null, timestamp }) {
  return {
    type: "user",
    timestamp,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "TOOL_RESULT_MUST_NOT_LEAK", is_error: isError }] },
    toolUseResult,
  };
}

test("Claude adapter end-to-end: recognized file changes on success, none on failure or ambiguity or escape", async (t) => {
  const root = await realTempDir(t, "pomegr-claude-file-change-");
  const projectsRoot = path.join(root, "projects");
  const cwd = await realTempDir(t, "pomegr-claude-file-change-cwd-");
  const localId = "claude-file-change-fixture";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);

  const records = [
    { type: "user", timestamp: "2026-09-22T10:00:00.000Z", cwd, message: { content: "Fix the bug" } },
    claudeAssistantToolUse("write-created", "Write", { file_path: "src/created.ts", content: "x" }, "2026-09-22T10:00:01.000Z"),
    claudeUserToolResult("write-created", { toolUseResult: { type: "create" }, timestamp: "2026-09-22T10:00:01.500Z" }),
    claudeAssistantToolUse("write-edited", "Write", { file_path: "src/edited.ts", content: "y" }, "2026-09-22T10:00:02.000Z"),
    claudeUserToolResult("write-edited", { toolUseResult: { type: "update" }, timestamp: "2026-09-22T10:00:02.500Z" }),
    claudeAssistantToolUse("edit-1", "Edit", { file_path: "src/component.ts", old_string: "a", new_string: "b" }, "2026-09-22T10:00:03.000Z"),
    claudeUserToolResult("edit-1", { toolUseResult: {}, timestamp: "2026-09-22T10:00:03.500Z" }),
    claudeAssistantToolUse("bash-mv", "Bash", { command: "mv src/old-name.ts src/new-name.ts", description: "Rename" }, "2026-09-22T10:00:04.000Z"),
    claudeUserToolResult("bash-mv", { toolUseResult: {}, timestamp: "2026-09-22T10:00:04.500Z" }),
    claudeAssistantToolUse("bash-mv-failed", "Bash", { command: "mv src/oops.ts src/oops2.ts", description: "Rename" }, "2026-09-22T10:00:05.000Z"),
    claudeUserToolResult("bash-mv-failed", { isError: true, toolUseResult: {}, timestamp: "2026-09-22T10:00:05.500Z" }),
    claudeAssistantToolUse("bash-ambiguous", "Bash", { command: "mv -f src/a.ts src/b.ts", description: "Force move" }, "2026-09-22T10:00:06.000Z"),
    claudeUserToolResult("bash-ambiguous", { toolUseResult: {}, timestamp: "2026-09-22T10:00:06.500Z" }),
    claudeAssistantToolUse("write-outside", "Write", { file_path: path.join(os.tmpdir(), "outside-evil.ts"), content: "z" }, "2026-09-22T10:00:07.000Z"),
    claudeUserToolResult("write-outside", { toolUseResult: { type: "create" }, timestamp: "2026-09-22T10:00:07.500Z" }),
    // Bash keeps its directory across calls: after a separate `cd sub`, the record's cwd moves.
    claudeAssistantToolUse("bash-other-cwd", "Bash", { command: "touch a.txt", description: "Touch" }, "2026-09-22T10:00:08.000Z", path.join(cwd, "sub")),
    claudeUserToolResult("bash-other-cwd", { toolUseResult: {}, timestamp: "2026-09-22T10:00:08.500Z" }),
    claudeAssistantToolUse("bash-no-cwd", "Bash", { command: "touch b.txt", description: "Touch" }, "2026-09-22T10:00:09.000Z", null),
    claudeUserToolResult("bash-no-cwd", { toolUseResult: {}, timestamp: "2026-09-22T10:00:09.500Z" }),
    claudeAssistantToolUse("write-other-cwd", "Write", { file_path: path.join(cwd, "src", "abs.ts"), content: "w" }, "2026-09-22T10:00:10.000Z", path.join(cwd, "sub")),
    claudeUserToolResult("write-other-cwd", { toolUseResult: { type: "create" }, timestamp: "2026-09-22T10:00:10.500Z" }),
  ];
  await mkdir(path.dirname(mainFile), { recursive: true });
  await writeFile(mainFile, `${withRecordCwd(records, cwd).map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId, { historical: true });
  assert.equal(evidence.session.cwd, cwd);
  const byId = new Map(evidence.toolCalls.map((call) => [call.id, call]));

  assert.deepEqual(byId.get("write-created").fileChanges, [{ path: "src/created.ts", kind: "created", previousPath: null }]);
  assert.deepEqual(byId.get("write-edited").fileChanges, [{ path: "src/edited.ts", kind: "edited", previousPath: null }]);
  assert.deepEqual(byId.get("edit-1").fileChanges, [{ path: "src/component.ts", kind: "edited", previousPath: null }]);
  assert.deepEqual(byId.get("bash-mv").fileChanges, [{ path: "src/new-name.ts", kind: "moved", previousPath: "src/old-name.ts" }]);
  assert.equal(byId.get("bash-mv-failed").fileChanges, null, "a failed call records no file change");
  assert.equal(byId.get("bash-ambiguous").fileChanges, null, "an ambiguous mv command records no file change");
  assert.equal(byId.get("write-outside").fileChanges, null, "a target outside cwd is dropped");
  assert.equal(byId.get("bash-other-cwd").fileChanges, null, "a shell write run outside the session cwd records nothing");
  assert.equal(byId.get("bash-no-cwd").fileChanges, null, "a shell write with no recorded cwd records nothing");
  assert.deepEqual(byId.get("write-other-cwd").fileChanges, [{ path: "src/abs.ts", kind: "created", previousPath: null }],
    "structured writes with absolute targets are unaffected by the shell cwd gate");
  assertNoPrivateFixtureSentinels(evidence, "Claude file-change evidence");
});

test("Claude PowerShell tool call: recognized file changes on success, none on failure", async (t) => {
  const root = await realTempDir(t, "pomegr-claude-powershell-file-change-");
  const projectsRoot = path.join(root, "projects");
  const cwd = await realTempDir(t, "pomegr-claude-powershell-file-change-cwd-");
  const localId = "claude-powershell-file-change-fixture";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);

  const records = [
    { type: "user", timestamp: "2026-09-22T10:00:00.000Z", cwd, message: { content: "Rename the config" } },
    claudeAssistantToolUse("ps-rename", "PowerShell", {
      command: "Rename-Item -Path src/old.ts -NewName new.ts", description: "Rename",
    }, "2026-09-22T10:00:01.000Z"),
    claudeUserToolResult("ps-rename", { toolUseResult: {}, timestamp: "2026-09-22T10:00:01.500Z" }),
    claudeAssistantToolUse("ps-failed", "PowerShell", {
      command: "Remove-Item -Path src/oops.ts", description: "Delete",
    }, "2026-09-22T10:00:02.000Z"),
    claudeUserToolResult("ps-failed", { isError: true, toolUseResult: {}, timestamp: "2026-09-22T10:00:02.500Z" }),
    claudeAssistantToolUse("ps-ambiguous", "PowerShell", {
      command: "New-Item -Path src/ambiguous.ts", description: "Create without a type",
    }, "2026-09-22T10:00:03.000Z"),
    claudeUserToolResult("ps-ambiguous", { toolUseResult: {}, timestamp: "2026-09-22T10:00:03.500Z" }),
  ];
  await mkdir(path.dirname(mainFile), { recursive: true });
  await writeFile(mainFile, `${withRecordCwd(records, cwd).map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId, { historical: true });
  const byId = new Map(evidence.toolCalls.map((call) => [call.id, call]));

  assert.deepEqual(byId.get("ps-rename").fileChanges, [{ path: "src/new.ts", kind: "moved", previousPath: "src/old.ts" }]);
  assert.equal(byId.get("ps-failed").fileChanges, null, "a failed PowerShell call records no file change");
  assert.equal(byId.get("ps-ambiguous").fileChanges, null, "New-Item without -ItemType records no file change");
  assertNoPrivateFixtureSentinels(evidence, "Claude PowerShell file-change evidence");
});

// ---------------------------------------------------------------------------
// Codex: apply_patch headers and canonical fileChange items.
// ---------------------------------------------------------------------------

const ACTOR = { id: "primary", label: "Primary agent" };
const STARTED_SECONDS = Date.parse("2026-09-22T11:00:00.000Z") / 1000;
const COMPLETED_SECONDS = Date.parse("2026-09-22T11:00:02.000Z") / 1000;

const APPLY_PATCH_TEXT = [
  "*** Begin Patch",
  "*** Add File: src/created.ts",
  "+export const created = true;",
  "*** Update File: src/edited.ts",
  "@@",
  "-old",
  "+new",
  "*** Update File: src/renamed-from.ts",
  "*** Move to: src/renamed-to.ts",
  "@@",
  "-old",
  "+new",
  "*** Delete File: src/deleted.ts",
  "*** End Patch",
].join("\n");

test("Codex apply_patch headers become created/edited/moved/deleted only for a completed call", async (t) => {
  const cwd = await realTempDir(t, "pomegr-codex-file-change-");
  const forbiddenRoot = path.join(os.tmpdir(), "codex-home-fixture");

  const succeeded = parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "response_item", payload: {
      type: "function_call", name: "apply_patch", call_id: "patch-ok", arguments: JSON.stringify({ patch: APPLY_PATCH_TEXT }),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "response_item", payload: {
      type: "function_call_output", call_id: "patch-ok", output: "PRIVATE_OUTPUT_MUST_NOT_LEAK",
    } },
  ], { actor: ACTOR, sourceKey: "apply-patch-ok", cwd, forbiddenRoots: [forbiddenRoot] });
  assert.equal(succeeded[0].status, "completed");
  assert.deepEqual(succeeded[0].fileChanges, [
    { path: "src/created.ts", kind: "created", previousPath: null },
    { path: "src/edited.ts", kind: "edited", previousPath: null },
    { path: "src/renamed-to.ts", kind: "moved", previousPath: "src/renamed-from.ts" },
    { path: "src/deleted.ts", kind: "deleted", previousPath: null },
  ]);
  assert.equal(Object.hasOwn(succeeded[0], "fileChangeCandidates"), false, "the private working field never survives sealing");
  assertNoPrivateFixtureSentinels(succeeded, "Codex apply_patch success");

  const failed = parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "response_item", payload: {
      type: "function_call", name: "apply_patch", call_id: "patch-failed", arguments: JSON.stringify({ patch: APPLY_PATCH_TEXT }),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "response_item", payload: {
      type: "function_call_output", call_id: "patch-failed", output: "PRIVATE_OUTPUT_MUST_NOT_LEAK", is_error: true,
    } },
  ], { actor: ACTOR, sourceKey: "apply-patch-failed", cwd, forbiddenRoots: [forbiddenRoot] });
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].fileChanges, null, "a failed apply_patch records no file change");

  const noCwd = parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "response_item", payload: {
      type: "function_call", name: "apply_patch", call_id: "patch-no-cwd", arguments: JSON.stringify({ patch: APPLY_PATCH_TEXT }),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "response_item", payload: {
      type: "function_call_output", call_id: "patch-no-cwd", output: "PRIVATE_OUTPUT_MUST_NOT_LEAK",
    } },
  ], { actor: ACTOR, sourceKey: "apply-patch-no-cwd" });
  assert.equal(noCwd[0].status, "completed");
  assert.equal(noCwd[0].fileChanges, null, "without a cwd, evidence degrades to null instead of throwing");
});

test("Codex shell/exec command items record file changes only for a completed call with exit code 0", async (t) => {
  const cwd = await realTempDir(t, "pomegr-codex-shell-file-change-");
  const forbiddenRoot = path.join(os.tmpdir(), "codex-home-fixture");

  const shellCall = (callId, { exitCode, isError = false } = {}) => parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "response_item", payload: {
      type: "function_call", name: "shell_command", call_id: callId,
      arguments: JSON.stringify({ command: "mv src/old.ts src/new.ts", description: "Rename" }),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "response_item", payload: {
      type: "function_call_output", call_id: callId, output: "PRIVATE_OUTPUT_MUST_NOT_LEAK",
      ...(exitCode === undefined ? {} : { exit_code: exitCode }), ...(isError ? { is_error: true } : {}),
    } },
  ], { actor: ACTOR, sourceKey: `shell-${callId}`, cwd, forbiddenRoots: [forbiddenRoot] });

  const zeroExit = shellCall("shell-exit-0", { exitCode: 0 });
  assert.equal(zeroExit[0].status, "completed");
  assert.deepEqual(zeroExit[0].fileChanges, [{ path: "src/new.ts", kind: "moved", previousPath: "src/old.ts" }]);
  assert.equal(Object.hasOwn(zeroExit[0], "fileChangeCandidates"), false, "the private working field never survives sealing");
  assert.equal(Object.hasOwn(zeroExit[0], "exitCode"), false, "the private exit-code field never survives sealing");
  assertNoPrivateFixtureSentinels(zeroExit, "Codex shell command success");

  const nonZeroExit = shellCall("shell-exit-1", { exitCode: 1 });
  assert.equal(nonZeroExit[0].status, "completed");
  assert.equal(nonZeroExit[0].fileChanges, null, "a non-zero exit code records no file change even though the call completed");

  const unknownExit = shellCall("shell-exit-unknown");
  assert.equal(unknownExit[0].fileChanges, null, "a missing exit code records no file change (fail closed)");

  const failedCall = shellCall("shell-exit-failed", { isError: true });
  assert.equal(failedCall[0].status, "failed");
  assert.equal(failedCall[0].fileChanges, null, "a failed shell call records no file change");
});

test("Codex shell writes record nothing when the command ran outside the session cwd", async (t) => {
  const cwd = await realTempDir(t, "pomegr-codex-shell-cwd-");
  const shellCall = (callId, args) => parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "response_item", payload: {
      type: "function_call", name: "shell_command", call_id: callId, arguments: JSON.stringify({ command: "touch a.txt", ...args }),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "response_item", payload: {
      type: "function_call_output", call_id: callId, output: "PRIVATE_OUTPUT_MUST_NOT_LEAK", exit_code: 0,
    } },
  ], { actor: ACTOR, sourceKey: `shell-cwd-${callId}`, cwd });

  assert.deepEqual(shellCall("same", { workdir: cwd })[0].fileChanges, [{ path: "a.txt", kind: "edited", previousPath: null }]);
  assert.deepEqual(shellCall("dot", { workdir: "." })[0].fileChanges, [{ path: "a.txt", kind: "edited", previousPath: null }]);
  assert.equal(shellCall("sub", { workdir: path.join(cwd, "sub") })[0].fileChanges, null);
  assert.equal(shellCall("relative-sub", { workdir: "sub" })[0].fileChanges, null);
  assert.equal(shellCall("bogus", { workdir: 42 })[0].fileChanges, null);

  const execEvents = parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "event_msg", payload: {
      type: "exec_command_begin", call_id: "exec-sub", command: ["touch", "a.txt"], cwd: path.join(cwd, "sub"),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "event_msg", payload: { type: "exec_command_end", call_id: "exec-sub", exit_code: 0 } },
  ], { actor: ACTOR, sourceKey: "exec-sub", cwd });
  assert.equal(execEvents[0].fileChanges, null, "exec_command_begin cwd outside the session cwd records nothing");
  assert.equal(Object.hasOwn(execEvents[0], "shellCwd"), false, "the private cwd field never survives sealing");
});

test("Codex keeps an exec_command_end exit code when a later function_call_output has none", async (t) => {
  const cwd = await realTempDir(t, "pomegr-codex-shell-exit-merge-");
  const calls = parseCodexActivityRecords([
    { timestamp: "2026-09-22T11:00:00.000Z", type: "response_item", payload: {
      type: "function_call", name: "shell_command", call_id: "merged", arguments: JSON.stringify({ command: "touch a.txt" }),
    } },
    { timestamp: "2026-09-22T11:00:01.000Z", type: "event_msg", payload: { type: "exec_command_end", call_id: "merged", exit_code: 0 } },
    { timestamp: "2026-09-22T11:00:01.100Z", type: "response_item", payload: {
      type: "function_call_output", call_id: "merged", output: "PRIVATE_OUTPUT_MUST_NOT_LEAK",
    } },
  ], { actor: ACTOR, sourceKey: "exit-merge", cwd });
  const merged = calls.find((call) => call.tool === "Shell");
  assert.deepEqual(merged.fileChanges, [{ path: "a.txt", kind: "edited", previousPath: null }]);
  assertNoPrivateFixtureSentinels(calls, "Codex exit-code merge");
});

test("Codex canonical fileChange items map add/update/delete kinds and ignore unrecognized ones", async (t) => {
  const cwd = await realTempDir(t, "pomegr-codex-canonical-file-change-");
  const turns = [{
    id: "turn-file-changes",
    status: "completed",
    startedAt: STARTED_SECONDS,
    completedAt: COMPLETED_SECONDS,
    items: [{
      id: "change",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/created.ts", kind: { type: "add" } },
        { path: "src/edited.ts", kind: { type: "update" } },
        { path: "src/deleted.ts", kind: { type: "delete" } },
        { path: "src/unrecognized.ts", kind: { type: "rename" } },
      ],
    }],
  }];
  const calls = parseCodexCanonicalTurns(turns, { actor: ACTOR, cwd, forbiddenRoots: [] });
  assert.deepEqual(calls[0].fileChanges, [
    { path: "src/created.ts", kind: "created", previousPath: null },
    { path: "src/edited.ts", kind: "edited", previousPath: null },
    { path: "src/deleted.ts", kind: "deleted", previousPath: null },
  ]);
  assertNoPrivateFixtureSentinels(calls, "Codex canonical file-change evidence");

  // The current app-server caller does not thread cwd through; confirm that
  // absence degrades to null rather than resolving against the wrong root.
  const withoutCwd = parseCodexCanonicalTurns(turns, { actor: ACTOR });
  assert.equal(withoutCwd[0].fileChanges, null);
});

// ---------------------------------------------------------------------------
// provider-contract: schema accepts a valid fileChanges shape, rejects the rest.
// ---------------------------------------------------------------------------

test("provider contract accepts bounded fileChanges and rejects malformed shapes", async () => {
  const fixture = await readProviderJsonFixture("claude/expected-session-evidence.json");
  fixture.toolCalls[0].fileChanges = [
    { path: "src/edited.ts", kind: "edited", previousPath: null },
    { path: "src/renamed-to.ts", kind: "moved", previousPath: "src/renamed-from.ts" },
  ];
  const parsed = parseProviderSessionEvidence(fixture);
  assert.deepEqual(parsed.toolCalls[0].fileChanges, fixture.toolCalls[0].fileChanges);

  for (const invalid of [
    [{ path: "src/a.ts", kind: "renamed", previousPath: null }], // unrecognized kind
    [{ path: "src/a.ts", kind: "edited", previousPath: null, extra: true }], // strict object
    [{ path: "src/a.ts", kind: "moved" }], // previousPath required (even if null)
    Array.from({ length: 65 }, () => ({ path: "src/a.ts", kind: "edited", previousPath: null })), // over 64
    [{ path: "a\nb", kind: "edited", previousPath: null }], // not one-line
  ]) {
    const invalidFixture = structuredClone(fixture);
    invalidFixture.toolCalls[0].fileChanges = invalid;
    assert.throws(() => parseProviderSessionEvidence(invalidFixture), /Invalid|Unrecognized|enum|received|Too big|unrecognized|bounded one-line/i);
  }
});

// ---------------------------------------------------------------------------
// fileChanges never reaches browser-facing projections.
// ---------------------------------------------------------------------------

test("fileChanges never crosses into activity feeds, session projections, or /api/state-shaped output", async () => {
  const fixture = await readProviderJsonFixture("claude/expected-session-evidence.json");
  fixture.toolCalls[0].fileChanges = [
    { path: "src/PRIVATE_PATH_SHOULD_NOT_LEAK.ts", kind: "edited", previousPath: null },
  ];
  const evidence = parseProviderSessionEvidence(fixture);

  const feed = buildActivityFeed({ toolCalls: evidence.toolCalls });
  assert.doesNotMatch(JSON.stringify(feed), /fileChanges|PRIVATE_PATH_SHOULD_NOT_LEAK/);

  const state = monitorStateFromProviderEvidence("claude", evidence);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /fileChanges|PRIVATE_PATH_SHOULD_NOT_LEAK/);
});

// ---------------------------------------------------------------------------
// Checkpoint persistence: retains valid evidence, rejects every forbidden path shape.
// ---------------------------------------------------------------------------

function checkpointSnapshot(evidence, revision = 1) {
  return {
    providerId: "claude",
    localSessionId: "file-change-checkpoint-fixture",
    evidence,
    readiness: { core: "ready" },
    revision,
    observedAt: "2026-09-22T12:00:00.000Z",
    source: { fingerprint: "safe-fingerprint", completeOffset: 1 },
  };
}

test("checkpoints persist valid fileChanges and reject every forbidden path shape", async (t) => {
  const directory = await realTempDir(t, "pomegr-file-change-checkpoints-");
  const checkpoints = new SessionObservationCheckpointStore({ directory });

  const validEvidence = { toolCalls: [{
    id: "call-1",
    fileChanges: [
      { path: "src/edited.ts", kind: "edited", previousPath: null },
      { path: "src/renamed-to.ts", kind: "moved", previousPath: "src/renamed-from.ts" },
    ],
  }] };
  await checkpoints.write(checkpointSnapshot(validEvidence, 1));
  const loaded = await checkpoints.load();
  assert.equal(loaded.ignored, 0);
  assert.deepEqual(loaded.records[0].evidence.toolCalls[0].fileChanges, validEvidence.toolCalls[0].fileChanges);

  const badPaths = [
    "/etc/passwd",
    "C:/private/file.ts",
    "C:file.ts",
    "\\\\server\\share\\file.ts",
    "..\\escape.ts",
    "../escape.ts",
    "./file.ts",
    "src\\file.ts",
    "src/\u0007file.ts",
    ".claude/settings.json",
    ".codex/config.json",
    `src/${"a".repeat(510)}.ts`,
  ];
  for (const badPath of badPaths) {
    const evidence = { toolCalls: [{ id: "bad", fileChanges: [{ path: badPath, kind: "edited", previousPath: null }] }] };
    await assert.rejects(checkpoints.write(checkpointSnapshot(evidence, 2)), /checkpoint/, badPath);
  }
  // A non-moved kind may never carry a previousPath.
  const misusedPrevious = { toolCalls: [{
    id: "bad-previous", fileChanges: [{ path: "src/ok.ts", kind: "edited", previousPath: "src/other.ts" }],
  }] };
  await assert.rejects(checkpoints.write(checkpointSnapshot(misusedPrevious, 3)), /checkpoint/);
  // A moved kind's previousPath is validated the same way as path.
  const badMovePrevious = { toolCalls: [{
    id: "bad-move", fileChanges: [{ path: "src/ok.ts", kind: "moved", previousPath: "../escape.ts" }],
  }] };
  await assert.rejects(checkpoints.write(checkpointSnapshot(badMovePrevious, 4)), /checkpoint/);

  const afterRejections = await checkpoints.load();
  assert.equal(afterRejections.records[0].revision, 1, "no rejected candidate ever replaced the valid checkpoint");
});
