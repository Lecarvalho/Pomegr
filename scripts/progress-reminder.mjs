#!/usr/bin/env node

/*
 * Provider-neutral, event-driven progress reminder hook. Keep this file
 * self-contained: the two plugin build scripts bundle it for installation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REMINDER_VERSION = 1;
export const PROGRESS_POLICY_VERSION = 7;
export const QUALIFYING_EVENT_LIMIT = 3;
export const QUALIFYING_TIME_MS = 10 * 60 * 1000;
export const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const STATE_FILE_LIMIT = 256;
export const MAX_POLICY_BYTES = 24 * 1024;
export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_CONTEXT_BYTES = 800;
export const MAX_EVENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const POLICY_RELATIVE_PATH = path.join(".pomegr", "signals.md");
const STATE_DIRECTORY_NAME = "progress-reminders";
const POMEGR_TOOL_PATTERN = /(?:^|__)pomegr(?:__|$)/i;
const REPORT_CLEAR_RENAME_TOOL_PATTERN = /(?:^|__)(?:report|clear)_[a-z0-9_]+$|(?:^|__)rename_session$/i;

function safeString(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function eventName(payload) {
  return safeString(payload?.hook_event_name || payload?.event, 64);
}

function eventTime(payload, observedNow = null) {
  const now = Number.isFinite(observedNow) ? Math.floor(observedNow) : null;
  const candidate = payload?.timestamp ?? payload?.event_timestamp ?? payload?.time;
  let parsed = null;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) parsed = Math.floor(candidate);
  if (typeof candidate === "string") {
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) parsed = timestamp;
  }
  if (now === null) return parsed ?? Date.now();
  if (parsed === null || Math.abs(parsed - now) > MAX_EVENT_CLOCK_SKEW_MS) return now;
  return Math.min(parsed, now);
}

function isRootEvent(payload) {
  // Providers omit agent_id for the root session. A non-empty agent id is the
  // only subagent marker this hook is allowed to inspect.
  return !(typeof payload?.agent_id === "string" && payload.agent_id.length > 0);
}

function toolSuffix(name) {
  const value = safeString(name, 512);
  if (!value) return "";
  const separator = value.lastIndexOf("__");
  return (separator >= 0 ? value.slice(separator + 2) : value).toLowerCase();
}

function isProgressTool(name) {
  const value = safeString(name, 512) || "";
  return value === "report_session_progress"
    || /^mcp__(?:pomegr|plugin_pomegr_pomegr)__report_session_progress$/i.test(value);
}

function isClearProgressTool(name) {
  const value = safeString(name, 512) || "";
  return value === "clear_session_progress"
    || /^mcp__(?:pomegr|plugin_pomegr_pomegr)__clear_session_progress$/i.test(value);
}

function isIgnoredPomegrTool(name) {
  const value = safeString(name, 512) || "";
  return POMEGR_TOOL_PATTERN.test(value) && (REPORT_CLEAR_RENAME_TOOL_PATTERN.test(value)
    || ["report_session_progress", "clear_session_progress"].includes(toolSuffix(value)));
}

export function hashSessionId(sessionId) {
  return crypto.createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function policyDirectory(startDirectory) {
  let current = path.resolve(startDirectory || process.cwd());
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    return null;
  }
  while (true) {
    const candidate = path.join(current, POLICY_RELATIVE_PATH);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, ".git"))) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readProgressPolicy(startDirectory) {
  const policyPath = policyDirectory(startDirectory);
  if (!policyPath) return { status: "missing", enabled: false };
  try {
    const stat = fs.lstatSync(policyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_POLICY_BYTES) return { status: "invalid", enabled: false };
    const text = fs.readFileSync(policyPath, "utf8").replace(/\r\n?/g, "\n");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { status: "invalid", enabled: false };
    if (!/^# Pomegr reporting policy\s*$/m.test(text)) return { status: "invalid", enabled: false };
    const version = Number(text.match(/^Policy version:\s*(\d+)\s*$/m)?.[1]);
    if (![6, PROGRESS_POLICY_VERSION].includes(version)) return { status: "invalid", enabled: false };
    if (version === 6) return { status: "valid", version, enabled: false };
    if ((text.match(/^## Session progress\s*$/gm) || []).length !== 1) return { status: "invalid", enabled: false };
    const match = text.match(/^## Session progress\s*$([\s\S]*?)(?=^## |$(?![\s\S]))/m);
    const body = match?.[1]?.trim() || "";
    if (!["- Enabled: yes", "- Enabled: no"].includes(body)) return { status: "invalid", enabled: false };
    return { status: "valid", version, enabled: body === "- Enabled: yes" };
  } catch {
    return { status: "invalid", enabled: false };
  }
}

function dataDirectory(explicitDirectory) {
  if (explicitDirectory) return explicitDirectory;
  return process.env.POMEGR_PROGRESS_DATA_DIR
    || process.env.POMEGR_PLUGIN_DATA
    || process.env.CODEX_PLUGIN_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || process.env.PLUGIN_DATA
    || null;
}

function stateDirectory(explicitDirectory) {
  const base = dataDirectory(explicitDirectory);
  return base ? path.join(base, STATE_DIRECTORY_NAME) : null;
}

function statePath(directory, sessionId) {
  return path.join(directory, `${hashSessionId(sessionId)}.json`);
}

function validState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== REMINDER_VERSION) return null;
  const counters = ["qualifying_events", "reminder_events"];
  const timestamps = ["last_activity_at", "last_progress_at", "last_clear_at", "last_reminder_at"];
  if (!counters.every((key) => Number.isInteger(value[key]) && value[key] >= 0)
    || !timestamps.every((key) => value[key] === null || (Number.isInteger(value[key]) && value[key] >= 0))) return null;
  return {
    version: REMINDER_VERSION,
    qualifying_events: value.qualifying_events,
    reminder_events: value.reminder_events,
    last_activity_at: value.last_activity_at,
    last_progress_at: value.last_progress_at,
    last_clear_at: value.last_clear_at,
    last_reminder_at: value.last_reminder_at,
  };
}

function blankState() {
  return {
    version: REMINDER_VERSION,
    qualifying_events: 0,
    reminder_events: 0,
    last_activity_at: null,
    last_progress_at: null,
    last_clear_at: null,
    last_reminder_at: null,
  };
}

function readState(directory, sessionId) {
  if (!directory) return null;
  try {
    const file = statePath(directory, sessionId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return validState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return null;
  }
}

function atomicWriteState(directory, sessionId, state) {
  if (!directory) return false;
  try {
    try {
      const existingDirectory = fs.lstatSync(directory);
      if (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink()) return false;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort on Windows */ }
    const destination = statePath(directory, sessionId);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(validState(state));
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, content, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort on Windows */ }
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      // Windows does not replace an existing destination with rename(2).
      // Remove only this hook's own validated destination, then complete the
      // atomic temp-file install for the common path.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      try {
        const existing = fs.lstatSync(destination);
        if (!existing.isFile() || existing.isSymbolicLink()) throw error;
        fs.unlinkSync(destination);
        fs.renameSync(temporary, destination);
      } catch {
        try { fs.unlinkSync(temporary); } catch { /* fail closed */ }
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function pruneStates(directory, now) {
  if (!directory) return;
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const states = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        const value = validState(JSON.parse(fs.readFileSync(file, "utf8")));
        const latest = value && [value.last_activity_at, value.last_progress_at, value.last_clear_at, value.last_reminder_at]
          .filter((timestamp) => timestamp !== null)
          .reduce((maximum, timestamp) => Math.max(maximum, timestamp), 0);
        if (!value || (latest > 0 && now - latest > STATE_TTL_MS)) {
          fs.unlinkSync(file);
          continue;
        }
        states.push({ file, at: value.last_activity_at ?? 0 });
      } catch {
        // Malformed state is inert; leave it in place so the current session
        // remains suppressed rather than silently starting a new window.
      }
    }
    states.sort((left, right) => right.at - left.at);
    for (const stale of states.slice(STATE_FILE_LIMIT)) {
      try { fs.unlinkSync(stale.file); } catch { /* fail closed */ }
    }
  } catch { /* missing or unwritable data directory suppresses reminders */ }
}

function reminderContext() {
  const text = "[Pomegr progress reminder] It has been at least 10 minutes and 3 root-session tool completions since the last progress report. Consider calling report_session_progress with a concise, project-safe update.";
  return Buffer.byteLength(text, "utf8") <= MAX_CONTEXT_BYTES ? text : text.slice(0, MAX_CONTEXT_BYTES);
}

export function handleProgressReminder(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (eventName(payload) !== "PostToolUse") return null;
  const sessionId = safeString(payload.session_id, 512);
  const cwd = safeString(payload.cwd, 4096);
  const toolName = safeString(payload.tool_name, 512);
  if (!sessionId || !cwd || !toolName || !isRootEvent(payload)) return null;

  const observedNow = Number.isFinite(options.now) ? options.now : null;
  const eventAt = eventTime(payload, observedNow);
  const policy = options.policy || readProgressPolicy(cwd);
  if (policy.status !== "valid" || !policy.enabled) return null;

  const directory = stateDirectory(options.dataDirectory);
  if (!directory) return null;
  pruneStates(directory, eventAt);
  const loaded = readState(directory, sessionId);
  if (loaded === null) return null;
  const previous = loaded || blankState();
  const state = { ...previous };
  const latestStateAt = [state.last_activity_at, state.last_progress_at, state.last_clear_at, state.last_reminder_at]
    .filter((timestamp) => timestamp !== null)
    .reduce((latest, timestamp) => Math.max(latest, timestamp), 0);
  const now = Math.max(eventAt, latestStateAt);

  if (isProgressTool(toolName) || isClearProgressTool(toolName)) {
    state.qualifying_events = 0;
    state.reminder_events = 0;
    state.last_activity_at = null;
    state.last_progress_at = isProgressTool(toolName) ? now : null;
    state.last_clear_at = isClearProgressTool(toolName) ? now : previous.last_clear_at;
    state.last_reminder_at = null;
    atomicWriteState(directory, sessionId, state);
    return null;
  }
  if (isIgnoredPomegrTool(toolName)) return null;

  const startsAfterClear = state.last_clear_at !== null
    && (state.last_activity_at === null || state.last_activity_at <= state.last_clear_at);
  if (startsAfterClear) {
    state.qualifying_events = 0;
    state.reminder_events = 0;
    state.last_progress_at = now;
  }
  state.last_activity_at = now;
  state.qualifying_events += 1;
  if (state.last_progress_at === null && state.last_clear_at === null) state.last_progress_at = now;
  const baseline = state.last_reminder_at ?? state.last_progress_at ?? state.last_clear_at ?? now;
  const newEvents = state.qualifying_events - state.reminder_events;
  const elapsed = now - baseline;
  const shouldRemind = newEvents >= QUALIFYING_EVENT_LIMIT && elapsed >= QUALIFYING_TIME_MS;
  if (shouldRemind) {
    state.last_reminder_at = now;
    state.reminder_events = state.qualifying_events;
  }
  if (!atomicWriteState(directory, sessionId, state)) return null;
  return shouldRemind ? {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminderContext(),
    },
  } : null;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function readHookPayload(fallbackCwd = null) {
  if (process.stdin.isTTY) return null;
  try {
    const raw = fs.readFileSync(0);
    if (raw.length === 0 || raw.length > MAX_HOOK_INPUT_BYTES) return null;
    const payload = JSON.parse(raw.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (!payload.cwd && fallbackCwd) payload.cwd = fallbackCwd;
    return payload;
  } catch {
    return null;
  }
}

export function runProgressReminder() {
  const output = handleProgressReminder(readHookPayload(argumentValue(process.argv.slice(2), "--cwd")), { now: Date.now() });
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runProgressReminder();
}
