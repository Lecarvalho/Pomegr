import fs from "node:fs/promises";
import path from "node:path";
import { readCodexRolloutHeader } from "./codex-session-metadata.mjs";

const DEFAULT_MAXIMUM_FILES = 500;
const DEFAULT_HINT_LIMIT = 128;
const DEFAULT_DEPTH = 5;
const DEFAULT_ADVANCE_INTERVAL_MS = 1_000;
const DEFAULT_RESCAN_INTERVAL_MS = 10_000;
const DEFAULT_YIELD_EVERY = 32;
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/i;

function boundedInteger(value, fallback, maximum) {
  return Number.isInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function generationFrom(stat) {
  return `${stat.dev ?? ""}:${stat.ino ?? ""}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs ?? ""}`;
}

function modifiedAt(stat) {
  return Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : Number.NEGATIVE_INFINITY;
}

function defaultYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Private, bounded rollout-header discovery. Returned metadata retains rollout paths for
 * the provider only; callers must not project it into browser-facing state.
 */
export function createCodexRolloutDiscovery(options = {}) {
  const maximumFiles = boundedInteger(options.maximumFiles, DEFAULT_MAXIMUM_FILES, DEFAULT_MAXIMUM_FILES);
  const hintLimit = boundedInteger(options.hintLimit, Math.min(DEFAULT_HINT_LIMIT, maximumFiles), maximumFiles);
  const scanBatchFiles = boundedInteger(options.scanBatchFiles, maximumFiles, maximumFiles);
  const scanBatchEntries = boundedInteger(options.scanBatchEntries, scanBatchFiles, DEFAULT_MAXIMUM_FILES * 4);
  const maximumDepth = boundedInteger(options.maximumDepth, DEFAULT_DEPTH, 16);
  const yieldEvery = boundedInteger(options.yieldEvery, DEFAULT_YIELD_EVERY, maximumFiles);
  const advanceIntervalMs = Math.max(0, Number(options.advanceIntervalMs ?? DEFAULT_ADVANCE_INTERVAL_MS) || 0);
  const rescanIntervalMs = Math.max(advanceIntervalMs, Number(options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS) || 0);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const operations = options.operations || fs;
  const readHeader = options.readHeader || readCodexRolloutHeader;
  const yieldControl = options.yieldControl || defaultYield;
  const roots = (Array.isArray(options.roots) ? options.roots : []).flatMap((item) => {
    if (!item || typeof item.root !== "string" || !item.root.trim()) return [];
    return [{ root: path.resolve(item.root), archived: Boolean(item.archived), pending: [], completeAt: null }];
  });
  const entries = new Map();
  const hints = new Map();
  const retainedIds = new Set();
  const rootRealpaths = new Map();
  const stats = {
    reads: 0,
    headerReads: 0,
    statReads: 0,
    scannedFiles: 0,
    scannedEntries: 0,
    yielded: 0,
    acceptedHints: 0,
    rejectedHints: 0,
    transientFailures: 0,
  };
  let lastAdvanceAt = null;
  let rootCursor = 0;
  let activeRead = null;
  let closed = false;

  function output() {
    return [...entries.values()]
      .map((entry) => entry.metadata)
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0) || left.localId.localeCompare(right.localId))
      .slice(0, maximumFiles);
  }

  function prune() {
    if (entries.size <= maximumFiles) return;
    const ranked = [...entries.entries()].sort(([leftPath, left], [rightPath, right]) => {
      const leftRetained = retainedIds.has(left.metadata?.localId) ? 1 : 0;
      const rightRetained = retainedIds.has(right.metadata?.localId) ? 1 : 0;
      if (leftRetained !== rightRetained) return rightRetained - leftRetained;
      return modifiedAt(right.stat) - modifiedAt(left.stat) || leftPath.localeCompare(rightPath);
    });
    for (const [file] of ranked.slice(maximumFiles)) entries.delete(file);
  }

  async function trustedRootFor(file) {
    let realFile;
    try { realFile = await operations.realpath(file); } catch (error) { return { error }; }
    for (const root of roots) {
      let realRoot = rootRealpaths.get(root.root);
      if (!realRoot) {
        try {
          realRoot = await operations.realpath(root.root);
          rootRealpaths.set(root.root, realRoot);
        } catch {
          continue;
        }
      }
      if (pathIsWithin(realRoot, realFile)) return { root, file: realFile };
    }
    return null;
  }

  function canAvoidHeader(file, source, stat) {
    if (source === "hint" || entries.size < maximumFiles) return false;
    let oldest = Number.POSITIVE_INFINITY;
    for (const cached of entries.values()) {
      oldest = Math.min(oldest, modifiedAt(cached.stat));
    }
    return Number.isFinite(oldest) && modifiedAt(stat) < oldest && !entries.has(file);
  }

  async function inspect(candidate, source = "scan") {
    if (closed) return;
    const trusted = await trustedRootFor(candidate);
    if (trusted?.error) {
      if (trusted.error?.code === "ENOENT") {
        const resolved = path.resolve(candidate);
        for (const file of entries.keys()) if (path.resolve(file) === resolved) entries.delete(file);
      } else stats.transientFailures += 1;
      return;
    }
    if (!trusted || !ROLLOUT_NAME.test(path.basename(trusted.file))) {
      if (source === "hint") stats.rejectedHints += 1;
      return;
    }
    let stat;
    try {
      stat = await operations.stat(trusted.file);
      stats.statReads += 1;
    } catch (error) {
      if (error?.code === "ENOENT") entries.delete(trusted.file);
      else stats.transientFailures += 1;
      return;
    }
    if (!stat.isFile()) {
      entries.delete(trusted.file);
      return;
    }
    const generation = generationFrom(stat);
    const cached = entries.get(trusted.file);
    if (cached?.generation === generation) return;
    if (canAvoidHeader(trusted.file, source, stat)) return;
    let metadata;
    try {
      stats.headerReads += 1;
      metadata = await readHeader(trusted.file, { archived: trusted.root.archived });
    } catch {
      stats.transientFailures += 1;
      return;
    }
    if (closed) return;
    // A changed file can be mid-write. Until a complete replacement validates, retain the
    // prior complete header instead of publishing an empty or partial source.
    if (!metadata || metadata.rolloutFile !== trusted.file) return;
    let confirmed;
    try {
      confirmed = await operations.stat(trusted.file);
      stats.statReads += 1;
    } catch (error) {
      if (error?.code === "ENOENT") entries.delete(trusted.file);
      else stats.transientFailures += 1;
      return;
    }
    if (closed) return;
    if (!confirmed.isFile() || generationFrom(confirmed) !== generation) return;
    entries.set(trusted.file, { generation, stat: confirmed, metadata });
    prune();
  }

  async function reconcileCache() {
    for (const file of [...entries.keys()]) await inspect(file, "cache");
  }

  function initialize(root) {
    if (!root.pending.length && root.completeAt === null) root.pending.push({ directory: root.root, depth: 0, after: null });
  }

  async function advanceRoot(root, remaining) {
    initialize(root);
    let inspected = 0;
    let work = 0;
    const passEntries = new Map();
    while (!closed && root.pending.length && work < remaining) {
      const frame = root.pending.at(-1);
      let page = passEntries.get(frame);
      if (!page) {
        try {
          const items = await operations.readdir(frame.directory, { withFileTypes: true });
          items.sort((left, right) => right.name.localeCompare(left.name));
          page = {
            items,
            index: frame.after === null ? 0 : items.findIndex((entry) => entry.name.localeCompare(frame.after) < 0),
          };
          passEntries.set(frame, page);
        } catch {
          root.pending.pop();
          continue;
        }
      }
      const next = page.index >= 0 ? page.items[page.index] : null;
      if (!next) {
        root.pending.pop();
        continue;
      }
      page.index += 1;
      frame.after = next.name;
      work += 1;
      stats.scannedEntries += 1;
      const full = path.join(frame.directory, next.name);
      if (next.isDirectory() && frame.depth < maximumDepth) {
        root.pending.push({ directory: full, depth: frame.depth + 1, after: null });
      } else if (next.isFile() && ROLLOUT_NAME.test(next.name)) {
        inspected += 1;
        stats.scannedFiles += 1;
        await inspect(full);
      }
      if (work % yieldEvery === 0) {
        stats.yielded += 1;
        await yieldControl();
      }
    }
    if (!root.pending.length) root.completeAt = now();
    return inspected;
  }

  async function advanceHistory() {
    const time = now();
    const firstPass = lastAdvanceAt === null;
    if (!firstPass && time - lastAdvanceAt < advanceIntervalMs) return;
    if (roots.length && roots.every((root) => root.completeAt !== null)) {
      const sweepFinishedAt = Math.max(...roots.map((root) => root.completeAt));
      if (!firstPass && time - sweepFinishedAt < rescanIntervalMs) return;
      for (const root of roots) {
        root.pending = [];
        root.completeAt = null;
      }
    }
    let remaining = scanBatchEntries;
    const startCursor = rootCursor;
    for (let offset = 0; offset < roots.length && remaining > 0 && !closed; offset += 1) {
      const index = (startCursor + offset) % roots.length;
      const root = roots[index];
      if (root.completeAt !== null) continue;
      const before = stats.scannedEntries;
      await advanceRoot(root, remaining);
      remaining -= stats.scannedEntries - before;
      rootCursor = root.pending.length ? index : (index + 1) % roots.length;
    }
    lastAdvanceAt = time;
  }

  async function scanRecent() {
    let remaining = scanBatchEntries;
    for (const root of roots) {
      if (closed || remaining <= 0) return;
      const before = stats.scannedEntries;
      // Check recent files without resetting the ongoing historical sweep.
      await advanceRoot({ ...root, pending: [], completeAt: null }, remaining);
      remaining -= stats.scannedEntries - before;
    }
  }

  async function processHints() {
    const queued = [...hints.keys()];
    hints.clear();
    for (const candidate of queued) {
      if (closed) return;
      await inspect(candidate, "hint");
    }
    return queued.length > 0;
  }

  async function load(readOptions = {}) {
    stats.reads += 1;
    const handledHint = await processHints();
    if (!closed) await reconcileCache();
    // An exact watcher source is already the cheapest fresh reconciliation. Do not pair a
    // burst of exact hints with a second recent-tree pass.
    if (!closed && readOptions?.fresh && !handledHint) await scanRecent();
    if (!closed) await advanceHistory();
    return output();
  }

  return {
    async read(readOptions = {}) {
      if (closed) return output();
      if (!activeRead) activeRead = load(readOptions).finally(() => { activeRead = null; });
      const rows = await activeRead;
      return [...rows];
    },
    notice(file) {
      if (closed || typeof file !== "string" || !file.trim()) return;
      const candidate = path.resolve(file);
      if (!ROLLOUT_NAME.test(path.basename(candidate)) || !roots.some((root) => pathIsWithin(root.root, candidate))) {
        stats.rejectedHints += 1;
        return;
      }
      if (hints.has(candidate)) return;
      if (hints.size >= hintLimit) hints.delete(hints.keys().next().value);
      hints.set(candidate, true);
      stats.acceptedHints += 1;
    },
    retain(sessionIds) {
      retainedIds.clear();
      for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
        if (typeof sessionId !== "string" || !sessionId || retainedIds.size >= maximumFiles) continue;
        retainedIds.add(sessionId);
      }
      prune();
    },
    stats() {
      return {
        ...stats,
        cachedHeaders: entries.size,
        queuedHints: hints.size,
        retainedIds: retainedIds.size,
        cursorDirectories: roots.reduce((count, root) => count + root.pending.length, 0),
      };
    },
    close() {
      closed = true;
      hints.clear();
      for (const root of roots) root.pending = [];
    },
  };
}
