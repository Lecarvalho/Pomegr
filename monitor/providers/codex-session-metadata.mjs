import fs from "node:fs";
import path from "node:path";
import { closeSourceFamily } from "./source-ledger.mjs";

export const DEFAULT_CODEX_CATALOG_LIMIT = 50;
export const DEFAULT_CODEX_SCAN_LIMIT = 500;
const DEFAULT_INDEX_BYTES = 1024 * 1024;
const DEFAULT_HEADER_BYTES = 64 * 1024;
const WIDE_RECENCY_BYTES = 1024 * 1024;
const RECENCY_CACHE_LIMIT = 8_192;
// file -> { size, mtimeMs, updatedAt }. Rollouts are append-only, so an unchanged size
// and mtime mean unchanged records: the periodic header pass reuses the tail answer.
const recencyCache = new Map();
const MAX_TITLE_LENGTH = 160;
const MAX_AGENT_PATH_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_BRANCH_LENGTH = 256;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOP_LEVEL_SOURCE_KINDS = new Set(["cli", "vscode", "exec", "appServer", "unknown"]);
const HEADER_BATCH_SIZE = 100;
const HEADER_READ_BYTES = 64 * 1024;
const MAX_SELECTED_FAMILY = DEFAULT_CODEX_SCAN_LIMIT;

function boundedText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function boundedPath(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_PATH_LENGTH);
}

export function isSafeCodexSessionId(value) {
  return typeof value === "string" && SAFE_SESSION_ID.test(value);
}

export function codexTimestamp(value) {
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function codexSourceKind(source) {
  if (typeof source === "string") {
    if (source === "app_server") return "appServer";
    if (source === "sub_agent") return "subAgent";
    return TOP_LEVEL_SOURCE_KINDS.has(source) ? source : "unknown";
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return "unknown";
  const subagent = source.subAgent ?? source.subagent;
  if (subagent === "review") return "subAgentReview";
  if (subagent === "compact") return "subAgentCompact";
  if (subagent && typeof subagent === "object" && ("thread_spawn" in subagent || "threadSpawn" in subagent)) return "subAgentThreadSpawn";
  if (subagent !== undefined) return "subAgentOther";
  return "unknown";
}

export function isCodexApprovalReviewerSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const subagent = source.subAgent ?? source.subagent;
  return Boolean(subagent && typeof subagent === "object" && subagent.other === "guardian");
}

function projectFromCwd(cwd) {
  if (!cwd) return "Unknown project";
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  return boundedText(segments.at(-1), MAX_TITLE_LENGTH) || "Unknown project";
}

function readBoundedFile(file, maximum, fromEnd = false) {
  let stat;
  try { stat = fs.statSync(file); } catch { return ""; }
  if (!stat.isFile() || stat.size <= 0) return "";
  const bytes = Math.min(stat.size, maximum);
  const buffer = Buffer.alloc(bytes);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, buffer, 0, bytes, fromEnd ? Math.max(0, stat.size - bytes) : 0);
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let text = buffer.toString("utf8");
  if (fromEnd && stat.size > bytes) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return text;
}

export function readCodexSessionIndex(indexFile, maximumBytes = DEFAULT_INDEX_BYTES) {
  const names = new Map();
  for (const line of readBoundedFile(indexFile, maximumBytes, true).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!isSafeCodexSessionId(entry?.id)) continue;
      const title = boundedText(entry.thread_name, MAX_TITLE_LENGTH);
      if (!title) continue;
      names.set(entry.id, { title, updatedAt: codexTimestamp(entry.updated_at) });
    } catch {
      // The index is append-only; malformed and truncated lines are ignored independently.
    }
  }
  return names;
}

function sessionParentId(payload) {
  const direct = payload?.parentThreadId ?? payload?.parent_thread_id;
  if (isSafeCodexSessionId(direct)) return direct;
  const subagent = payload?.source?.subAgent ?? payload?.source?.subagent;
  const spawned = subagent?.thread_spawn ?? subagent?.threadSpawn;
  const parent = spawned?.parent_thread_id ?? spawned?.parentThreadId;
  return isSafeCodexSessionId(parent) ? parent : null;
}

function sessionSpawnMetadata(payload) {
  const subagent = payload?.source?.subAgent ?? payload?.source?.subagent;
  const spawned = subagent?.thread_spawn ?? subagent?.threadSpawn;
  return spawned && typeof spawned === "object" ? spawned : {};
}

function safeRelatedId(value) {
  return isSafeCodexSessionId(value) ? value : null;
}

export function codexThreadRuntimeStatus(status) {
  const type = typeof status === "string" ? status : status?.type;
  if (!["notLoaded", "idle", "systemError", "active"].includes(type)) return null;
  return type === "active" ? { type, activeFlags: Array.isArray(status?.activeFlags)
    ? status.activeFlags.filter((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)).sort()
    : [] } : { type };
}

/** The timestamp of the newest record that parses as complete JSON, scanned from the end
 * of `text`'s lines backward. Codex does not advance a rollout file's own modification
 * time reliably, so header recency comes from record time, not file mtime. A
 * truncated trailing line left by a write still in flight fails to parse and is skipped
 * in favor of the newest line that parses in full. */
function newestParsedRecordTimestamp(text) {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const timestamp = codexTimestamp(record?.timestamp ?? record?.payload?.timestamp ?? record?.message?.timestamp);
      if (timestamp) return timestamp;
    } catch {
      // A write still in flight can leave a truncated trailing line; keep scanning
      // backward for the newest record that parses in full.
    }
  }
  return null;
}

/** Header recency: the newest complete record's time. The header window already holds
 * the whole file unless maximumBytes truncated it; only then is a bounded tail read
 * needed, cached by size and mtime. A newest record larger than the 64 KiB tail gets one
 * 1 MiB read; past that, recency is the later of creation time and file mtime. */
function rolloutRecency(file, stat, headText, maximumBytes, createdAt) {
  if (stat.size <= maximumBytes) return newestParsedRecordTimestamp(headText) || createdAt;
  const cached = recencyCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.updatedAt;
  const mtime = stat.mtime.toISOString();
  const updatedAt = newestParsedRecordTimestamp(readBoundedFile(file, DEFAULT_HEADER_BYTES, true))
    || (stat.size > DEFAULT_HEADER_BYTES ? newestParsedRecordTimestamp(readBoundedFile(file, WIDE_RECENCY_BYTES, true)) : null)
    || (createdAt && Date.parse(createdAt) >= Date.parse(mtime) ? createdAt : mtime);
  recencyCache.delete(file);
  recencyCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, updatedAt });
  while (recencyCache.size > RECENCY_CACHE_LIMIT) recencyCache.delete(recencyCache.keys().next().value);
  return updatedAt;
}

export function readCodexRolloutHeader(file, options = {}) {
  const maximumBytes = options.maximumBytes ?? DEFAULT_HEADER_BYTES;
  const headText = readBoundedFile(file, maximumBytes);
  let sessionRecord = null;
  for (const line of headText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "session_meta" && record.payload && typeof record.payload === "object") {
        sessionRecord = record;
        break;
      }
    } catch {
      // Live writes and damaged history can leave one bad line without invalidating the file.
    }
  }
  if (!sessionRecord) return null;
  const payload = sessionRecord.payload;
  const localId = payload.id ?? payload.thread_id;
  if (!isSafeCodexSessionId(localId)) return null;
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cwd = boundedPath(payload.cwd);
  const sourceKind = codexSourceKind(payload.source);
  const parentThreadId = sessionParentId(payload);
  const spawned = sessionSpawnMetadata(payload);
  const createdAt = codexTimestamp(payload.timestamp ?? sessionRecord.timestamp);
  const updatedAt = rolloutRecency(file, stat, headText, maximumBytes, createdAt);
  return {
    localId,
    provider: "codex",
    source: "Codex",
    title: boundedText(payload.thread_name, MAX_TITLE_LENGTH) || "Untitled session",
    project: projectFromCwd(cwd),
    cwd,
    createdAt,
    updatedAt,
    sourceKind,
    approvalReviewer: isCodexApprovalReviewerSource(payload.source),
    sessionId: safeRelatedId(payload.sessionId ?? payload.session_id) || localId,
    parentThreadId,
    forkedFromId: safeRelatedId(payload.forkedFromId ?? payload.forked_from_id),
    agentPath: boundedText(payload.agentPath ?? payload.agent_path ?? spawned.agent_path ?? spawned.agentPath, MAX_AGENT_PATH_LENGTH),
    agentNickname: boundedText(payload.agentNickname ?? payload.agent_nickname ?? spawned.agent_nickname ?? spawned.agentNickname, MAX_TITLE_LENGTH),
    agentRole: boundedText(payload.agentRole ?? payload.agent_role ?? spawned.agent_role ?? spawned.agentRole, MAX_TITLE_LENGTH),
    runtimeStatus: null,
    recordedGitBranch: boundedText(payload.git?.branch, MAX_BRANCH_LENGTH),
    archived: Boolean(options.archived),
    rolloutFile: file,
  };
}

function walkRecentRollouts(root, maximumFiles, maximumDepth = 5) {
  const files = [];
  function visit(directory, depth) {
    if (files.length >= maximumFiles || depth > maximumDepth) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (files.length >= maximumFiles) break;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(full);
    }
  }
  visit(root, 0);
  return files;
}

export function listCodexRolloutMetadata(root, options = {}) {
  const requestedMaximum = Number.isInteger(options.maximumFiles) ? options.maximumFiles : DEFAULT_CODEX_SCAN_LIMIT;
  const maximumFiles = Math.max(1, Math.min(DEFAULT_CODEX_SCAN_LIMIT, requestedMaximum));
  return walkRecentRollouts(root, maximumFiles)
    .flatMap((file) => {
      const metadata = readCodexRolloutHeader(file, { archived: options.archived });
      return metadata ? [metadata] : [];
    });
}

export function normalizeCodexThreadMetadata(thread, options = {}) {
  const localId = thread?.id ?? thread?.threadId;
  if (!isSafeCodexSessionId(localId) || thread?.ephemeral === true) return null;
  const cwd = boundedPath(thread.cwd);
  const explicitTitle = boundedText(thread.name, MAX_TITLE_LENGTH);
  const indexName = boundedText(options.indexName, MAX_TITLE_LENGTH);
  const localSessionId = safeRelatedId(thread.sessionId) || localId;
  return {
    localId,
    provider: "codex",
    source: "Codex",
    title: explicitTitle || indexName || "Untitled session",
    project: projectFromCwd(cwd),
    cwd,
    createdAt: codexTimestamp(thread.createdAt),
    updatedAt: codexTimestamp(thread.updatedAt) || codexTimestamp(thread.recencyAt),
    sourceKind: codexSourceKind(thread.source),
    approvalReviewer: isCodexApprovalReviewerSource(thread.source),
    sessionId: localSessionId,
    parentThreadId: isSafeCodexSessionId(thread.parentThreadId) ? thread.parentThreadId : null,
    forkedFromId: safeRelatedId(thread.forkedFromId),
    agentPath: boundedText(thread.agentPath, MAX_AGENT_PATH_LENGTH),
    agentNickname: boundedText(thread.agentNickname, MAX_TITLE_LENGTH),
    agentRole: boundedText(thread.agentRole, MAX_TITLE_LENGTH),
    agentAssignment: explicitTitle || null,
    runtimeStatus: codexThreadRuntimeStatus(thread.status),
    recordedGitBranch: boundedText(thread.gitInfo?.branch, MAX_BRANCH_LENGTH),
    archived: Boolean(options.archived),
    rolloutFile: null,
  };
}

export function isTopLevelCodexSession(metadata) {
  return Boolean(metadata && !metadata.parentThreadId && TOP_LEVEL_SOURCE_KINDS.has(metadata.sourceKind));
}

/** Translate a full Codex rollout/thread header into the source ledger's bounded,
 * provider-neutral shape. `groupId` carries Codex's shared `sessionId` only when it
 * names a group distinct from the header's own identity (Codex defaults an absent
 * `sessionId` to the header's own `localId`, which is not a group relation). */
export function codexHeaderToLedgerHeader(header) {
  if (!header || !isSafeCodexSessionId(header.localId)) return null;
  return {
    localId: header.localId,
    parentId: isSafeCodexSessionId(header.parentThreadId) ? header.parentThreadId : null,
    forkedFromId: isSafeCodexSessionId(header.forkedFromId) ? header.forkedFromId : null,
    groupId: header.sessionId && header.sessionId !== header.localId && isSafeCodexSessionId(header.sessionId)
      ? header.sessionId
      : null,
    archived: Boolean(header.archived),
    createdAt: typeof header.createdAt === "string" ? header.createdAt : null,
    // The header's own updatedAt is already record time, never file mtime.
    lastRecordAt: typeof header.updatedAt === "string" ? header.updatedAt : null,
    // Between two files carrying one identity, keep the copy the whole-tree walk chose.
    preference: Date.parse(header.updatedAt || "") || null,
  };
}

const FAMILY_LISTING_MAX_FILES = 20_000;
const FAMILY_LISTING_MARGIN_MS = 24 * 60 * 60_000;

function datePartsBefore(parts, since) {
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== since[index]) return parts[index] < since[index];
  }
  return false;
}

/** The `YYYY/MM/DD` directory date of a rollout file under an active root, or null. */
function rolloutDirectoryDate(roots, file) {
  if (typeof file !== "string") return null;
  for (const source of roots) {
    if (!source || source.archived || typeof source.root !== "string") continue;
    const relative = path.relative(source.root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const parts = relative.split(/[\\/]/).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every(Number.isInteger)) return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }
  return null;
}

/**
 * List rollout files that can belong to a family whose root file is `rootFile`.
 * Descendants are always created after their root, so dated `YYYY/MM/DD` directories
 * before the root file's own directory (less a one-day margin) are skipped; archive roots,
 * undated directories and an archived or undated root are listed in full. Returns null
 * when a directory cannot be read or the listing exceeds its bound, so the caller falls
 * back to the complete walk instead of trusting a partial listing.
 */
export async function listCodexRolloutFilesSince(roots, rootFile, options = {}) {
  const { signal } = options;
  if (!Array.isArray(roots)) return null;
  const rootDate = options.listAll ? null : rolloutDirectoryDate(roots, rootFile);
  const sinceDate = new Date((rootDate ?? 0) - FAMILY_LISTING_MARGIN_MS);
  const since = rootDate === null ? [0, 0, 0]
    : [sinceDate.getUTCFullYear(), sinceDate.getUTCMonth() + 1, sinceDate.getUTCDate()];
  const files = [];
  async function visit(directory, dateParts, depth) {
    if (depth > 8 || signal?.aborted) return false;
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const dated = dateParts && dateParts.length < 3 && /^\d{1,4}$/.test(entry.name);
        const nextParts = dated ? [...dateParts, Number(entry.name)] : null;
        if (nextParts && datePartsBefore(nextParts, since.slice(0, nextParts.length))) continue;
        if (!await visit(full, nextParts, depth + 1)) return false;
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        files.push({ file: full, archived: false });
        if (files.length > FAMILY_LISTING_MAX_FILES) return false;
      }
    }
    return true;
  }
  for (const source of roots) {
    if (!source || typeof source.root !== "string" || !source.root) return null;
    const start = files.length;
    if (!await visit(source.root, source.archived ? null : [], 0)) return null;
    for (let index = start; index < files.length; index += 1) files[index].archived = Boolean(source.archived);
  }
  return files;
}

/** The source ledger's `parseHeader` hook: one bounded rollout header read,
 * translated into the ledger's neutral shape. */
export function readCodexLedgerHeader(file, options = {}) {
  const archived = options.archived ?? /[\\/]archived_sessions[\\/]/i.test(file);
  return codexHeaderToLedgerHeader(readCodexRolloutHeader(file, { ...options, archived }));
}

const LISTING_YIELD_EVERY = 32;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** True unless the path is definitely gone; an unreadable file still exists. */
function fileMayExist(file) {
  try { fs.statSync(file); return true; } catch (error) { return !["ENOENT", "ENOTDIR"].includes(error?.code); }
}

/**
 * Resolve one rollout family through the shared source ledger instead of a fresh
 * whole-tree header walk. The ledger only locates the root and caches headers, so family
 * completeness never depends on what the bounded, lagging index holds: every rollout file
 * that can belong to the family (dated directories from the root file's own directory on,
 * undated directories, and archive roots) is listed, each listed file's header comes from
 * the ledger when its filesystem identity is unchanged and is parsed otherwise (yielding to
 * the event loop between batches), and the family is closed over those listed headers
 * alone. Each member's full header is then re-read from its file. An unknown root, a failed
 * or oversized listing, or a member whose file is gone or now carries another identity
 * falls back to the bounded cold walk, whose result is ingested. An empty cold result is
 * remembered briefly, unless the root's file still exists but could not be read. Bound
 * overflow still throws `selected_family_limit`.
 */
export async function resolveCodexRolloutFamily(ledger, roots, localSessionId, options = {}) {
  if (!ledger) return findCodexRolloutFamily(roots, localSessionId, options);
  if (!isSafeCodexSessionId(localSessionId)) return null;
  const located = ledger.locate(localSessionId);
  const rootFile = located?.file || null;
  if (rootFile) {
    // A root that joins another thread's group can have older siblings: list everything.
    const candidates = await listCodexRolloutFilesSince(roots, rootFile, { ...options, listAll: Boolean(located.header.groupId) });
    if (candidates) {
      const listed = [];
      for (let index = 0; index < candidates.length; index += 1) {
        if (index % LISTING_YIELD_EVERY === LISTING_YIELD_EVERY - 1) await yieldToEventLoop();
        const candidate = candidates[index];
        let header = ledger.cachedHeader(candidate.file);
        if (!header) {
          header = readCodexLedgerHeader(candidate.file, { archived: candidate.archived });
          if (header) ledger.ingestHeaders([{ file: candidate.file, header }]);
        }
        if (header) listed.push({ file: candidate.file, header });
      }
      const members = closeSourceFamily(localSessionId, listed);
      if (members) {
        const family = [];
        for (const [index, member] of members.entries()) {
          if (index % LISTING_YIELD_EVERY === LISTING_YIELD_EVERY - 1) await yieldToEventLoop();
          const header = readCodexRolloutHeader(member.file, { archived: member.header.archived });
          if (!header || header.localId !== member.localId) {
            family.length = 0;
            break;
          }
          family.push(header);
        }
        if (family.some((header) => header.localId === localSessionId)) return family;
      }
    }
  }
  const rootUnreadable = Boolean(rootFile) && fileMayExist(rootFile);
  if (!rootUnreadable && ledger.recentMiss(localSessionId)) return null;
  const cold = await findCodexRolloutFamily(roots, localSessionId, options);
  if (cold) ledger.ingestHeaders(cold.map((header) => ({ file: header.rolloutFile, header: codexHeaderToLedgerHeader(header) })));
  else if (!rootUnreadable) ledger.rememberMiss(localSessionId);
  return cold;
}

/** Resolve only one selected rollout subtree with repeated bounded header passes. */
export async function findCodexRolloutFamily(roots, localSessionId, options = {}) {
  const { signal } = options;
  if (!isSafeCodexSessionId(localSessionId) || !Array.isArray(roots)) return null;
  const selectedIds = new Set([localSessionId]);
  const selected = new Map();
  async function walk(directory, archived, depth) {
    if (depth > 16 || signal?.aborted) return null;
    let handle;
    try { handle = await fs.promises.opendir(directory, { bufferSize: 32 }); } catch { return null; }
    try {
      for await (const entry of handle) {
        if (signal?.aborted) return null;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(file, archived, depth + 1);
          continue;
        }
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue;
        const header = readCodexRolloutHeader(file, { archived });
        if (!header) continue;
        const relatedSessionIds = new Set(selectedIds);
        for (const selectedHeader of selected.values()) if (selectedHeader.sessionId) relatedSessionIds.add(selectedHeader.sessionId);
        const related = header.localId === localSessionId
          || selectedIds.has(header.parentThreadId)
          || selectedIds.has(header.forkedFromId)
          || (header.sessionId && header.sessionId !== header.localId && relatedSessionIds.has(header.sessionId));
        if (!related) continue;
        if (!selected.has(header.localId) && selected.size >= MAX_SELECTED_FAMILY) throw new Error("selected_family_limit");
        const prior = selected.get(header.localId);
        if (!prior || Date.parse(header.updatedAt || "") > Date.parse(prior.updatedAt || "")) selected.set(header.localId, header);
        selectedIds.add(header.localId);
      }
    } catch (error) {
      if (error?.message === "selected_family_limit") throw error;
      return null;
    }
    finally { try { await handle?.close(); } catch { /* iteration may already close it */ } }
    return null;
  }
  for (let pass = 0; pass < 16; pass += 1) {
    const before = selected.size;
    for (const source of roots) {
      if (signal?.aborted || !source || typeof source.root !== "string" || !source.root) return null;
      await walk(source.root, Boolean(source.archived), 0);
    }
    if (selected.size === before) break;
    if (pass === 15) throw new Error("selected_family_limit");
  }
  return selected.has(localSessionId) ? [...selected.values()] : null;
}

/**
 * Walk every configured rollout root without retaining a catalog in memory.
 * This is deliberately separate from the bounded, recency-oriented discovery
 * cache used by the live shell.  It reads only the fixed rollout header window.
 */
/** @param {{ onBatch?: (batch: any[]) => boolean | Promise<boolean>, onHeader?: (header: any) => void, signal?: AbortSignal }} [options] */
export async function enumerateCodexRolloutHeaders(roots, options = {}) {
  const { onBatch, onHeader, signal } = options;
  if (typeof onBatch !== "function" || !Array.isArray(roots) || roots.length === 0) return { complete: false };
  let batch = [];
  const emit = async () => {
    if (!batch.length) return true;
    const next = batch;
    batch = [];
    try { return (await onBatch(next)) !== false; } catch { return false; }
  };
  function readableOrInvalid(file) {
    let descriptor;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return "inconclusive";
      const bytes = Math.min(stat.size, HEADER_READ_BYTES);
      const buffer = Buffer.alloc(bytes);
      descriptor = fs.openSync(file, "r");
      const read = fs.readSync(descriptor, buffer, 0, bytes, 0);
      if (read !== bytes) return "inconclusive";
      // A full bounded header with no valid session_meta is an explicit
      // non-candidate. A larger file whose header cannot establish identity
      // may be mid-write or truncated, so exactness must degrade.
      return stat.size <= HEADER_READ_BYTES ? "invalid" : "inconclusive";
    } catch { return "inconclusive"; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  async function walk(directory, archived, depth) {
    if (depth > 16 || signal?.aborted) return false;
    let handle;
    try { handle = await fs.promises.opendir(directory, { bufferSize: 32 }); } catch { return false; }
    try {
      for await (const entry of handle) {
        if (signal?.aborted) return false;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!await walk(file, archived, depth + 1)) return false;
          continue;
        }
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue;
        const header = readCodexRolloutHeader(file, { archived });
        if (!header) {
          if (readableOrInvalid(file) !== "invalid") return false;
          continue;
        }
        onHeader?.(header);
        if (!isTopLevelCodexSession(header)) continue;
        batch.push(header);
        if (batch.length === HEADER_BATCH_SIZE && !await emit()) return false;
      }
      return true;
    } catch { return false; }
    finally { try { await handle?.close(); } catch { /* iteration may already close it */ } }
  }
  for (const source of roots) {
    if (signal?.aborted || !source || typeof source.root !== "string" || !source.root) return { complete: false };
    if (!await walk(source.root, Boolean(source.archived), 0)) {
      if (!signal?.aborted) await emit();
      return { complete: false };
    }
  }
  return { complete: await emit() };
}
