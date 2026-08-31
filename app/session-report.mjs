const MAX_REFILL_TRANSITIONS = 100;
const MAX_CONTEXT_BOUNDARIES = 100;
const MAX_TASK_FAILURES = 100;
const CACHE_LIFETIMES = new Set(["5m", "1h", "mixed"]);
const REFILL_REASONS = new Set(["model_changed", "system_changed", "tools_changed", "messages_changed"]);
const PROVIDER_STATUSES = new Set(["previous_cache_entry_unavailable"]);
const MESSAGE_SEQUENCES = new Set(["post_tool_task_notification_resume"]);
const ROLES = new Set(["orchestrator", "explore", "plan", "builder", "reviewer", "tester", "researcher", "general-purpose", "workflow-worker", "fork", "compaction", "unknown"]);
const WORK_KINDS = new Set(["shell", "search", "read", "write", "test", "build", "git", "git_push", "pull_request", "process", "web", "image", "input", "transfer", "skill", "report", "agent", "integration", "wait"]);
const FAILURE_CATEGORIES = new Set(["command_not_found", "invalid_path", "network_error", "not_found", "non_zero_exit", "permission_denied", "provider_error", "syntax_error", "tests_failed", "timed_out"]);

function safeString(value, max = 300) { return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null; }
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safePercent(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
function utc(value) { if (typeof value !== "string") return null; const milliseconds = Date.parse(value); return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null; }
function number(value) { return value === null || value === undefined ? "Unavailable" : new Intl.NumberFormat("en-US").format(value); }
function cell(value) { return String(value ?? "Unavailable").replace(/\r?\n/g, " ").replace(/\|/g, "\\|"); }
function localEnum(value, allowed) { return typeof value === "string" && allowed.has(value) ? value : null; }
function providerLabel(source) { return source === "Claude Code" || source === "Codex" ? source : "Unavailable"; }
function sortTimestamp(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : -Infinity; }

function duration(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return "Unavailable";
  const totalSeconds = milliseconds / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  const rendered = Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}s`;
  if (hours) return `${hours}h ${minutes}m ${rendered}`;
  if (minutes) return `${minutes}m ${rendered}`;
  return rendered;
}

function agentRecords(state) {
  const records = [];
  const seen = new Set();
  for (const agent of Array.isArray(state?.agents) ? state.agents : []) {
    const id = safeString(agent?.id, 240);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    records.push({ id, parentId: safeString(agent?.parentId, 240), role: localEnum(agent?.role, ROLES), cacheLifetime: localEnum(agent?.cacheLifetime, CACHE_LIFETIMES), tasks: Array.isArray(agent?.executionTasks) ? agent.executionTasks : null });
  }
  records.sort((left, right) => left.id === "primary" ? -1 : right.id === "primary" ? 1 : left.id.localeCompare(right.id));
  const aliases = new Map();
  let ordinal = 1;
  for (const record of records) aliases.set(record.id, record.id === "primary" ? "Primary" : `Agent ${String(ordinal++).padStart(2, "0")}`);
  return { records, aliases };
}

function requestSnapshot(value, aliases) {
  if (!value || !aliases.has(value.agentId)) return null;
  const observedAt = utc(value.observedAt);
  const parts = [value.uncachedInputTokens, value.cacheWriteTokens, value.cacheReadTokens, value.outputTokens].map(safeCount);
  if (!observedAt || parts.some((part) => part === null)) return null;
  const totalTokens = parts.reduce((sum, part) => sum + part, 0);
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return null;
  const id = safeString(value.id, 300);
  return { key: id || `${value.agentId}\u0000${observedAt}\u0000${parts.join("\u0000")}`, id, agentId: value.agentId, observedAt, uncachedInputTokens: parts[0], cacheWriteTokens: parts[1], cacheReadTokens: parts[2], outputTokens: parts[3], totalTokens };
}

function normalizeEvidence(state, aliases, cacheSupported) {
  const raw = state?.metrics?.tokens?.reportEvidence;
  const readiness = state?.readiness?.contextEvidence;
  if (raw?.version !== 1 || readiness === "loading" || readiness === "unavailable") return { available: false, cache: null, context: null, requestCount: null };
  const cacheRaw = raw.cache;
  const cacheAvailable = cacheSupported && cacheRaw?.status === "ready";
  const cache = cacheAvailable ? { status: "ready", refills: safeCount(cacheRaw.refills), reuses: safeCount(cacheRaw.reuses), possibleFullRefills: safeCount(cacheRaw.possibleFullRefills), missRefills: safeCount(cacheRaw.missRefills), transitions: [] } : { status: "unavailable", refills: null, reuses: null, possibleFullRefills: null, missRefills: null, transitions: [] };
  if (cacheAvailable && Array.isArray(cacheRaw.transitions)) {
    cache.transitions = cacheRaw.transitions.flatMap((item) => {
      if (!item || !aliases.has(item.agentId)) return [];
      const observedAt = utc(item.observedAt);
      const promptInputTokens = safeCount(item.promptInputTokens);
      const cacheWriteTokens = safeCount(item.cacheWriteTokens);
      const cacheReadPercent = safePercent(item.cacheReadPercent);
      const previousCacheReadPercent = item.previousCacheReadPercent === null ? null : safePercent(item.previousCacheReadPercent);
      const gapMs = item.gapMs === null ? null : safeCount(item.gapMs);
      if (!observedAt || promptInputTokens === null || cacheWriteTokens === null || cacheReadPercent === null || (previousCacheReadPercent === null && item.previousCacheReadPercent !== null) || (gapMs === null && item.gapMs !== null)) return [];
      return [{ sourceId: safeString(item.id, 300) || `${item.agentId}\u0000${observedAt}`, agentId: item.agentId, observedAt, promptInputTokens, cacheWriteTokens, cacheReadPercent, previousCacheReadPercent, gapMs, previousCacheLifetime: localEnum(item.previousCacheLifetime, CACHE_LIFETIMES), reason: item.reason === null ? null : localEnum(item.reason, REFILL_REASONS), providerStatus: item.providerStatus === null ? null : localEnum(item.providerStatus, PROVIDER_STATUSES), messageChangeSequence: item.messageChangeSequence === null ? null : localEnum(item.messageChangeSequence, MESSAGE_SEQUENCES), requests: { previous: requestSnapshot(item.requests?.previous, aliases), current: requestSnapshot(item.requests?.current, aliases), next: requestSnapshot(item.requests?.next, aliases) } }];
    }).sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.sourceId.localeCompare(right.sourceId)).slice(-MAX_REFILL_TRANSITIONS);
  }
  const contextRaw = raw.context;
  const contextAvailable = contextRaw?.status === "ready";
  const context = contextAvailable ? { status: "ready", automaticCompactions: safeCount(contextRaw.automaticCompactions), manualCompactions: safeCount(contextRaw.manualCompactions), snapshotDrops: safeCount(contextRaw.snapshotDrops), boundaries: [] } : { status: "unavailable", automaticCompactions: null, manualCompactions: null, snapshotDrops: null, boundaries: [] };
  if (contextAvailable && Array.isArray(contextRaw.boundaries)) {
    context.boundaries = contextRaw.boundaries.flatMap((item) => {
      if (!item || !aliases.has(item.agentId)) return [];
      const timestamp = utc(item.timestamp);
      const preTokens = item.preTokens === null ? null : safeCount(item.preTokens);
      const kind = localEnum(item.kind, new Set(["automatic_compaction", "manual_compaction", "snapshot_drop"]));
      if (!timestamp || !kind || (preTokens === null && item.preTokens !== null)) return [];
      const current = kind === "snapshot_drop" ? requestSnapshot(item.current, aliases) : null;
      const exactCurrent = current && current.agentId === item.agentId && current.observedAt === timestamp ? current : null;
      return [{ sourceId: safeString(item.id, 300) || `${item.agentId}\u0000${timestamp}\u0000${kind}`, agentId: item.agentId, timestamp, kind, preTokens, current: exactCurrent }];
    }).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.sourceId.localeCompare(right.sourceId)).slice(-MAX_CONTEXT_BOUNDARIES);
  }
  return { available: true, requestCount: safeCount(raw.requestCount), cache, context };
}

function collectTasks(state, records) {
  const byAgent = new Map();
  for (const record of records) if (record.tasks !== null) byAgent.set(record.id, record.tasks);
  const primary = records.find((record) => record.id === "primary");
  if (primary && primary.tasks === null && Array.isArray(state?.executionTasks)) byAgent.set("primary", state.executionTasks);
  const deduped = new Map();
  for (const [agentId, taskList] of byAgent) for (const task of taskList) {
    const id = safeString(task?.id, 300);
    if (!id) continue;
    const key = `${agentId}\u0000${id}`;
    if (!deduped.has(key)) deduped.set(key, { agentId, id, task });
  }
  return [...deduped.values()].map(({ agentId, id, task }) => ({ agentId, id, status: task?.status === "completed" || task?.status === "failed" ? task.status : null, startedAt: utc(task?.startedAt), finishedAt: utc(task?.finishedAt), workKind: localEnum(task?.workKind, WORK_KINDS), exitCode: Number.isSafeInteger(task?.exitCode) ? task.exitCode : null, failureCause: localEnum(task?.failureCause, FAILURE_CATEGORIES) })).filter((task) => task.status === "completed" || task.status === "failed");
}

function reportTaskRows(tasks) {
  const failures = tasks.filter((task) => task.status === "failed").sort((left, right) => sortTimestamp(right.finishedAt || right.startedAt) - sortTimestamp(left.finishedAt || left.startedAt) || left.id.localeCompare(right.id));
  const shown = failures.slice(0, MAX_TASK_FAILURES).map((task, index) => ({ ...task, alias: `T${String(index + 1).padStart(2, "0")}` }));
  return { tasks, failures, shown, omitted: Math.max(0, failures.length - shown.length), completed: tasks.filter((task) => task.status === "completed").length };
}

function requestCollection(evidence) {
  const byKey = new Map();
  for (const transition of evidence?.cache?.transitions || []) for (const snapshot of Object.values(transition.requests)) if (snapshot && !byKey.has(snapshot.key)) byKey.set(snapshot.key, snapshot);
  for (const boundary of evidence?.context?.boundaries || []) if (boundary.current && !byKey.has(boundary.current.key)) byKey.set(boundary.current.key, boundary.current);
  const snapshots = [...byKey.values()].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.key.localeCompare(right.key));
  return new Map(snapshots.map((snapshot, index) => [snapshot.key, `R${String(index + 1).padStart(3, "0")}`]));
}

export function buildSessionReport(state, generatedAt = new Date()) {
  if (!state?.session) throw new Error("A session is required to generate a report.");
  const session = state.session;
  const { records, aliases } = agentRecords(state);
  const cacheSupported = state.capabilities?.cacheWriteUsage === true && state.capabilities?.cacheUsageClassification === true;
  const evidence = normalizeEvidence(state, aliases, cacheSupported);
  const taskAvailable = !["loading", "unavailable"].includes(state.readiness?.agentEvidence)
    && !["loading", "unavailable"].includes(state.readiness?.activityEvidence)
    && records.some((record) => record.tasks !== null || (record.id === "primary" && Array.isArray(state.executionTasks)));
  const tasks = reportTaskRows(taskAvailable ? collectTasks(state, records) : []);
  const referencedIds = new Set([...(evidence.cache?.transitions || []).map((item) => item.agentId), ...(evidence.context?.boundaries || []).map((item) => item.agentId), ...tasks.failures.map((item) => item.agentId)]);
  const referenced = records.filter((record) => referencedIds.has(record.id));
  const requestAliases = requestCollection(evidence);
  const intervalStart = utc(session.startedAt);
  const intervalEnd = utc(session.updatedAt);
  const generated = generatedAt instanceof Date ? utc(generatedAt.toISOString()) : utc(generatedAt);
  const totalAgents = records.length;
  const revision = /^(?:[a-zA-Z0-9._:-]){1,128}$/.test(String(state.revision ?? "")) ? String(state.revision) : "Unavailable";
  const sessionId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,299}$/.test(session.id || "") ? session.id : "Unavailable";
  const cache = evidence.cache;
  const context = evidence.context;
  const transitionCount = cache?.transitions.length || 0;
  const boundaryCount = context?.boundaries.length || 0;
  const lines = [
    "# Pomegr Session Observation Report", "", "> Focused report of retained normalized evidence. Routine observations are summarized. No score, recommendation, or causal attribution is generated.", "", `**Session:** ${cell(sessionId)} · **Provider:** ${cell(providerLabel(state.source))} · **Agents:** ${number(totalAgents)}`, "", `**Recorded interval:** ${cell(intervalStart || "Unavailable")} → ${cell(intervalEnd || "Unavailable")} · **Wall time:** ${duration(safeCount(session.durationMs))}`, "", `**Generated:** ${cell(generated || "Unavailable")} · **Committed revision:** ${revision}. Recorded evidence extends through the interval end above; generation does not read transcripts.`, "", "All event times below are UTC. Agent, event, and request aliases are local to this report.", "", "## Coverage and counts", "", "| Observation | Count | Scope |", "| --- | --- | --- |", `| Valid request observations | ${number(evidence.available ? evidence.requestCount : null)} | retained normalized evidence |`, `| Large cache writes / tracked reuse events | ${cache?.status === "ready" ? `${number(cache.refills)} / ${number(cache.reuses)}` : "Unavailable"} | ${cache?.status === "ready" ? `${number(Math.max(0, (cache.refills ?? 0) - transitionCount))} other writes and ${number(cache.reuses)} tracked reuse events summarized` : "cache evidence unavailable"} |`, `| High-read → low-read large-write transitions | ${cache?.status === "ready" ? number(cache.possibleFullRefills) : "Unavailable"} | ${cache?.status === "ready" ? `${number(transitionCount)} retained transition rows` : "cache evidence unavailable"} |`, `| Recorded automatic / manual compactions | ${context?.status === "ready" ? `${number(context.automaticCompactions)} / ${number(context.manualCompactions)}` : "Unavailable"} | ${context?.status === "ready" ? "retained normalized evidence" : "context evidence unavailable"} |`, `| Context drops without a recorded compaction | ${context?.status === "ready" ? number(context.snapshotDrops) : "Unavailable"} | ${context?.status === "ready" ? `${number(boundaryCount)} retained boundary rows` : "context evidence unavailable"} |`, `| Retained completed / failed tasks | ${taskAvailable ? `${number(tasks.completed)} / ${number(tasks.failures.length)}` : "Unavailable"} | ${tasks.omitted ? `${number(tasks.shown.length)} newest failures shown; ${number(tasks.omitted)} retained failures omitted by the report cap` : "normalized task feeds; full-session totals unknown"} |`, "", "Routine observations and complete transcript history are omitted. No full evidence ledger was generated."];
  const omittedTransitions = cache?.possibleFullRefills === null || cache?.possibleFullRefills === undefined
    ? null : Math.max(0, cache.possibleFullRefills - transitionCount);
  const boundaryCounts = context ? [context.automaticCompactions, context.manualCompactions, context.snapshotDrops] : [];
  const boundaryTotal = boundaryCounts.length === 3 && boundaryCounts.every((count) => count !== null)
    ? boundaryCounts.reduce((sum, count) => sum + count, 0) : null;
  const supportingRequests = new Set((cache?.transitions || []).flatMap((item) => Object.values(item.requests)).filter(Boolean).map((item) => item.key)).size;
  lines.push("",
    "- Coverage is retained normalized evidence, not a complete transcript read. Earlier deleted, rotated, or unretained history is unknown.",
    "- Execution feeds retain at most 30 tasks per agent. Missing or unresolved task evidence is unavailable; the full-session failure count is unknown.",
    `- Supporting measurements: ${number(supportingRequests)} distinct requests reproduced; ${number(evidence.requestCount === null ? null : Math.max(0, evidence.requestCount - supportingRequests))} other retained requests omitted.`,
    `- Detail selection: ${number(transitionCount)} refill transitions shown, ${number(omittedTransitions)} retained transitions omitted; ${number(boundaryCount)} context boundaries shown, ${number(boundaryTotal === null ? null : Math.max(0, boundaryTotal - boundaryCount))} retained boundaries omitted.`,
  );
  if (!referenced.length) lines.push("", "## Agents referenced by the detailed events", "", "No agent-specific events were retained for the detailed sections below.");
  else {
    lines.push("", "## Agents referenced by the detailed events", "", "| Agent | Parent | Normalized role | Cache lifetime | Refill transitions | Retained failures |", "| --- | --- | --- | --- | ---: | ---: |");
    const transitionCounts = new Map(); for (const item of cache?.transitions || []) transitionCounts.set(item.agentId, (transitionCounts.get(item.agentId) || 0) + 1);
    const failureCounts = new Map(); for (const item of tasks.failures) failureCounts.set(item.agentId, (failureCounts.get(item.agentId) || 0) + 1);
    for (const agent of referenced) lines.push(`| ${cell(aliases.get(agent.id))} | ${cell(agent.parentId && aliases.has(agent.parentId) ? aliases.get(agent.parentId) : "—")} | ${cell(agent.role || "Unavailable")} | ${cache?.status === "ready" ? cell(agent.cacheLifetime || "Unavailable") : "Unavailable"} | ${cache?.status === "ready" ? number(transitionCounts.get(agent.id) || 0) : "Unavailable"} | ${taskAvailable ? number(failureCounts.get(agent.id) || 0) : "Unavailable"} |`);
    if (cache?.status === "ready") lines.push("", "Cache lifetime is the aggregate of resolved lifetimes for each referenced agent in the retained evidence.");
    lines.push("", "Per-agent counts describe the retained normalized selection and are not all-session totals.");
  }
  lines.push("", "## Cache refill transitions", "", "Cache signal definitions and evidence limits: [SIGNAL_DICTIONARY.md](https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md).", "", "Every row matches the deterministic rule: comparable requests from one agent; both prompt inputs ≥8,000; previous cache-read share ≥80%; current share ≤10%; current cache write ≥8,000. Shares are rounded for display, not classification.", "", "| Ref | Time (UTC) | Agent | Gap | Prior request lifetime | Read before → after | Cache-write tokens | Recorded diagnostic / status |", "| --- | --- | --- | --- | --- | --- | ---: | --- |");
  if (cache?.status !== "ready") lines.push("| No cache transitions available | — | — | — | — | — | — | Unavailable |");
  else if (!cache.transitions.length) lines.push("| No qualifying transitions retained | — | — | — | — | — | — | — |");
  else cache.transitions.forEach((item, index) => { const diagnostics = [item.reason, item.providerStatus].filter(Boolean).join("; ") || "Unavailable"; const before = item.previousCacheReadPercent === null ? "Unavailable" : `${item.previousCacheReadPercent.toFixed(2)}%`; lines.push(`| F${String(index + 1).padStart(2, "0")} | ${cell(item.observedAt)} | ${cell(aliases.get(item.agentId))} | ${cell(duration(item.gapMs))} | ${cell(item.previousCacheLifetime || "Unavailable")} | ${before} → ${item.cacheReadPercent.toFixed(2)}% | ${number(item.cacheWriteTokens)} | ${cell(diagnostics)} |`); });
  const sequences = (cache?.transitions || []).flatMap((item, index) => item.messageChangeSequence === "post_tool_task_notification_resume" ? [`F${String(index + 1).padStart(2, "0")}`] : []);
  if (sequences.length) lines.push("", `Structural sequence matched for ${sequences.join(", ")}: assistant tool use → matching tool result → provider-owned task notification → resumed request. This deterministic match does not establish causation.`);
  if (cache?.status === "ready" && cache.missRefills !== null) lines.push("", `Miss-refill transitions retained: ${number(cache.missRefills)}. This subset also has a gap ≥30 minutes; it is not proof of cache expiration.`);
  lines.push("", "## Compactions and context drops", "", context?.status === "ready" ? `**Automatic compactions: ${number(context.automaticCompactions)} recorded. Manual compactions: ${number(context.manualCompactions)} recorded.** Snapshot drops remain separate from compaction boundaries.` : "Context boundary evidence was unavailable when this report was generated.", "", "| Ref | Time (UTC) | Agent | Boundary | Prior context | Current context | Request |", "| --- | --- | --- | --- | ---: | ---: | --- |");
  if (context?.status !== "ready") lines.push("| No context boundaries available | — | — | — | — | — | Unavailable |");
  else if (!context.boundaries.length) lines.push("| No context boundaries retained | — | — | — | — | — | — |");
  else context.boundaries.forEach((item, index) => { const label = item.kind === "automatic_compaction" ? "Automatic compaction" : item.kind === "manual_compaction" ? "Manual compaction" : "Context drop without a recorded compaction"; const current = item.current ? number(item.current.totalTokens) : "Unavailable"; const request = item.current ? requestAliases.get(item.current.key) || "Unavailable" : "Unavailable"; lines.push(`| B${String(index + 1).padStart(2, "0")} | ${cell(item.timestamp)} | ${cell(aliases.get(item.agentId))} | ${cell(label)} | ${number(item.preTokens)} | ${current} | ${cell(request)} |`); });
  lines.push("", "Prior and current context values are independent context levels, not tokens saved.");
  lines.push("", "## Failed tasks in retained feeds", "", "Failure categories are normalized classifications. Unknown exit codes and unsupported fields remain unavailable. These failures are from retained normalized task feeds, not necessarily all failures in the session.", "", "| Task | Agent | Start (UTC) | Finish (UTC) | Work kind | Exit code | Failure category |", "| --- | --- | --- | --- | --- | ---: | --- |");
  if (!taskAvailable) lines.push("| Task evidence unavailable | — | — | — | — | — | — |");
  else if (!tasks.shown.length) lines.push("| No failed tasks retained | — | — | — | — | — | — |");
  else for (const task of tasks.shown) lines.push(`| ${task.alias} | ${cell(aliases.get(task.agentId))} | ${cell(task.startedAt || "Unavailable")} | ${cell(task.finishedAt || "Unavailable")} | ${cell(task.workKind || "Unavailable")} | ${task.exitCode === null ? "Unavailable" : number(task.exitCode)} | ${cell(task.failureCause || "Unavailable")} |`);
  if (tasks.omitted) lines.push("", `The failure feed retained ${number(tasks.failures.length)} failures; ${number(tasks.omitted)} older retained failures were omitted by the report cap of ${number(MAX_TASK_FAILURES)}.`);
  lines.push("", "## Supporting request measurements", "", "Each transition has up to three supporting request observations: preceding, affected, and next. Null observations are shown explicitly as unavailable. Request totals are recomputed per request and never summed.");
  const includeCacheWrite = cache?.status === "ready";
  const headers = includeCacheWrite ? ["Ref", "Position", "Request", "Time (UTC)", "Uncached input", "Cache read", "Cache write", "Output", "Request total"] : ["Ref", "Position", "Request", "Time (UTC)", "Uncached input", "Cache read", "Output", "Request total"];
  lines.push("", `| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`);
  if (cache?.status !== "ready" || !cache.transitions.length) lines.push(`| Unavailable | — | Unavailable | — | ${includeCacheWrite ? "Unavailable | Unavailable | Unavailable | Unavailable | Unavailable" : "Unavailable | Unavailable | Unavailable | Unavailable"} |`);
  else cache.transitions.forEach((item, index) => { for (const [key, position] of [["previous", "Preceding"], ["current", "Affected"], ["next", "Next"]]) { const snapshot = item.requests[key]; const request = snapshot ? requestAliases.get(snapshot.key) : "Unavailable"; const values = snapshot ? [request, snapshot.observedAt, number(snapshot.uncachedInputTokens), number(snapshot.cacheReadTokens), ...(includeCacheWrite ? [number(snapshot.cacheWriteTokens)] : []), number(snapshot.outputTokens), number(snapshot.totalTokens)] : ["Unavailable", "Unavailable", "Unavailable", "Unavailable", ...(includeCacheWrite ? ["Unavailable"] : []), "Unavailable", "Unavailable"]; lines.push(`| F${String(index + 1).padStart(2, "0")} | ${position} | ${values.join(" | ")} |`); } });
  lines.push("", "## Definitions and limits", "", "- Prompt input = uncached input + cache read + cache write where cache-write evidence is supported. Cache-read share = cache read ÷ prompt input.", "- Request total adds output to that request's prompt input. Request observations are independent and are never summed into throughput, spend, or savings.", "- A large write is ≥8,000 cache-write tokens and can include initial creation. Tracked reuse is the first comparable request following a refill with prompt input ≥8,000 and read share ≥80%; it does not count every cache-reading request.", "- Comparability is provider-normalized within an agent, without an intervening recognized compaction. Missing or unsupported cache classification is unavailable, not zero.", "- Recorded diagnostic categories do not identify exact changed content. A gap exceeding a recorded lifetime, or previous_cache_entry_unavailable, does not establish expiration. Causal inferences are omitted.", "- Context boundaries are fixed automatic-compaction, manual-compaction, or snapshot-drop records. Snapshot drops are not labeled compactions.", `- Backend retention limits: at most ${number(MAX_REFILL_TRANSITIONS)} refill transitions and ${number(MAX_CONTEXT_BOUNDARIES)} context boundaries; failures shown here are capped at ${number(MAX_TASK_FAILURES)} newest retained failures.`, "- Prompts, responses, reasoning, commands, output text, credentials, provider-native IDs, transcript paths, model identifiers, and agent-reported free text are excluded.", "- No full evidence ledger was generated; routine observations omitted from this focused report are not declared issue-free.", "");
  return lines.join("\n");
}

export function sessionReportFilename(state, generatedAt = new Date()) {
  const title = state?.session?.title || state?.session?.project || "session";
  const slug = String(title).normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80).replace(/-$/, "") || "session";
  const date = generatedAt instanceof Date ? generatedAt.toISOString().slice(0, 10) : new Date(generatedAt).toISOString().slice(0, 10);
  return `pomegr-${slug}-${date}.md`;
}
