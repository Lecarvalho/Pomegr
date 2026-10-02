import fs from "node:fs";
import { createClaudeSessionWorkStartState, reduceClaudeSessionWorkStart } from "./activity-events.mjs";
import { priorFileSuffixStillMatches } from "./file-generation.mjs";
import { claudeUserMessageTimesFromState, createClaudeUserMessageTimeState, reduceClaudeUserMessageTimes } from "./user-message-times.mjs";
import { reduceSkillUsage, skillUsageFromState } from "../../normalize/skill-usage.mjs";
import { claudeToolUseWorkKind } from "./tool-call-evidence.mjs";
import { createIncrementalJsonlIngestor } from "../kernel/incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "../kernel/incremental-provider-observer.mjs";

const CHUNK_BYTES = 256 * 1024;
// A user record can embed an attachment; this is the ingestor's largest complete-line budget.
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;

/**
 * Running per-work-kind tool-use counts; the same blocks and classification as the tail's tool_use
 * loop. Only the bounded kind and a count are kept, never a tool name, input, or detail.
 */
export function reduceClaudeToolUseKinds(state, record) {
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return state;
  const uses = record.message.content.filter((content) => content?.type === "tool_use");
  if (!uses.length) return state;
  const next = { ...state };
  for (const content of uses) {
    const kind = claudeToolUseWorkKind(content);
    next[kind] = (next[kind] || 0) + 1;
  }
  return next;
}

function toolUseTotal(kinds) {
  return Object.values(kinds).reduce((total, count) => total + count, 0);
}

/**
 * Complete-source session facts with bounded private state, independent of the display tail: one
 * replay of the whole main transcript, then appended bytes only, feeds both the work-start time
 * and the recorded user-message times, so the transcript is read and parsed once for both. The same
 * pass counts recorded tool uses per work kind and skill invocations, so an agent's call, work-kind
 * and skill counts never shrink when its transcript outgrows the display tail.
 */
export function createClaudeSessionWorkStartReader(options = {}) {
  const maximumEntries = Number.isInteger(options.maximumEntries)
    ? Math.max(1, Math.min(options.maximumEntries, 256)) : 64;
  const entries = new Map();

  function createEntry(file) {
    return {
      source: null,
      generation: 0,
      identity: null,
      startedAt: null,
      userMessageTimes: [],
      toolKinds: {},
      skills: [],
      pending: Promise.resolve(),
      ingestor: createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            const read = fs.readSync(descriptor, buffer, 0, bytes, offset);
            return buffer.subarray(0, read);
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord: (line) => JSON.parse(line.toString("utf8")),
        initialState: () => ({ workStart: createClaudeSessionWorkStartState(), userMessages: createClaudeUserMessageTimeState(), toolKinds: {}, skills: {} }),
        reduce: (state, record) => ({
          workStart: reduceClaudeSessionWorkStart(state.workStart, record),
          userMessages: reduceClaudeUserMessageTimes(state.userMessages, record),
          toolKinds: reduceClaudeToolUseKinds(state.toolKinds, record),
          skills: reduceSkillUsage(state.skills, record),
        }),
        chunkBytes: CHUNK_BYTES,
        maximumFragmentBytes: MAX_FRAGMENT_BYTES,
        yieldControl: options.yieldControl,
      }),
    };
  }

  // The state covers bytes up to `source.size`. A live transcript that only grew during the
  // observation still holds that exact prefix, so the state stays valid and the next read
  // continues from it; only a replaced, truncated, or rewritten prefix is rejected.
  function assertSourceStillHolds(file, source) {
    const confirmed = incrementalSourceDescriptor(file);
    const unchanged = confirmed && confirmed.size === source.size && confirmed.mtimeMs === source.mtimeMs
      && confirmed.suffixDigest === source.suffixDigest;
    const appended = confirmed && confirmed.size > source.size
      && (source.size === 0 || priorFileSuffixStillMatches(file, source));
    if (!confirmed || confirmed.identity !== source.identity || !(unchanged || appended)) {
      throw new Error("Session timing source changed during observation");
    }
  }

  async function observe(file, entry) {
    const source = incrementalSourceDescriptor(file);
    if (!source) throw new Error("Session timing source is unavailable");
    const previous = entry.source;
    const appendCompatible = previous && previous.identity === source.identity
      && source.size >= previous.size && source.mtimeMs >= previous.mtimeMs
      && (previous.size === 0 || priorFileSuffixStillMatches(file, previous));
    if (!appendCompatible) entry.identity = `${source.identity}:work-start:${++entry.generation}`;
    entry.source = source;
    let confirmed = false;
    await entry.ingestor.observe({ identity: entry.identity, size: source.size }, (state) => {
      assertSourceStillHolds(file, source);
      confirmed = true;
      entry.startedAt = state.workStart.startedAt;
    });
    // User-message times come from the committed state, not only a published one: every complete
    // record counts even while the final line is still being written, and an incomplete
    // replacement keeps the prior generation's answer. A failed observation never reaches here,
    // so the next read resumes from the last committed offset instead of serving a stale list.
    if (!confirmed) assertSourceStillHolds(file, source);
    const committed = /** @type {{ candidate: { userMessages: { times: number[] }, toolKinds: Record<string, number>, skills: Record<string, { calls: number, lastUsed: string | null }> } } | null} */ (entry.ingestor.snapshot());
    entry.userMessageTimes = committed ? claudeUserMessageTimesFromState(committed.candidate.userMessages) : [];
    entry.toolKinds = committed ? { ...committed.candidate.toolKinds } : {};
    entry.skills = committed ? skillUsageFromState(committed.candidate.skills) : [];
    return entry;
  }

  function observed(file) {
    const entry = entries.get(file) || createEntry(file);
    entries.delete(file);
    entries.set(file, entry);
    while (entries.size > maximumEntries) entries.delete(entries.keys().next().value);
    const result = entry.pending.then(() => observe(file, entry));
    entry.pending = result.catch(() => {});
    return result;
  }

  /** The first recorded main-session action that initiated model work, or null. */
  function read(file) {
    return observed(file).then((entry) => entry.startedAt);
  }

  /** One pass for both facts: `{ startedAt, userMessageTimes }` (ISO times, oldest to newest). */
  function readSessionFacts(file) {
    return observed(file).then((entry) => ({ startedAt: entry.startedAt, userMessageTimes: entry.userMessageTimes }));
  }

  /**
   * `readSessionFacts` plus the whole-transcript tool-use total, its per-work-kind counts, and the
   * skill usage list, from the same single observation.
   */
  function readTranscriptFacts(file) {
    return observed(file).then((entry) => ({ startedAt: entry.startedAt, userMessageTimes: entry.userMessageTimes,
      toolUses: toolUseTotal(entry.toolKinds), toolKinds: { ...entry.toolKinds }, skills: entry.skills.map((skill) => ({ ...skill })) }));
  }

  /** Recorded tool uses in the whole transcript, counted like the tail's tool_use loop. */
  function readToolUseCount(file) {
    return observed(file).then((entry) => toolUseTotal(entry.toolKinds));
  }

  return Object.freeze({ read, readSessionFacts, readTranscriptFacts, readToolUseCount });
}
