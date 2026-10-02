import {
  assistantIdentity, assistantRecord, boundedIdentity, normalizedCacheMissReason, plainObject, structuredContent, structuredToolResultIds,
} from "./record-shapes.mjs";

/**
 * Tool-change attribution as reducers over a transcript's records, so one rule set serves a complete
 * in-memory record list and the incremental whole-transcript pass whose bounded state does not depend
 * on the 2 MiB display tail. Decisions are made when a request is first seen with `tools_changed` and
 * kept (newest `MAX_DECISIONS`), so a later read never withdraws or alters one. Entry names are replayed
 * only to tell new from known; no name, description, schema, identifier or search query leaves this module.
 */

const DEFERRED_DEFINITIONS_LOADED = "deferred_definitions_loaded";
const REMOTE_CONTROL_CONNECTED = "remote_control_connected";
const REMOTE_CONTROL_ACTIVE_PREFIX = "/remote-control is active";
const MAX_BRIDGE_STATUS_DISTANCE = 12;
const MAX_ADDED_DEFINITIONS = 64;
const MAX_DEFINITION_NAME_LENGTH = 256;
// The usage window keeps at most the newest 1,000 requests; the name set is far above any real deferred roster.
const MAX_DECISIONS = 1_000;
const MAX_KNOWN_DEFINITIONS = 8_192;

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_DECISIONS) map.delete(map.keys().next().value);
}

/** `inlineSidechains`: skip inline sidechain records, which a primary transcript can carry for its subagents. */
export function createToolChangeState({ expectedSessionId = "", inlineSidechains = false } = {}) {
  return {
    deferred: { inlineSidechains, known: new Set(), loads: new Map(), request: null, pending: null, gap: false },
    remote: { expectedSessionId, index: 0, lastAssistantId: "", distinct: 0, sawBridge: false, candidate: null, causes: new Map(), gap: false },
  };
}

export function reduceToolChange(state, record) {
  reduceDeferredDefinitions(state.deferred, record);
  reduceRemoteControl(state.remote, record);
  return state;
}

/** A record the source could not read: no new attribution is made from here, and none already made changes. */
export function markToolChangeGap(state) {
  state.deferred.gap = true;
  state.remote.gap = true;
  return state;
}

/** Request identity -> `{ cause, added? }`. A competing transition or a Remote Control claim on the same request makes a load ambiguous. */
export function toolChangeCauses(state) {
  const causes = new Map();
  const remote = new Map(state.remote.causes);
  for (const [identity, { added, competing }] of state.deferred.loads) {
    if (remote.delete(identity) || competing) continue;
    causes.set(identity, { cause: DEFERRED_DEFINITIONS_LOADED, added });
  }
  for (const [identity, cause] of remote) causes.set(identity, { cause });
  return causes;
}

/** Attribution over a complete record list. */
export function inferredToolChangeCauses(records, options) {
  const state = createToolChangeState(options);
  for (const record of Array.isArray(records) ? records : []) reduceToolChange(state, record);
  return toolChangeCauses(state);
}

/** Entry names of a provider-written `deferred_tools_record`, null for any other record; an unreadable entry is null. */
function deferredDefinitionNames(record) {
  const attachment = record?.type === "attachment" ? record.attachment : null;
  if (!plainObject(attachment) || attachment.type !== "deferred_tools_record" || !Array.isArray(attachment.entries)) return null;
  return attachment.entries.map((entry) => (plainObject(entry) && typeof entry.name === "string"
    && entry.name.length > 0 && entry.name.length <= MAX_DEFINITION_NAME_LENGTH ? entry.name : null));
}

/** A provider-owned record that is a competing transition in a request interval: a bridge, delta, compaction, or new user prompt. */
function competingTransitionRecord(record) {
  return record?.type === "bridge-session"
    || (record?.type === "system" && ["bridge_status", "compact_boundary"].includes(record.subtype))
    || (record?.type === "attachment" && record.attachment?.type === "deferred_tools_delta")
    || (record?.type === "user" && structuredToolResultIds(record).length === 0);
}

/**
 * A request whose first distinct successor records newly added deferred tool definitions after a matched
 * ToolSearch call carries a load: identity -> bounded count and whether a competing transition fell in the
 * interval before the successor's first fragment. An unreadable record, or one adding names before the
 * discovery result, makes its interval ambiguous for good so a later record never yields an understated count.
 */
function reduceDeferredDefinitions(state, record) {
  if (state.inlineSidechains && record?.isSidechain === true) return;
  const identity = assistantIdentity(record);
  if (assistantRecord(record) && !identity) {
    // An assistant record with no identity could be an intervening request.
    state.pending = null;
    state.request = null;
    return;
  }
  if (identity) {
    // The preceding request answering again after the record puts the record inside it, not between.
    if (state.pending && identity === state.pending.requestId) state.pending = null;
    else if (state.pending && !state.pending.targetId) state.pending.targetId = identity;
    else if (state.pending && state.pending.targetId !== identity) state.pending = null;
    const current = state.request?.id === identity ? state.request : { id: identity, searchIds: new Set(), resolved: false, competing: false, ambiguous: false };
    state.request = current;
    for (const block of structuredContent(record)) {
      if (plainObject(block) && block.type === "tool_use" && block.name === "ToolSearch") current.searchIds.add(boundedIdentity(block.id));
    }
    if (!state.gap && state.pending?.targetId === identity && normalizedCacheMissReason(record) === "tools_changed") {
      remember(state.loads, identity, { added: Math.min(MAX_ADDED_DEFINITIONS, state.pending.added), competing: state.pending.competing });
    }
    return;
  }
  if (competingTransitionRecord(record)) {
    if (state.request) state.request.competing = true;
    // Once the successor's first fragment is seen the interval is closed; a later record is not in it.
    if (state.pending && !state.pending.targetId) state.pending.competing = true;
    return;
  }
  const names = deferredDefinitionNames(record);
  if (names) {
    const added = new Set(names.filter((name) => name && !state.known.has(name)));
    for (const name of added) {
      if (state.known.size < MAX_KNOWN_DEFINITIONS) state.known.add(name);
      else state.gap = true;
    }
    if (state.request && (names.includes(null) || (added.size > 0 && !state.request.resolved))) state.request.ambiguous = true;
    if (names.includes(null)) {
      if (!state.pending?.targetId) state.pending = null;
    } else if (added.size > 0 && state.request?.resolved && !state.request.ambiguous) {
      const open = state.pending && state.pending.requestId === state.request.id && !state.pending.targetId ? state.pending : null;
      state.pending = { requestId: state.request.id, added: (open?.added || 0) + added.size, targetId: "", competing: state.request.competing };
    }
  } else if (state.request && !state.request.resolved && structuredToolResultIds(record).some((id) => state.request.searchIds.has(id))) {
    state.request.resolved = true;
  }
}

function normalizedBridgeSession(record, expectedSessionId) {
  const sessionId = boundedIdentity(record?.sessionId);
  const bridgeSessionId = boundedIdentity(record?.bridgeSessionId);
  return record?.type === "bridge-session"
    && sessionId.length > 0
    && sessionId === expectedSessionId
    && bridgeSessionId.length > 0
    && sessionId !== bridgeSessionId
    && Number.isSafeInteger(record.lastSequenceNum)
    && record.lastSequenceNum >= 0
    ? { sessionId, bridgeSessionId, sequence: record.lastSequenceNum }
    : null;
}

function remoteControlActiveRecord(record) {
  return record?.type === "system"
    && record.subtype === "bridge_status"
    && typeof record.content === "string"
    && record.content.startsWith(REMOTE_CONTROL_ACTIVE_PREFIX);
}

function reduceRemoteControl(state, record) {
  const index = state.index;
  state.index += 1;
  const { expectedSessionId } = state;
  if (!expectedSessionId) return;
  const identity = assistantIdentity(record);
  if (identity && identity !== state.lastAssistantId) {
    state.lastAssistantId = identity;
    state.distinct = Math.min(1_000, state.distinct + 1);
    if (state.candidate?.active && identity !== state.candidate.activationRequestId) {
      if (!state.candidate.targetRequestId) state.candidate.targetRequestId = identity;
      else if (state.candidate.targetRequestId !== identity) state.candidate = null;
    }
  }

  const bridgeSession = normalizedBridgeSession(record, expectedSessionId);
  if (bridgeSession) {
    const { candidate } = state;
    if (!state.sawBridge) {
      state.sawBridge = true;
      if (state.distinct > 0) state.candidate = {
        active: false,
        activationRequestId: "",
        bridgeCount: 1,
        bridgeSessionId: bridgeSession.bridgeSessionId,
        lastBridgeSequence: bridgeSession.sequence,
        firstBridgeIndex: index,
        targetRequestId: "",
        turnBoundaryObserved: false,
      };
    } else if (candidate && candidate.bridgeSessionId === bridgeSession.bridgeSessionId) {
      if (candidate.active
        && candidate.turnBoundaryObserved
        && bridgeSession.sequence >= candidate.lastBridgeSequence) {
        candidate.bridgeCount += 1;
        candidate.lastBridgeSequence = bridgeSession.sequence;
        candidate.turnBoundaryObserved = false;
      } else if (bridgeSession.sequence < candidate.lastBridgeSequence) {
        state.candidate = null;
      }
    } else {
      state.candidate = null;
    }
    return;
  }

  if (state.candidate?.active
    && record?.type === "last-prompt"
    && boundedIdentity(record.sessionId) === expectedSessionId) {
    state.candidate.turnBoundaryObserved = true;
    return;
  }

  if (record?.type === "system" && record.subtype === "bridge_status") {
    if (remoteControlActiveRecord(record)
      && state.candidate
      && index - state.candidate.firstBridgeIndex <= MAX_BRIDGE_STATUS_DISTANCE
      && state.lastAssistantId) {
      state.candidate.active = true;
      state.candidate.activationRequestId = state.lastAssistantId;
    } else {
      state.candidate = null;
    }
    return;
  }

  if (!state.gap
    && identity
    && state.candidate?.active
    && state.candidate.bridgeCount >= 2
    && identity === state.candidate.targetRequestId
    && normalizedCacheMissReason(record) === "tools_changed") {
    remember(state.causes, identity, REMOTE_CONTROL_CONNECTED);
  }
}
