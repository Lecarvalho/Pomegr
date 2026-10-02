import crypto from "node:crypto";
import path from "node:path";
import { boundedActivityDuration, boundedFileChanges } from "../../normalize/activity-events.mjs";
import { statSafe } from "../../normalize/session-discovery.mjs";
import { mutationScopes, repetitionSignature } from "../../normalize/tool-efficiency.mjs";
import { toolWorkKind } from "../../normalize/work-kind.mjs";
import { userInputContentType } from "./activity-events.mjs";
import { claudeToolResultTimestamps, firstClaudeToolResultAfter } from "./activity-correlation.mjs";
import { claudeFileChangeCandidates, claudeToolOutcomes, firstSuccessfulClaudeToolOutcome, safeDetail } from "./tool-detail.mjs";

const DEFAULT_MAX_ENTRIES = 512;

function timeValue(value) {
  return new Date(value).getTime();
}

/**
 * Sequential fold semantics for `session.updatedAt`: `if (!u || new Date(t) > new Date(u)) u = t`
 * over every truthy record timestamp of every file, in file order. This is not associative -- once
 * the running value becomes a truthy but unparseable string, no later (even valid) timestamp can
 * ever satisfy `new Date(t) > new Date(u)` (both sides of the comparison involve NaN, which compares
 * false against anything), so the value gets "stuck" at that first invalid timestamp for the rest of
 * the fold, across every remaining file.
 *
 * `fileResult` is `{ first, bestValid }`: `first` is this file's first truthy raw timestamp (or
 * null), and `bestValid` is the running max (ties keep the earliest occurrence) over only this
 * file's *valid* truthy timestamps, ignoring invalid ones structurally. `current` is the accumulator
 * as a plain nullable string, exactly mirroring the original `updatedAt` variable -- including the
 * "stuck invalid" state, which needs no separate flag: `Date.parse`/`new Date` of an invalid string
 * is NaN, and `X > NaN` is always false, so a stuck `current` naturally never advances again.
 */
export function mergeUpdatedAt(current, fileResult) {
  const first = fileResult?.first ?? null;
  const bestValid = fileResult?.bestValid ?? null;
  if (current === null || current === undefined) {
    if (first === null) return current ?? null;
    return Number.isFinite(timeValue(first)) ? bestValid : first;
  }
  if (bestValid === null) return current;
  return timeValue(bestValid) > timeValue(current) ? bestValid : current;
}

/** The work kind of one tool_use block; the whole-transcript pass counts with this same rule. */
export function claudeToolUseWorkKind(content) {
  const tool = content.name || "Tool";
  const input = content.input || {};
  return toolWorkKind(tool, { detail: safeDetail(tool, input), input });
}

/**
 * Everything about one file's tool_use loop that depends only on its transcript records, its stat
 * (folded in only through the fallback timestamp, which is itself part of the file's generation),
 * and whether the file is the session's main transcript. Excludes the per-call `actor` label and
 * `fileChanges`, both of which must reflect the *current* read (see `read` below).
 */
function computeTemplate(file, records, stat, isMain) {
  const requestedInputIds = new Set();
  const resultTimes = claudeToolResultTimestamps(records);
  const toolOutcomes = claudeToolOutcomes(records);
  let calls = 0;
  const userInputActivity = [];
  const toolCallTemplates = [];
  let first = null;
  let bestValid = null;

  for (const record of records) {
    const timestamp = record.timestamp || record.message?.timestamp;
    if (timestamp) {
      if (first === null) first = timestamp;
      const time = timeValue(timestamp);
      if (Number.isFinite(time) && (bestValid === null || time > timeValue(bestValid))) bestValid = timestamp;
    }
    const userInputType = isMain ? userInputContentType(record, requestedInputIds) : null;
    if (userInputType) userInputActivity.push({
      id: record.uuid || crypto.createHash("sha1").update(`${file}:${timestamp}:user-input`).digest("hex").slice(0, 12),
      timestamp: timestamp || stat.mtime.toISOString(),
      actor: "User",
      tool: "User input",
      workKind: "input",
      detail: userInputType,
      status: null,
    });
    if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (content.type !== "tool_use") continue;
      calls += 1;
      const tool = content.name || "Tool";
      if (tool === "AskUserQuestion" && content.id) requestedInputIds.add(content.id);
      const input = content.input || {};
      const detail = safeDetail(tool, input);
      const target = input.file_path || input.path;
      const scopes = typeof target === "string"
        ? mutationScopes(tool, input).map((scope) => crypto.createHash("sha256").update(scope).digest("hex").slice(0, 20))
        : [];
      const successfulOutcome = firstSuccessfulClaudeToolOutcome(toolOutcomes, content.id, timestamp);
      // The candidates are deterministic from records alone; only turning them into validated,
      // cwd-relative fileChanges depends on the current cwd/validator, so that step stays outside
      // the cached template (see `read`).
      const fileChangeCandidates = successfulOutcome
        ? claudeFileChangeCandidates(tool, input, successfulOutcome.toolUseResult)
        : null;
      toolCallTemplates.push({
        id: content.id || crypto.createHash("sha1").update(`${file}:${timestamp}:${calls}:${tool}`).digest("hex").slice(0, 12),
        timestamp: timestamp || stat.mtime.toISOString(),
        tool,
        workKind: claudeToolUseWorkKind(content),
        detail,
        status: null,
        durationMs: boundedActivityDuration(timestamp, firstClaudeToolResultAfter(resultTimes, content.id, timestamp)),
        requestId: null,
        repetitionSignature: repetitionSignature(tool, input),
        mutation: scopes.length ? { display: path.basename(target), scopes } : null,
        fileChangeCandidates,
      });
    }
  }

  return { userInputActivity, toolCallTemplates, calls, updatedAt: { first, bestValid } };
}

/**
 * Claude Code checks an isolated agent's worktree out at `<cwd>/.claude/worktrees/<name>/`, so a
 * structured file tool run there targets the same repository-relative path under a private-root
 * prefix the path validator rejects outright. Rebase such a target onto the session cwd; anything
 * else (including a target naming the worktree directory itself) is returned unchanged. The
 * remainder still goes through the validator, so a provider folder inside the worktree stays
 * rejected.
 */
function rebaseAgentWorktreeTarget(target, cwd) {
  if (typeof target !== "string" || !path.isAbsolute(target) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return target;
  const segments = path.relative(cwd, target).split(path.sep);
  if (segments.length < 4 || segments[0].toLowerCase() !== ".claude" || segments[1].toLowerCase() !== "worktrees") return target;
  return path.join(cwd, ...segments.slice(3));
}

function rebaseAgentWorktreeCandidates(candidates, cwd) {
  return candidates.map((candidate) => ({ ...candidate, target: rebaseAgentWorktreeTarget(candidate.target, cwd) }));
}

function toolCallsFromTemplate(templates, actor, cwd, forbiddenRoots, validatePath) {
  return templates.map(({ fileChangeCandidates, ...rest }) => ({
    ...rest,
    actor: { id: actor.id, label: actor.label },
    fileChanges: fileChangeCandidates
      ? boundedFileChanges(rebaseAgentWorktreeCandidates(fileChangeCandidates, cwd), cwd, { forbiddenRoots, validatePath })
      : null,
  }));
}

/**
 * Per-file tool_use-loop evidence: the toolCalls and "User input" activity events claude.mjs's
 * readSession built inline (~lines 355-405), plus the file's tool_use count and its contribution to
 * `session.updatedAt`. Everything deterministic from the transcript is cached per file, keyed by
 * `key` (an opaque generation-key string, see claude-file-generation.mjs / claude-read-generations.mjs)
 * plus `actor.id` and `isMain` (both of which the record pass itself depends on: `isMain` gates
 * whether user-input activity is produced at all, matching claude.mjs's `file === mainFile` check).
 * `fileChanges` is never cached: it is recomputed on every read for every call with a successful
 * outcome, since the path validator has a short TTL and `cwd` can change between reads. Every
 * returned tool call is a fresh object with a fresh `actor: { id, label }` taken from the current
 * `actor`, never the cached one. A null `key` never caches (completeHistory/unlimited reads).
 */
export function createClaudeToolCallEvidenceReader({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const cache = new Map();

  function read({ file, key, records, actor, isMain, stat, cwd, forbiddenRoots, validatePath }) {
    const cacheKey = key ? `${key}\u0000${actor.id}\u0000${Boolean(isMain)}` : null;
    let template;
    if (!cacheKey) {
      template = computeTemplate(file, records, stat, isMain);
    } else {
      const cached = cache.get(file);
      if (cached && cached.key === cacheKey) {
        cache.delete(file);
        cache.set(file, cached);
        template = cached.template;
      } else {
        template = computeTemplate(file, records, stat, isMain);
        cache.delete(file);
        cache.set(file, { key: cacheKey, template });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
    }

    return {
      toolCalls: toolCallsFromTemplate(template.toolCallTemplates, actor, cwd, forbiddenRoots, validatePath),
      userInputActivity: template.userInputActivity.map((event) => ({ ...event })),
      calls: template.calls,
      updatedAt: template.updatedAt,
    };
  }

  function pruneMissingFiles(exists = (file) => Boolean(statSafe(file))) {
    for (const file of cache.keys()) {
      if (!exists(file)) cache.delete(file);
    }
  }

  return { read, pruneMissingFiles };
}
