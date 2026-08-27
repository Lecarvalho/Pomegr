import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePomegrDataRoot } from "../../shared/pomegr-paths.mjs";
import { applyWaitingStatus } from "../agent-metadata.mjs";
import { parseCodexCurrentActivityRecords } from "./codex-current-activity.mjs";
import { codexTimestamp, isSafeCodexSessionId } from "./codex-session-metadata.mjs";

export const CODEX_ACTIVE_WINDOW_MS = 15_000;
export const CODEX_ROLLOUT_LIVE_WINDOW_MS = 120_000;
export const CODEX_BRIDGE_HEARTBEAT_MS = 15_000;
export const CODEX_BRIDGE_LEASE_MS = 45_000;
export const CODEX_NEEDS_INPUT_MAX_MS = 30 * 60_000;
export const CODEX_ROLLOUT_APPROVAL_GRACE_MS = 5_000;
export const CODEX_LIVENESS_CACHE_MS = 1_500;
export const CODEX_LIVENESS_MAX_TAIL_BYTES = 128 * 1024;
export const CODEX_LIVENESS_MAX_TAIL_RECORDS = 256;
export const CODEX_LIVENESS_MAX_BRIDGE_FILES = 500;
const CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS = 2_000;
const CODEX_LIVENESS_MAX_COLD_ROLLOUTS = 16;

const SAFE_LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_PROCESS_START_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9.:+-]{0,79}$/;
const TERMINAL_BRIDGE_STATES = new Set(["ended", "finished", "stopped", "interrupted"]);
const BRIDGE_STATES = new Set(["idle", "active", "needs_input", "ended", "finished", "stopped", "interrupted", "system_error"]);
const BRIDGE_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
]);

function timestampValue(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function safeId(value) {
  return typeof value === "string" && SAFE_LOCAL_ID.test(value) ? value : null;
}

function safeTurnId(value) {
  return typeof value === "string" && SAFE_TURN_ID.test(value) ? value : null;
}

function normalizedProcessStartIdentity(value) {
  const identity = String(value ?? "").trim();
  return SAFE_PROCESS_START_IDENTITY.test(identity) ? identity : null;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function boundedFiles(directory, suffix, maximum) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
    .slice(0, maximum)
    .map((entry) => entry.file);
}

function snapshotFile(root, sessionId, actorId) {
  return path.join(root, "snapshots", `${hash(`${sessionId}\0${actorId}`)}.json`);
}

function leaseFile(root, ownerPid, ownerStartedAt) {
  return path.join(root, "leases", `${ownerPid}-${hash(ownerStartedAt)}.json`);
}

export function resolveCodexLivenessRoot(options = {}) {
  const environment = options.env ?? process.env;
  return path.resolve(options.root || environment.POMEGR_CODEX_LIVENESS_DIR || path.join(
    resolvePomegrDataRoot({ environment, homeDir: options.homeDir || os.homedir(), platform: options.platform }),
    "codex-liveness",
  ));
}

export function processStartIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof options.processStartIdentity === "function") {
    return normalizedProcessStartIdentity(options.processStartIdentity(pid));
  }
  try {
    if ((options.platform || process.platform) === "win32") {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`;
      const value = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      }).trim();
      return normalizedProcessStartIdentity(value);
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
    return normalizedProcessStartIdentity(/^\d+$/.test(fields[19] || "") ? `proc-${fields[19]}` : null);
  } catch {
    return null;
  }
}

function processAncestors(startingPid, options = {}) {
  if (!Number.isInteger(startingPid) || startingPid <= 0) return [];
  try {
    if ((options.platform || process.platform) === "win32") {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PomegrParentProcess {
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returned);
  public static int GetParentProcessId(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return 0;
    try {
      PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
      int returned;
      return NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out returned) == 0
        ? info.InheritedFromUniqueProcessId.ToInt32()
        : 0;
    } finally { CloseHandle(handle); }
  }
}
'@ | Out-Null
$current = ${startingPid}
$items = @()
for ($index = 0; $index -lt 12 -and $current -gt 0; $index++) {
  $item = Get-Process -Id $current -ErrorAction SilentlyContinue
  if ($null -eq $item) { break }
  $started = $item.StartTime
  if ($null -eq $started) { break }
  $parent = [PomegrParentProcess]::GetParentProcessId($current)
  $items += [pscustomobject]@{ pid = [int]$item.Id; parentPid = [int]$parent; name = [string]$item.ProcessName; startedAt = $started.ToUniversalTime().ToFileTimeUtc().ToString() }
  $current = [int]$parent
}
$items | ConvertTo-Json -Compress
`;
      const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      }).trim();
      const parsed = JSON.parse(output || "[]");
      return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => (
        Number.isInteger(item?.pid) && item.pid > 0 && normalizedProcessStartIdentity(item.startedAt)
          ? [{ pid: item.pid, parentPid: Number(item.parentPid) || 0, name: String(item.name || ""), startedAt: normalizedProcessStartIdentity(item.startedAt) }]
          : []
      ));
    }
    const ancestors = [];
    let current = startingPid;
    for (let index = 0; index < 12 && current > 0; index += 1) {
      const stat = fs.readFileSync(`/proc/${current}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
      const parentPid = Number(fields[1]);
      const startedAt = normalizedProcessStartIdentity(/^\d+$/.test(fields[19] || "") ? `proc-${fields[19]}` : null);
      const name = fs.readFileSync(`/proc/${current}/comm`, "utf8").trim();
      if (!startedAt) break;
      ancestors.push({ pid: current, parentPid: Number.isInteger(parentPid) ? parentPid : 0, name, startedAt });
      current = Number.isInteger(parentPid) ? parentPid : 0;
    }
    return ancestors;
  } catch {
    return [];
  }
}

export function codexOwnerIdentity(options = {}) {
  const environment = options.env ?? process.env;
  const configuredPid = Number(environment.POMEGR_CODEX_OWNER_PID);
  const startingPid = Number.isInteger(configuredPid) && configuredPid > 0
    ? configuredPid
    : Number.isInteger(options.startingPid) && options.startingPid > 0 ? options.startingPid : process.ppid;
  const ancestors = processAncestors(startingPid, options);
  const owner = ancestors.find((item) => /^(?:codex|chatgpt)(?:\.exe)?$/i.test(item.name)) || ancestors[0];
  if (owner) return { ownerPid: owner.pid, ownerStartedAt: owner.startedAt };
  const ownerStartedAt = processStartIdentity(startingPid, options);
  return ownerStartedAt ? { ownerPid: startingPid, ownerStartedAt } : null;
}

function normalizedToolName(value) {
  if (typeof value !== "string") return "";
  return value.split(/[.:/]/).at(-1)?.trim().toLowerCase() || "";
}

function transitionForHook(input, previous) {
  const event = input.hook_event_name;
  const turnId = safeTurnId(input.turn_id);
  const sameTurn = !previous?.turnId || !turnId || previous.turnId === turnId;
  const toolName = normalizedToolName(input.tool_name);
  if (event === "SessionStart") return { state: "idle", requestKind: null };
  // Codex can emit SessionEnd after a completed turn while the conversation
  // remains open and ready for another user message. The owner lease (or
  // archival) is the durable close boundary; this event only clears turn-local
  // activity and pending-input state.
  if (event === "SessionEnd") return { state: "idle", requestKind: null };
  if (event === "SubagentStart") return { state: "active", requestKind: null };
  if (event === "SubagentStop") return { state: "finished", requestKind: null };
  if (event === "UserPromptSubmit") return { state: "active", requestKind: null };
  if (event === "PermissionRequest") return { state: "needs_input", requestKind: "approval" };
  if (event === "PreToolUse" && toolName === "request_user_input") {
    return { state: "needs_input", requestKind: "user_input" };
  }
  if (event === "Stop") return { state: "idle", requestKind: null };
  if (["PreToolUse", "PostToolUse"].includes(event)) {
    return sameTurn || previous?.lifecycle !== "needs_input"
      ? { state: "active", requestKind: null }
      : { state: previous.lifecycle, requestKind: previous.requestKind };
  }
  return null;
}

function currentLease(root, ownerPid, ownerStartedAt, nowMs) {
  const file = leaseFile(root, ownerPid, ownerStartedAt);
  const previous = readJson(file);
  if (previous?.version === 1
    && previous.ownerPid === ownerPid
    && previous.ownerStartedAt === ownerStartedAt
    && typeof previous.bridgeInstance === "string"
    && /^[a-f0-9]{32}$/.test(previous.bridgeInstance)
    && timestampValue(previous.expiresAt) > nowMs) {
    return { file, value: previous, reused: true };
  }
  return {
    file,
    value: {
      version: 1,
      provider: "codex",
      ownerPid,
      ownerStartedAt,
      bridgeInstance: crypto.randomBytes(16).toString("hex"),
      observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + CODEX_BRIDGE_LEASE_MS).toISOString(),
    },
    reused: false,
  };
}

function currentLeaseForPid(root, ownerPid, nowMs) {
  for (const file of boundedFiles(path.join(root, "leases"), ".json", 64)) {
    const lease = readJson(file);
    if (lease?.version === 1
      && lease.provider === "codex"
      && lease.ownerPid === ownerPid
      && normalizedProcessStartIdentity(lease.ownerStartedAt)
      && /^[a-f0-9]{32}$/.test(lease.bridgeInstance || "")
      && timestampValue(lease.expiresAt) > nowMs) return lease;
  }
  return null;
}

function launchOwnerWatcher({ root, ownerPid, ownerStartedAt, bridgeInstance }) {
  const watcher = fileURLToPath(new URL("../../scripts/codex-lifecycle-owner.mjs", import.meta.url));
  const child = spawn(process.execPath, [
    watcher,
    "--root", root,
    "--pid", String(ownerPid),
    "--started-at", ownerStartedAt,
    "--instance", bridgeInstance,
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function captureCodexLifecycleHook(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const sessionId = safeId(input.session_id);
  const agentId = ["SubagentStart", "SubagentStop"].includes(event) ? safeId(input.agent_id) : null;
  if (!BRIDGE_EVENTS.has(event) || !sessionId || (["SubagentStart", "SubagentStop"].includes(event) && !agentId)) return null;
  const actorId = agentId || sessionId;
  const root = resolveCodexLivenessRoot(options);
  const file = snapshotFile(root, sessionId, actorId);
  const previous = readJson(file);
  const transition = transitionForHook(input, previous);
  if (!transition) return null;
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number.isFinite(options.now) ? options.now : Date.now();
  const rootSnapshot = agentId ? readJson(snapshotFile(root, sessionId, sessionId)) : null;
  const hintedOwner = [previous, rootSnapshot].find((value) => (
    Number.isInteger(value?.ownerPid) && value.ownerPid > 0 && normalizedProcessStartIdentity(value.ownerStartedAt)
  ));
  const existingOwner = hintedOwner ? currentLeaseForPid(root, hintedOwner.ownerPid, nowMs) : null;
  const configuredOwnerStartedAt = normalizedProcessStartIdentity(options.ownerStartedAt);
  const discoveredOwner = Number.isInteger(options.ownerPid) && options.ownerPid > 0 && configuredOwnerStartedAt
    ? { ownerPid: options.ownerPid, ownerStartedAt: configuredOwnerStartedAt }
    : existingOwner && existingOwner.ownerStartedAt === hintedOwner?.ownerStartedAt
      ? { ownerPid: existingOwner.ownerPid, ownerStartedAt: existingOwner.ownerStartedAt }
      : codexOwnerIdentity(options);
  if (!discoveredOwner) return null;
  const { ownerPid, ownerStartedAt } = discoveredOwner;
  const lease = currentLease(root, ownerPid, ownerStartedAt, nowMs);
  lease.value.observedAt = new Date(nowMs).toISOString();
  lease.value.expiresAt = new Date(nowMs + CODEX_BRIDGE_LEASE_MS).toISOString();
  atomicWriteJson(lease.file, lease.value);
  const snapshot = {
    version: 1,
    provider: "codex",
    sessionId,
    turnId: safeTurnId(input.turn_id),
    agentId,
    lifecycle: transition.state,
    requestKind: transition.requestKind,
    observedAt: new Date(nowMs).toISOString(),
    sequence: Number.isSafeInteger(previous?.sequence) ? previous.sequence + 1 : 1,
    ownerPid,
    ownerStartedAt,
    bridgeInstance: lease.value.bridgeInstance,
  };
  atomicWriteJson(file, snapshot);
  if (!lease.reused && event !== "SessionEnd" && options.startWatcher !== false) {
    try { (options.launchWatcher || launchOwnerWatcher)({ root, ownerPid, ownerStartedAt, bridgeInstance: lease.value.bridgeInstance }); } catch {
      // A missing watcher simply bounds the bridge evidence to the initial lease.
    }
  }
  return snapshot;
}

export function renewCodexOwnerLease(options = {}) {
  const root = resolveCodexLivenessRoot(options);
  const ownerPid = Number(options.ownerPid);
  const ownerStartedAt = normalizedProcessStartIdentity(options.ownerStartedAt);
  const bridgeInstance = options.bridgeInstance;
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !ownerStartedAt || !/^[a-f0-9]{32}$/.test(bridgeInstance || "")) return false;
  if (processStartIdentity(ownerPid, options) !== ownerStartedAt) return false;
  const file = leaseFile(root, ownerPid, ownerStartedAt);
  const lease = readJson(file);
  if (lease?.ownerPid !== ownerPid || lease?.ownerStartedAt !== ownerStartedAt || lease?.bridgeInstance !== bridgeInstance) return false;
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  atomicWriteJson(file, {
    ...lease,
    observedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + CODEX_BRIDGE_LEASE_MS).toISOString(),
  });
  return true;
}

function readBoundedTail(file, maximumBytes) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { key: null, records: [] }; }
  if (!stat.isFile() || stat.size <= 0) return { key: `${stat.size}:${stat.mtimeMs}`, records: [] };
  const bytes = Math.min(stat.size, maximumBytes);
  const buffer = Buffer.alloc(bytes);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, buffer, 0, bytes, Math.max(0, stat.size - bytes));
  } catch {
    return { key: null, records: [] };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let text = buffer.toString("utf8");
  if (stat.size > bytes) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  const records = [];
  for (const line of text.split(/\r?\n/).slice(-CODEX_LIVENESS_MAX_TAIL_RECORDS)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // A truncated final write is retried after the file stat changes.
    }
  }
  return { key: `${stat.size}:${stat.mtimeMs}`, records };
}

function recordTimestamp(record) {
  return codexTimestamp(record?.timestamp ?? record?.payload?.timestamp ?? record?.message?.timestamp);
}

function recordTurnId(record) {
  return safeTurnId(record?.turn_id ?? record?.turnId ?? record?.payload?.turn_id ?? record?.payload?.turnId);
}

function callId(payload) {
  const value = payload?.call_id ?? payload?.callId ?? payload?.id;
  return typeof value === "string" && value.length <= 192 ? value : null;
}

function isAssistantFinalMessage(payload) {
  return payload?.type === "message" && payload.role === "assistant" && payload.phase === "final_answer";
}

function isWrappedProposedPlan(payload) {
  if (!isAssistantFinalMessage(payload)) return false;
  const output = Array.isArray(payload.content)
    ? payload.content.filter((item) => item?.type === "output_text" && typeof item.text === "string")
    : [];
  return output.some((item) => /<proposed_plan>[\s\S]*<\/proposed_plan>/i.test(item.text));
}

function isPlanModeTurn(payload) {
  return (payload?.collaboration_mode?.mode ?? payload?.collaborationMode?.mode) === "plan";
}

function isPendingFileEditCall(payload) {
  if (!["function_call", "custom_tool_call"].includes(payload?.type)) return false;
  const name = normalizedToolName(payload.name);
  if (name === "apply_patch") return true;
  if (name !== "exec" || typeof payload.input !== "string") return false;
  return /(?:^|[^\w$])tools\s*\.\s*apply_patch\s*\(/.test(payload.input);
}

export function isActiveCodexWriterLock(file, options = {}) {
  if ((options.platform || process.platform) !== "win32") return false;
  const statFileSync = options.statFileSync || fs.statSync;
  const openFileSync = options.openFileSync || fs.openSync;
  const closeFileSync = options.closeFileSync || fs.closeSync;
  try {
    if (!statFileSync(file).isFile()) return false;
  } catch {
    return false;
  }
  let descriptor;
  try {
    descriptor = openFileSync(file, "r+");
    return false;
  } catch (error) {
    return ["EBUSY", "EACCES", "EPERM"].includes(error?.code);
  } finally {
    if (descriptor !== undefined) closeFileSync(descriptor);
  }
}

function rolloutTerminalStatus(record) {
  const type = String(record?.type || "").toLowerCase().replaceAll("_", "");
  const payloadType = String(record?.payload?.type || "").toLowerCase().replaceAll("_", "");
  const status = String(record?.payload?.turn?.status ?? record?.payload?.status ?? "").toLowerCase();
  if (["turncompleted", "turn/completed"].includes(type)) {
    if (status === "interrupted") return "interrupted";
    if (["failed", "systemerror", "error"].includes(status)) return "system_error";
    if (status === "completed") return "idle";
  }
  if (["turnaborted", "turninterrupted"].includes(payloadType)) return "interrupted";
  if (["turnerror", "streamerror"].includes(payloadType)) return "system_error";
  if (["turncomplete", "taskcomplete"].includes(payloadType)) return "idle";
  return null;
}

export function parseCodexRolloutLiveness(records, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const allowPendingFileEdit = options.allowPendingFileEdit !== false;
  const pending = new Map();
  const pendingFileEdits = new Map();
  let planModeTurn = false;
  let planConfirmation = null;
  let latest = null;
  let terminal = null;
  for (const record of Array.isArray(records) ? records : []) {
    const timestamp = recordTimestamp(record);
    if (!timestamp) continue;
    const payload = record?.payload;
    const recognized = ["session_meta", "turn_context", "response_item", "event_msg", "turn_started", "turn_completed", "turn/started", "turn/completed"].includes(record.type);
    if (!recognized) continue;
    if (!latest || timestampValue(timestamp) >= timestampValue(latest.timestamp)) latest = { timestamp, turnId: recordTurnId(record) };
    const observedTerminal = rolloutTerminalStatus(record);
    if (observedTerminal) {
      terminal = { status: observedTerminal, timestamp };
      pending.clear();
      pendingFileEdits.clear();
    }
    if (record.type === "turn_context") {
      planConfirmation = null;
      planModeTurn = isPlanModeTurn(payload);
      pending.clear();
      pendingFileEdits.clear();
    } else if (record.type === "event_msg" && ["user_message", "user_prompt"].includes(payload?.type)) {
      planConfirmation = null;
      pending.clear();
      pendingFileEdits.clear();
    }
    if (record.type !== "response_item" || !payload || typeof payload !== "object") continue;
    if (payload.type === "message" && payload.role === "user") {
      planConfirmation = null;
      pending.clear();
      pendingFileEdits.clear();
    }
    if (isAssistantFinalMessage(payload) && (planModeTurn || isWrappedProposedPlan(payload))) {
      planConfirmation = { timestamp, turnId: recordTurnId(record) };
    }
    if (["function_call", "custom_tool_call"].includes(payload.type)
      && normalizedToolName(payload.name) === "request_user_input") {
      const id = callId(payload);
      if (id) pending.set(id, { timestamp, turnId: recordTurnId(record) });
    }
    if (isPendingFileEditCall(payload)) {
      const id = callId(payload);
      if (id) pendingFileEdits.set(id, { timestamp, turnId: recordTurnId(record) });
    }
    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const id = callId(payload);
      if (id) {
        pending.delete(id);
        pendingFileEdits.delete(id);
      }
    }
  }
  if (!latest) return null;
  const planConfirmationAge = planConfirmation ? nowMs - timestampValue(planConfirmation.timestamp) : null;
  if (planConfirmationAge !== null && planConfirmationAge >= 0 && planConfirmationAge <= CODEX_NEEDS_INPUT_MAX_MS) {
    return { live: true, status: "needs_input", needsInput: true, needsInputKind: "plan_confirmation", source: "rollout_activity_heuristic", observedAt: planConfirmation.timestamp };
  }
  const waiting = [...pending.values()].sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp))[0];
  if (waiting && nowMs - timestampValue(waiting.timestamp) <= CODEX_ROLLOUT_LIVE_WINDOW_MS) {
    return { live: true, status: "needs_input", needsInput: true, needsInputKind: "user_input", source: "rollout_activity_heuristic", observedAt: waiting.timestamp };
  }
  const pendingFileEdit = [...pendingFileEdits.values()]
    .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp))[0];
  const pendingFileEditAge = pendingFileEdit ? nowMs - timestampValue(pendingFileEdit.timestamp) : null;
  if (allowPendingFileEdit
    && pendingFileEditAge !== null
    && pendingFileEditAge >= CODEX_ROLLOUT_APPROVAL_GRACE_MS
    && pendingFileEditAge <= CODEX_NEEDS_INPUT_MAX_MS) {
    return { live: true, status: "needs_input", needsInput: true, needsInputKind: "pending_file_edit", source: "rollout_activity_heuristic", observedAt: pendingFileEdit.timestamp };
  }
  const age = nowMs - timestampValue(latest.timestamp);
  if (age < 0 || age > CODEX_ROLLOUT_LIVE_WINDOW_MS) return null;
  const status = terminal && timestampValue(terminal.timestamp) >= timestampValue(latest.timestamp)
    ? (["interrupted", "system_error"].includes(terminal.status) ? "stopped" : terminal.status)
    : age <= CODEX_ACTIVE_WINDOW_MS ? "active" : "idle";
  return {
    live: true,
    status,
    needsInput: false,
    source: "rollout_activity_heuristic",
    observedAt: latest.timestamp,
  };
}

export function appServerLiveness(runtimeStatus, observedAt) {
  const type = runtimeStatus?.type;
  if (type === "notLoaded" || !["active", "idle", "systemError"].includes(type)) return null;
  const flags = new Set(Array.isArray(runtimeStatus.activeFlags) ? runtimeStatus.activeFlags : []);
  const needsInput = type === "active" && (flags.has("waitingOnApproval") || flags.has("waitingOnUserInput"));
  return {
    live: true,
    status: needsInput ? "needs_input" : type === "systemError" ? "stopped" : type,
    needsInput,
    source: "owning_app_server",
    observedAt: codexTimestamp(observedAt) || new Date(0).toISOString(),
  };
}

function validBridgeSnapshot(value) {
  return value?.version === 1
    && value.provider === "codex"
    && isSafeCodexSessionId(value.sessionId)
    && (value.agentId === null || safeId(value.agentId))
    && BRIDGE_STATES.has(value.lifecycle)
    && [null, "approval", "user_input", "multiple"].includes(value.requestKind)
    && codexTimestamp(value.observedAt)
    && Number.isSafeInteger(value.sequence)
    && Number.isInteger(value.ownerPid)
    && value.ownerPid > 0
    && normalizedProcessStartIdentity(value.ownerStartedAt)
    && /^[a-f0-9]{32}$/.test(value.bridgeInstance || "");
}

function readBridgeRecords(root, maximumFiles) {
  const leases = new Map();
  for (const file of boundedFiles(path.join(root, "leases"), ".json", maximumFiles)) {
    const lease = readJson(file);
    if (lease?.version !== 1 || lease.provider !== "codex" || !Number.isInteger(lease.ownerPid)
      || !normalizedProcessStartIdentity(lease.ownerStartedAt) || !/^[a-f0-9]{32}$/.test(lease.bridgeInstance || "")
      || !codexTimestamp(lease.expiresAt)) continue;
    leases.set(`${lease.ownerPid}\0${lease.ownerStartedAt}\0${lease.bridgeInstance}`, lease);
  }
  return boundedFiles(path.join(root, "snapshots"), ".json", maximumFiles).flatMap((file) => {
    const snapshot = readJson(file);
    if (!validBridgeSnapshot(snapshot)) return [];
    const lease = leases.get(`${snapshot.ownerPid}\0${snapshot.ownerStartedAt}\0${snapshot.bridgeInstance}`) || null;
    return [{ snapshot, lease }];
  });
}

function bridgeLiveness(record, nowMs, keepStale) {
  const { snapshot, lease } = record;
  const observedAt = codexTimestamp(snapshot.observedAt);
  const age = nowMs - timestampValue(observedAt);
  if (age < 0) return null;
  const leaseCurrent = lease && timestampValue(lease.expiresAt) > nowMs;
  // Versions that treated SessionEnd as a hard close may have persisted an
  // `ended` snapshot for an interactive conversation. Heal that state while
  // the same Codex owner is still alive, then retain the old terminal behavior
  // once its lease is gone so stale rollout activity cannot reopen it.
  if (snapshot.lifecycle === "ended") {
    if (leaseCurrent) {
      return { live: true, status: "idle", needsInput: false, source: "lifecycle_bridge", observedAt };
    }
    return age <= CODEX_ROLLOUT_LIVE_WINDOW_MS
      ? { live: false, authoritative: true, status: "finished", needsInput: false, source: "lifecycle_bridge", observedAt }
      : null;
  }
  if (TERMINAL_BRIDGE_STATES.has(snapshot.lifecycle)) {
    return age <= CODEX_ROLLOUT_LIVE_WINDOW_MS
      ? { live: false, authoritative: true, status: snapshot.lifecycle, needsInput: false, source: "lifecycle_bridge", observedAt }
      : null;
  }
  if (!leaseCurrent && !keepStale) return null;
  const needsInput = snapshot.lifecycle === "needs_input" && age <= CODEX_NEEDS_INPUT_MAX_MS;
  return {
    live: true,
    status: needsInput
      ? "needs_input"
      : snapshot.lifecycle === "needs_input"
        ? "idle"
        : ["interrupted", "system_error"].includes(snapshot.lifecycle) ? "stopped" : snapshot.lifecycle,
    needsInput,
    source: "lifecycle_bridge",
    observedAt,
  };
}

function descendantsFor(rootId, threads) {
  const included = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (included.has(thread.localId)) continue;
      if (thread.sessionId === rootId || included.has(thread.parentThreadId) || included.has(thread.forkedFromId)) {
        included.add(thread.localId);
        changed = true;
      }
    }
  }
  return included;
}

function currentBridgeResourceOwner(record, nowMs) {
  if (!record?.lease || (TERMINAL_BRIDGE_STATES.has(record.snapshot.lifecycle) && record.snapshot.lifecycle !== "ended")) return null;
  if (timestampValue(record.lease.expiresAt) <= nowMs) return null;
  return {
    pid: record.snapshot.ownerPid,
    processStartIdentity: record.snapshot.ownerStartedAt,
  };
}

function uniqueResourceOwner(owners) {
  const unique = new Map(owners.map((owner) => [`${owner.pid}\0${owner.processStartIdentity}`, owner]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function createCodexLivenessCoordinator(options = {}) {
  const root = resolveCodexLivenessRoot(options);
  const writerLocksRoot = options.writerLocksRoot ? path.resolve(options.writerLocksRoot) : null;
  const writerLockIsActive = options.writerLockIsActive || ((file) => isActiveCodexWriterLock(file, { platform: options.platform }));
  const now = options.now || (() => Date.now());
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : CODEX_LIVENESS_CACHE_MS;
  const maximumBridgeFiles = Number.isInteger(options.maximumBridgeFiles)
    ? Math.max(1, Math.min(CODEX_LIVENESS_MAX_BRIDGE_FILES, options.maximumBridgeFiles))
    : CODEX_LIVENESS_MAX_BRIDGE_FILES;
  const maximumTailBytes = Number.isInteger(options.maximumTailBytes)
    ? Math.max(1, Math.min(CODEX_LIVENESS_MAX_TAIL_BYTES, options.maximumTailBytes))
    : CODEX_LIVENESS_MAX_TAIL_BYTES;
  const tailCache = new Map();
  const rolloutObservations = new Map();
  const stalePolls = new Map();
  let cache = null;
  let lastCheckedAt = null;
  let resumeGraceUntil = 0;
  let stats = { bridgeFiles: 0, rolloutFiles: 0, rolloutBytes: 0 };

  function hasCurrentWriterLock(thread) {
    const localId = safeId(thread?.localId);
    if (!writerLocksRoot || !localId) return false;
    return writerLockIsActive(path.join(writerLocksRoot, `${localId}.lock`)) === true;
  }

  function rolloutEvidence(file, nowMs, parseOptions = {}) {
    if (!file) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    const key = `${stat.size}:${stat.mtimeMs}`;
    let cached = tailCache.get(file);
    if (!cached || cached.key !== key) {
      const read = readBoundedTail(file, maximumTailBytes);
      cached = { key: read.key, records: read.records };
      tailCache.set(file, cached);
      stats.rolloutFiles += 1;
      stats.rolloutBytes += Math.min(stat.size, maximumTailBytes);
    }
    const liveness = parseCodexRolloutLiveness(cached.records, { now: nowMs, ...parseOptions });
    if (liveness?.status !== "idle") return liveness;
    const currentActivity = parseCodexCurrentActivityRecords(cached.records, {
      agentStatus: "idle",
      rolloutHeuristicIdle: true,
    });
    return currentActivity ? { ...liveness, status: "active" } : liveness;
  }

  function rolloutMetadataCanBeLive(thread, nowMs, maximumAge = CODEX_ROLLOUT_LIVE_WINDOW_MS) {
    const updatedAt = timestampValue(thread.updatedAt);
    const metadataFresh = !Number.isFinite(updatedAt) || nowMs - updatedAt <= maximumAge;
    if (!thread.rolloutFile) return metadataFresh;
    let stat;
    try { stat = fs.statSync(thread.rolloutFile); } catch { return metadataFresh; }
    const key = `${stat.size}:${stat.mtimeMs}`;
    const previous = rolloutObservations.get(thread.rolloutFile);
    const changedAt = previous && previous.key !== key
      ? nowMs
      : previous?.changedAt ?? (metadataFresh ? nowMs : null);
    rolloutObservations.delete(thread.rolloutFile);
    rolloutObservations.set(thread.rolloutFile, { key, changedAt });
    while (rolloutObservations.size > CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS) {
      rolloutObservations.delete(rolloutObservations.keys().next().value);
    }
    return metadataFresh || (changedAt !== null && nowMs - changedAt <= maximumAge);
  }

  function observe(threads, observeOptions = {}) {
    if (observeOptions.historical) return { threads: threads.map((thread) => ({ ...thread, runtimeStatus: null, liveStatus: null, liveness: null, livenessLive: false })), sessions: new Map() };
    const checkedAt = now();
    if (cache && checkedAt < cache.expiresAt && cache.input === threads) return cache.value;
    if (lastCheckedAt !== null && checkedAt - lastCheckedAt > CODEX_BRIDGE_LEASE_MS) resumeGraceUntil = checkedAt + CODEX_BRIDGE_LEASE_MS;
    lastCheckedAt = checkedAt;
    stats = { bridgeFiles: 0, rolloutFiles: 0, rolloutBytes: 0 };
    const bridgeRecords = readBridgeRecords(root, maximumBridgeFiles);
    stats.bridgeFiles = bridgeRecords.length;
    const bridgeByActor = new Map();
    for (const record of bridgeRecords) {
      const actorId = record.snapshot.agentId || record.snapshot.sessionId;
      const key = `${record.snapshot.sessionId}\0${actorId}`;
      const previous = bridgeByActor.get(key);
      if (!previous || record.snapshot.sequence > previous.snapshot.sequence
        || (record.snapshot.sequence === previous.snapshot.sequence
          && timestampValue(record.snapshot.observedAt) > timestampValue(previous.snapshot.observedAt))) {
        bridgeByActor.set(key, record);
      }
    }
    const resourceOwnersByThreadId = new Map();
    const topLevelSourceBySessionId = new Map(
      threads
        .filter((thread) => !thread.parentThreadId)
        .map((thread) => [thread.sessionId || thread.localId, thread.sourceKind]),
    );
    let coldDesktopRollouts = 0;
    let coldCliRollouts = 0;
    const observedThreads = threads.map((thread) => {
      if (thread.archived) return { ...thread, runtimeStatus: null, liveStatus: null, liveness: null, livenessLive: false, suppressFallbackLive: false };
      const app = appServerLiveness(thread.runtimeStatus, thread.updatedAt);
      const bridgeKey = `${thread.sessionId || thread.localId}\0${thread.localId}`;
      const bridgeRecord = bridgeByActor.get(bridgeKey);
      let bridge = null;
      if (bridgeRecord) {
        const staleKey = `${bridgeRecord.snapshot.ownerPid}\0${bridgeRecord.snapshot.ownerStartedAt}\0${bridgeRecord.snapshot.bridgeInstance}`;
        const leaseCurrent = timestampValue(bridgeRecord.lease?.expiresAt) > checkedAt;
        const resourceOwner = currentBridgeResourceOwner(bridgeRecord, checkedAt);
        if (resourceOwner) resourceOwnersByThreadId.set(thread.localId, resourceOwner);
        if (leaseCurrent) stalePolls.delete(staleKey);
        else stalePolls.set(staleKey, (stalePolls.get(staleKey) || 0) + 1);
        const keepStale = checkedAt < resumeGraceUntil || (stalePolls.get(staleKey) || 0) < 2;
        bridge = bridgeLiveness(bridgeRecord, checkedAt, keepStale);
      }
      const primary = app || bridge;
      const canSupplementIdle = primary?.status === "idle";
      const metadataCanBeLive = canSupplementIdle
        ? rolloutMetadataCanBeLive(thread, checkedAt, CODEX_NEEDS_INPUT_MAX_MS)
        : !primary && rolloutMetadataCanBeLive(thread, checkedAt);
      const coldDesktopCandidate = !primary
        && !metadataCanBeLive
        && thread.sourceKind === "vscode"
        && !thread.parentThreadId
        && coldDesktopRollouts < CODEX_LIVENESS_MAX_COLD_ROLLOUTS;
      const coldCliCandidate = !primary
        && !metadataCanBeLive
        && thread.sourceKind === "cli"
        && !thread.parentThreadId
        && hasCurrentWriterLock(thread)
        && coldCliRollouts < CODEX_LIVENESS_MAX_COLD_ROLLOUTS;
      if (coldDesktopCandidate) coldDesktopRollouts += 1;
      if (coldCliCandidate) coldCliRollouts += 1;
      const coldRolloutCandidate = coldDesktopCandidate || coldCliCandidate;
      const inspectRollout = metadataCanBeLive || coldRolloutCandidate;
      const topLevelSourceKind = topLevelSourceBySessionId.get(thread.sessionId || thread.localId)
        || thread.sourceKind;
      const rollout = inspectRollout
        ? rolloutEvidence(thread.rolloutFile, checkedAt, {
            allowPendingFileEdit: topLevelSourceKind === "cli",
          })
        : null;
      const liveness = canSupplementIdle && rollout?.needsInput ? rollout : primary || rollout;
      return {
        ...thread,
        liveStatus: liveness?.status || null,
        liveness: liveness ? { source: liveness.source, observedAt: liveness.observedAt } : null,
        livenessLive: Boolean(liveness?.live),
        suppressFallbackLive: Boolean(bridge?.authoritative && !bridge.live),
      };
    });
    const sessions = new Map();
    for (const rootThread of observedThreads.filter((thread) => !thread.parentThreadId)) {
      const ids = descendantsFor(rootThread.localId, observedThreads);
      const related = observedThreads.filter((thread) => ids.has(thread.localId));
      const rootTerminal = related.find((thread) => thread.localId === rootThread.localId)?.suppressFallbackLive;
      const live = rootTerminal ? [] : related.filter((thread) => thread.livenessLive);
      const newest = live.map((thread) => thread.liveness).filter(Boolean).sort((left, right) => timestampValue(right.observedAt) - timestampValue(left.observedAt))[0];
      const resourceOwner = live.length > 0
        ? uniqueResourceOwner(related.map((thread) => resourceOwnersByThreadId.get(thread.localId)).filter(Boolean))
        : null;
      const needsInput = live.some((thread) => thread.liveStatus === "needs_input");
      const activityStatus = needsInput
        ? "needs_input"
        : live.some((thread) => thread.liveStatus === "active")
          ? "working"
          : live.some((thread) => thread.liveStatus === "idle")
            ? "idle"
            : "unknown";
      sessions.set(rootThread.localId, {
        isLive: live.length > 0,
        needsInput,
        activityStatus,
        observedAt: newest?.observedAt || null,
        resourceOwner,
      });
    }
    const value = { threads: observedThreads, sessions };
    cache = { input: threads, expiresAt: checkedAt + cacheMs, value };
    return value;
  }

  return Object.freeze({
    observe,
    applyWaiting(agents) { return applyWaitingStatus(agents); },
    stats() { return { ...stats, cachedRollouts: tailCache.size }; },
  });
}
