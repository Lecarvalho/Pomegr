import { WORK_KINDS } from "../../normalize/work-kind.mjs";

const REQUEST_LIMIT = 5;
const CALL_LIMIT = 50;
const PAGE_CALL_LIMIT = 200;
const MAX_CURSOR_OFFSET = 100_000;

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function positiveInteger(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function groupCursor(value) {
  if (typeof value !== "string" || value.length > 96 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return isObject(parsed) && Object.keys(parsed).length === 2 && positiveInteger(parsed.n) !== null
      && Number.isSafeInteger(parsed.o) && parsed.o >= 0 && parsed.o <= MAX_CURSOR_OFFSET ? parsed : null;
  } catch { return null; }
}
function nextCursor(number, offset) {
  return Buffer.from(JSON.stringify({ n: number, o: offset }), "utf8").toString("base64url");
}
function requestWindow(rows, query) {
  let candidates = rows;
  const from = positiveInteger(query.from);
  const to = positiveInteger(query.to);
  if (from !== null || to !== null) {
    const lower = from ?? 1;
    const upper = to ?? Number.MAX_SAFE_INTEGER;
    candidates = rows.filter((item) => item.number >= lower && item.number <= upper);
  }
  const cursor = groupCursor(query.continuation);
  const selected = positiveInteger(query.selected) ?? cursor?.n ?? null;
  const preferred = selected === null ? candidates.length - 1 : candidates.findIndex((item) => item.number === selected);
  const center = preferred < 0 ? candidates.length - 1 : preferred;
  const start = Math.max(0, Math.min(center - Math.floor(REQUEST_LIMIT / 2), Math.max(0, candidates.length - REQUEST_LIMIT)));
  return candidates.slice(start, start + REQUEST_LIMIT);
}
function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

export function scopeMatches(item, scope) {
  return scope === "all" || !scope || (scope === "primary" && item.agentId === "primary")
    || (scope === "subagents" && item.agentId && item.agentId !== "primary") || item.agentId === scope;
}

// Monitor-authored labels of rows that are not tool calls. Only rows committed before the explicit
// `call` marker existed are classified by label; new rows always carry the marker.
const LEGACY_NON_CALL_TOOLS = new Set(["User input", "Assistant replied", "Summary updated", "Shell failed"]);

/**
 * Whether a history row (or its compact index ref) records a tool call rather than user input, an
 * assistant reply, a background-task notice, or a failed-shell outcome row. A legacy ref that
 * carries neither the marker nor a label counts as a call, as it did before the marker existed.
 */
export function isToolCallRow(row) {
  if (typeof row?.call === "boolean") return row.call;
  return typeof row?.tool !== "string" || !(LEGACY_NON_CALL_TOOLS.has(row.tool) || row.tool.startsWith("Task "));
}

/**
 * A tool call with no recorded request: the `unassociated=1` activity filter and `unassociatedTotal`
 * select exactly these rows. Strict null, so a ref that lacks `requestId` is never one, and non-call
 * rows (user input, replies, notices) are excluded although their request is also null.
 */
export function isUnassociatedCall(row) {
  return isToolCallRow(row) && row.requestId === null;
}

/** The `call` marker is monitor-private; served rows keep the existing browser shape. */
export function servedActivityRow(row) {
  if (!row) return row;
  const served = { ...row };
  delete served.call;
  return served;
}

export function activityGroupPlan(requests, activity, query) {
  const scope = query.scope || "all";
  const scopedRequests = requests.filter((item) => scopeMatches(item, scope));
  const allScopedCalls = activity.filter((item) => scopeMatches(item, scope));
  const headers = requestWindow(scopedRequests, query);
  const headerIds = new Set(headers.map((item) => item.id));
  const scopedCalls = allScopedCalls.filter((item) => headerIds.has(item.requestId));
  const cursor = groupCursor(query.continuation);
  let remainingPage = PAGE_CALL_LIMIT;
  const prioritizedHeaders = cursor
    ? [...headers].sort((left, right) => Number(right.number === cursor.n) - Number(left.number === cursor.n))
    : headers;
  const plannedGroups = prioritizedHeaders.map((request) => {
    const matched = scopedCalls.filter((item) => item.requestId === request.id).sort((left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
    const offset = cursor?.n === request.number ? Math.min(cursor.o, matched.length) : 0;
    const calls = matched.slice(offset, offset + Math.min(CALL_LIMIT, remainingPage));
    remainingPage -= calls.length;
    const remaining = matched.length - offset - calls.length;
    return {
      request,
      calls,
      noMatchingCalls: matched.length === 0,
      continuation: remaining > 0 ? { cursor: nextCursor(request.number, offset + calls.length), remaining } : null,
    };
  });
  const requestGroups = headers.map((request) => plannedGroups.find((group) => group.request.id === request.id));
  // Aggregates count tool calls only, so their total matches the session Tool calls KPI. Request
  // groups still list every recorded row.
  const toolCalls = allScopedCalls.filter(isToolCallRow);
  const byKind = WORK_KINDS.map((kind) => {
    const calls = toolCalls.filter((item) => item.workKind === kind);
    return calls.length ? {
      kind,
      count: calls.length,
      medianDurationMs: median(calls.map((item) => item.durationMs).filter(Number.isSafeInteger)),
    } : null;
  }).filter(Boolean);
  return {
    requestGroups,
    range: { from: headers[0]?.number || 0, to: headers.at(-1)?.number || 0 },
    requestTotal: scopedRequests.length,
    callTotal: scopedCalls.length,
    // Scoped tool calls with no recorded request; unlike callTotal it ignores the five-request window.
    unassociatedTotal: toolCalls.filter(isUnassociatedCall).length,
    byKind,
    shellTasks: {
      total: toolCalls.filter((item) => item.workKind === "shell").length,
      failed: toolCalls.filter((item) => item.workKind === "shell" && item.status === "failed").length,
    },
  };
}

export function emptyActivityGroups() {
  return { requestGroups: [], range: { from: 0, to: 0 }, requestTotal: 0, callTotal: 0,
    unassociatedTotal: 0, byKind: [], shellTasks: { total: 0, failed: 0 } };
}

export function servedActivityGroups(plan) {
  return {
    ...plan,
    requestGroups: plan.requestGroups.map((group) => ({ ...group,
      request: structuredClone(group.request), calls: group.calls.map((call) => servedActivityRow(structuredClone(call))) })),
  };
}
