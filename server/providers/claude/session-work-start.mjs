import fs from "node:fs";
import { createClaudeSessionWorkStartState, reduceClaudeSessionWorkStart } from "./activity-events.mjs";
import { priorFileSuffixStillMatches } from "./file-generation.mjs";
import { claudeUserMessageTimesFromState, createClaudeUserMessageTimeState, reduceClaudeUserMessageTimes } from "./user-message-times.mjs";
import { reduceSkillUsage, skillUsageFromState } from "../../normalize/skill-usage.mjs";
import { claudeToolUseWorkKind } from "./tool-call-evidence.mjs";
import { createToolChangeState, markToolChangeGap, reduceToolChange, toolChangeCauses } from "./tool-change-attribution.mjs";
import { createIncrementalJsonlIngestor } from "../kernel/incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "../kernel/incremental-provider-observer.mjs";
import { claudeUsageEvidenceRecord } from "./context.mjs";
import { runtimeMetadata } from "./session-identity.mjs";

const CHUNK_BYTES = 256 * 1024;
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;
const MAX_USAGE_EVIDENCE_RECORDS = 32_768;

// Content-free copies of every record, so request evidence never depends on the bounded record tail.
// A skipped record could be a request: the gap marker breaks cache comparability across it.
function reduceUsageEvidence(state, record) {
  const copy = claudeUsageEvidenceRecord(record);
  if (copy) state.records.push(copy);
  if (state.records.length > MAX_USAGE_EVIDENCE_RECORDS) {
    state.records.splice(0, state.records.length - MAX_USAGE_EVIDENCE_RECORDS);
    state.complete = false;
  }
  return state;
}

function markUsageEvidenceGap(state) {
  return reduceUsageEvidence(state, { type: "assistant", message: {} });
}

// Running per-work-kind tool-use counts; the same blocks and classification as the tail's tool_use
// loop. Only the bounded kind and a count are kept, never a tool name, input, or detail.
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

export function createClaudeSessionWorkStartReader(options = {}) {
  const maximumEntries = Number.isInteger(options.maximumEntries)
    ? Math.max(1, Math.min(options.maximumEntries, 256)) : 64;
  const entries = new Map();

  function createEntry(file, { expectedSessionId = "", inlineSidechains = false } = {}) {
    return {
      source: null,
      generation: 0,
      identity: null,
      startedAt: null,
      userMessageTimes: [],
      toolKinds: {},
      skills: [],
      toolChangeCauses: new Map(),
      usageEvidence: null,
      runtime: runtimeMetadata([]),
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
        initialState: () => ({ workStart: createClaudeSessionWorkStartState(), userMessages: createClaudeUserMessageTimeState(), toolKinds: {}, skills: {},
          toolChanges: createToolChangeState({ expectedSessionId, inlineSidechains }), usage: { records: [], complete: true }, runtime: runtimeMetadata([]) }),
        reduce: (state, record) => ({
          workStart: reduceClaudeSessionWorkStart(state.workStart, record),
          userMessages: reduceClaudeUserMessageTimes(state.userMessages, record),
          toolKinds: reduceClaudeToolUseKinds(state.toolKinds, record),
          skills: reduceSkillUsage(state.skills, record),
          toolChanges: reduceToolChange(state.toolChanges, record),
          usage: reduceUsageEvidence(state.usage, record),
          runtime: runtimeMetadata([record], state.runtime),
        }),
        reduceGap: (state) => ({ ...state, toolChanges: markToolChangeGap(state.toolChanges), usage: markUsageEvidenceGap(state.usage) }),
        chunkBytes: CHUNK_BYTES,
        maximumFragmentBytes: MAX_FRAGMENT_BYTES,
        yieldControl: options.yieldControl,
      }),
    };
  }

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
      && (source.size > previous.size || source.mtimeMs === previous.mtimeMs)
      && (previous.size === 0 || priorFileSuffixStillMatches(file, previous));
    if (!appendCompatible) entry.identity = `${source.identity}:work-start:${++entry.generation}`;
    entry.source = source;
    let confirmed = false;
    await entry.ingestor.observe({ identity: entry.identity, size: source.size }, (state) => {
      assertSourceStillHolds(file, source);
      confirmed = true;
      entry.startedAt = state.workStart.startedAt;
    });
    if (!confirmed) assertSourceStillHolds(file, source);
    const committed = /** @type {{ candidate: { userMessages: { times: number[] }, toolKinds: Record<string, number>, skills: Record<string, { calls: number, lastUsed: string | null }>, toolChanges: ReturnType<typeof createToolChangeState>, usage: { records: object[], complete: boolean }, runtime: ReturnType<typeof runtimeMetadata> }, completeOffset: number } | null} */ (entry.ingestor.snapshot());
    entry.userMessageTimes = committed ? claudeUserMessageTimesFromState(committed.candidate.userMessages) : [];
    entry.toolKinds = committed ? { ...committed.candidate.toolKinds } : {};
    entry.skills = committed ? skillUsageFromState(committed.candidate.skills) : [];
    entry.runtime = committed ? { ...committed.candidate.runtime } : runtimeMetadata([]);
    entry.toolChangeCauses = committed ? toolChangeCauses(committed.candidate.toolChanges) : new Map();
    // A copy: the next observation appends to the committed list while this one is in use.
    entry.usageEvidence = committed ? { key: `${entry.identity}:${committed.completeOffset}`, records: committed.candidate.usage.records.slice(),
      complete: committed.candidate.usage.complete } : null;
    return entry;
  }

  function observed(file, context) {
    const entry = entries.get(file) || createEntry(file, context);
    entries.delete(file);
    entries.set(file, entry);
    while (entries.size > maximumEntries) entries.delete(entries.keys().next().value);
    const result = entry.pending.then(() => observe(file, entry));
    entry.pending = result.catch(() => {});
    return result;
  }

  function read(file) {
    return observed(file).then((entry) => entry.startedAt);
  }

  function readSessionFacts(file) {
    return observed(file).then((entry) => ({ startedAt: entry.startedAt, userMessageTimes: entry.userMessageTimes }));
  }

  function readTranscriptFacts(file, context) {
    return observed(file, context).then((entry) => ({ startedAt: entry.startedAt, userMessageTimes: entry.userMessageTimes,
      toolUses: toolUseTotal(entry.toolKinds), toolKinds: { ...entry.toolKinds }, skills: entry.skills.map((skill) => ({ ...skill })),
      toolChangeCauses: entry.toolChangeCauses, usageEvidence: entry.usageEvidence, runtime: { ...entry.runtime } }));
  }

  function readToolUseCount(file) {
    return observed(file).then((entry) => toolUseTotal(entry.toolKinds));
  }

  return Object.freeze({ read, readSessionFacts, readTranscriptFacts, readToolUseCount });
}
