import { parseCodexContextRecords } from "./context.mjs";
import { parseCodexActivityRecords, parseCodexAssistantReplyRecords } from "./activity-events.mjs";
import { rolloutExecutionItemKind } from "./execution-items.mjs";
import { requestSnapshotIdsByEvidence } from "../../normalize/request-snapshots.mjs";
import { normalizedRequestWork } from "../../normalize/request-work.mjs";
import { parseCodexUserInputRecords } from "./user-input.mjs";

const normalizedType = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const MAX_OUTPUTS_PER_REQUEST = 4_096;

function usageParts(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const input = usage.input_tokens;
  const read = usage.cached_input_tokens ?? 0;
  const write = usage.cache_write_input_tokens ?? 0;
  const output = usage.output_tokens;
  if (![input, read, write, output].every((value) => Number.isSafeInteger(value) && value >= 0)
    || read + write > input || input + output <= 0) return null;
  return { input: input - read - write, cacheRead: read, cacheWrite: write, output };
}

function boundary(record) {
  const outer = normalizedType(record?.type);
  const type = normalizedType(record?.payload?.type);
  const item = normalizedType(record?.payload?.item?.type);
  return ["sessionmeta", "turncontext", "turnstarted", "turncompleted", "turnaborted", "compacted", "compaction", "compactboundary"].includes(outer)
    || ["taskstarted", "taskcomplete", "taskcompleted", "turnstarted", "turncompleted", "turnaborted",
      "userinput", "usermessage", "userprompt", "contextcompacted", "contextcompaction", "compactboundary"].includes(type)
    || item === "contextcompaction"
    || (outer === "responseitem" && type === "message" && record.payload.role !== "assistant");
}

/** Correlation stays private and follows source order, never timestamp proximity. */
export function parseCodexRequestActivityEvidence(records, options = {}) {
  const usages = new Map();
  const outputs = new Map();
  const addOutput = (index, event) => { if (event) outputs.set(index, event.id); };
  const context = parseCodexContextRecords(records, { ...options, onUsageSnapshot: (index, snapshot) => usages.set(index, snapshot) });
  const nested = new Map();
  const toolCalls = parseCodexActivityRecords(records, { ...options, onCall: addOutput, onNested: (id, wrapperId) => nested.set(id, wrapperId) });
  const replies = parseCodexAssistantReplyRecords(records, { ...options, onReply: addOutput });
  const inputsByIndex = new Map();
  const inputs = parseCodexUserInputRecords(records, { ...options, onInput: (index, event) => inputsByIndex.set(index, event.id) });
  const links = new Map();
  let input = null;
  let turnId = null;
  let pending = new Set();
  let sealed = null;
  let sawResult = false;
  let invalid = false;
  let sawResponse = false;
  const reset = () => { pending = new Set(); sealed = null; sawResult = false; invalid = false; input = null; sawResponse = false; };
  for (const [index, record] of records.entries()) {
    const outer = normalizedType(record?.type);
    const type = normalizedType(record?.payload?.type);
    if (inputsByIndex.has(index)) {
      reset();
      input = inputsByIndex.get(index);
      continue;
    }
    const nextTurnId = record?.payload?.turn_id ?? record?.payload?.turnId;
    if (outer === "turncontext") {
      // Context for the same initiating turn may follow its user delivery. A changed turn,
      // or context arriving after response work began, cannot carry that input forward.
      const retainedInput = record.synthetic !== true && record.payload?.synthetic !== true
        && typeof nextTurnId === "string" && nextTurnId
        && (!turnId || turnId === nextTurnId) && !sawResponse && !sealed && !sawResult ? input : null;
      reset();
      turnId = typeof nextTurnId === "string" && nextTurnId ? nextTurnId : null;
      input = retainedInput;
      continue;
    }
    if (["taskstarted", "turnstarted"].includes(type)) turnId = typeof nextTurnId === "string" ? nextTurnId : null;
    if (boundary(record) || record?.synthetic === true) { reset(); continue; }
    if (outer === "tokenusagerecord") {
      const parts = usageParts(record.payload?.usage);
      if (!parts || sealed || record.payload?.synthetic === true) invalid = true;
      sealed = { ids: pending, parts };
      pending = new Set();
      continue;
    }
    if (outer === "tokencount" || type === "tokencount") {
      const snapshot = usages.get(index);
      const matches = !sealed || (sealed.parts && ["input", "cacheRead", "cacheWrite", "output"]
        .every((key) => sealed.parts[key] === snapshot?.[key]));
      if (snapshot && !invalid && matches && !record.payload?.synthetic
        && Number.isFinite(Date.parse(record.timestamp ?? record.payload?.timestamp))) {
        const key = `${snapshot.actorId}\u0000${snapshot.dedupeId}`;
        for (const id of sealed?.ids || pending) {
          // Repeated mirrors are harmless; conflicting request ownership is not.
          links.set(id, links.has(id) && links.get(id) !== key ? null : key);
        }
        if (input && sawResponse) links.set(input, links.has(input) && links.get(input) !== key ? null : key);
      }
      reset();
      continue;
    }
    const result = ["functioncalloutput", "customtoolcalloutput", "toolsearchoutput"].includes(type)
      || ["execcommandend", "patchapplyend", "mcptoolcallend", "websearchend", "imagegenerationend"].includes(type)
      // A patch, command or MCP call completed inside an exec cell is execution evidence, not a
      // second model response. It cannot invalidate the wrapper's already-sealed request association.
      || (outer === "eventmsg" && Boolean(rolloutExecutionItemKind(record.payload)));
    if (result) { sawResult = true; continue; }
    const output = outputs.get(index);
    const beginsOutput = output || (outer === "responseitem" && type === "reasoning")
      || (outer === "eventmsg" && type === "agentreasoning");
    if (beginsOutput && sawResult && !sealed) { reset(); }
    if (beginsOutput) sawResponse = true;
    // A second response before the closing usage observation is ambiguous.
    if (beginsOutput && sealed) invalid = true;
    if (output && !invalid) pending.add(output);
    if (pending.size > MAX_OUTPUTS_PER_REQUEST) { pending.clear(); invalid = true; }
  }
  // A command or MCP call recorded inside one open code-mode wrapper is listed under the request
  // that issued the wrapper. It never gains a link the wrapper does not have, and a nested file
  // change is never linked this way.
  for (const [id, wrapperId] of nested) {
    const key = links.get(wrapperId);
    if (key && !links.has(id)) links.set(id, key);
  }
  return { ...context, toolCalls, replies, inputs, links };
}

/** Merge canonical/rollout rows first, then stamp only proven opaque request IDs. */
export function stampCodexActivityRequestIds({ sessionId, agents, usageSnapshots, toolCalls, activity, linkGroups, unlimited = false }) {
  const requestIds = requestSnapshotIdsByEvidence({ sessionId: `codex:${sessionId}`, agents, usageSnapshots, unlimited });
  const links = new Map();
  for (const group of linkGroups) for (const [id, key] of group) {
    links.set(id, links.has(id) && links.get(id) !== key ? null : key);
  }
  const work = new Map();
  for (const event of [...toolCalls, ...activity]) {
    const key = links.get(event.id);
    const requestId = key && requestIds.get(key);
    if (requestId) event.requestId = requestId;
  }
  for (const call of toolCalls) {
    if (!call.requestId || call.wrapper === true) continue;
    const counts = work.get(call.requestId) || new Map();
    counts.set(call.workKind, (counts.get(call.workKind) || 0) + 1);
    work.set(call.requestId, counts);
  }
  for (const snapshot of usageSnapshots) {
    const counts = work.get(requestIds.get(`${snapshot.actorId}\u0000${snapshot.dedupeId}`));
    if (counts) snapshot.issuedWork = normalizedRequestWork([...counts].map(([kind, count]) => ({ kind, count })));
  }
}
