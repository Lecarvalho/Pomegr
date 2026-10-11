import crypto from "node:crypto";
import path from "node:path";
import { boundedActivityDuration, boundedFileChanges } from "../../normalize/activity-events.mjs";
import { statSafe } from "../../normalize/session-discovery.mjs";
import { mutationScopes, repetitionSignature } from "../../normalize/tool-efficiency.mjs";
import { pomegrTaskAction, toolWorkKind } from "../../normalize/work-kind.mjs";
import { userInputContentType } from "./activity-events.mjs";
import { claudeToolResultTimestamps, firstClaudeToolResultAfter } from "./activity-correlation.mjs";
import { claudeFileChangeCandidates, claudeToolOutcomes, firstSuccessfulClaudeToolOutcome, safeDetail } from "./tool-detail.mjs";
import { rebaseCheckoutTarget } from "./working-checkout.mjs";

const DEFAULT_MAX_ENTRIES = 512;

function timeValue(value) {
  return new Date(value).getTime();
}

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

export function claudeToolUseWorkKind(content) {
  const tool = content.name || "Tool";
  const input = content.input || {};
  return toolWorkKind(tool, { detail: safeDetail(tool, input), input });
}

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
      const fileChangeCandidates = successfulOutcome
        ? claudeFileChangeCandidates(tool, input, successfulOutcome.toolUseResult)
        : null;
      const taskAction = successfulOutcome ? pomegrTaskAction(tool) : null;
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
        ...(taskAction ? { taskAction } : {}),
      });
    }
  }

  return { userInputActivity, toolCallTemplates, calls, updatedAt: { first, bestValid } };
}

function rebaseAgentWorktreeTarget(target, cwd) {
  if (typeof target !== "string" || !path.isAbsolute(target) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return target;
  const segments = path.relative(cwd, target).split(path.sep);
  if (segments.length < 4 || segments[0].toLowerCase() !== ".claude" || segments[1].toLowerCase() !== "worktrees") return target;
  return path.join(cwd, ...segments.slice(3));
}

function rebaseAgentWorktreeCandidates(candidates, cwd, checkouts) {
  const rebase = (target) => rebaseAgentWorktreeTarget(rebaseCheckoutTarget(target, checkouts), cwd);
  return candidates.map((candidate) => ({
    ...candidate, target: rebase(candidate.target),
    ...(candidate.previousTarget === undefined ? {} : { previousTarget: rebase(candidate.previousTarget) }),
  }));
}

function toolCallsFromTemplate(templates, actor, cwd, forbiddenRoots, validatePath, checkouts) {
  return templates.map(({ fileChangeCandidates, ...rest }) => ({
    ...rest,
    actor: { id: actor.id, label: actor.label },
    fileChanges: fileChangeCandidates
      ? boundedFileChanges(rebaseAgentWorktreeCandidates(fileChangeCandidates, cwd, checkouts), cwd, { forbiddenRoots, validatePath })
      : null,
  }));
}

export function createClaudeToolCallEvidenceReader({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const cache = new Map();

  function read({ file, key, records, actor, isMain, stat, cwd, forbiddenRoots, validatePath, checkouts = null }) {
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
      toolCalls: toolCallsFromTemplate(template.toolCallTemplates, actor, cwd, forbiddenRoots, validatePath, checkouts),
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
