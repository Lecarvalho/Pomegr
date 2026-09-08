import { z } from "zod";

export const AGENT_QUERY_SCHEMA_VERSION = 1;
export const AGENT_QUERY_MAX_TEXT = 1200;
export const AGENT_QUERY_MAX_REPORT_LENGTH = 200_000;
export const AGENT_QUERY_INSTRUCTIONS = "Use Pomegr read tools only when their result could materially change the next decision; do not poll routinely or call every read tool at session start. Session-scoped tools default to the host-bound current session, and get_agent_context defaults to its primary agent; use list_sessions and list_session_agents only when another exact reference is needed. Use get_session_report for one bounded Markdown report of the current session's retained normalized evidence. Use get_provider_health before provider-sensitive long or parallel work, or after a relevant provider/server failure; public status does not prove impact or causation. Use get_usage_limits before expensive or lengthy work when account capacity could change scope, timing, or concurrency; limits are not per-agent consumption or billing. A configured local guard checkpoint may use its bounded same-machine/provider local concurrency observation when that changes planned concurrency; it is not a reason for repeated MCP polling. Use get_agent_context when deciding whether to continue, compact, split, or stop work for an agent; snapshots are latest observations, not cumulative usage. Use get_recent_failures while diagnosing an observed problem and correlate cautiously with provider health; coincident failures do not prove causation. Unavailable or stale observations are bounded evidence, not guarantees.";

const providerSchema = z.enum(["claude", "codex"])
  .describe("Optional provider filter. Omit it to include every supported provider.");
const sessionRefSchema = z.string().regex(/^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, "Use an exact qualified session reference returned by list_sessions.")
  .describe("Exact qualified session reference returned by list_sessions.");
const agentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u, "Use an exact normalized agent ID returned by list_session_agents.")
  .describe("Exact normalized agent ID returned by list_session_agents. Use primary for the main agent.");

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const timestampSchema = z.iso.datetime({ offset: true }).nullable();
const readinessSchema = z.enum(["loading", "ready", "unavailable"]);
const providerNameSchema = z.enum(["claude", "codex"]);
const workKindSchema = z.enum(["shell", "search", "read", "write", "test", "build", "git", "git_push", "pull_request", "process", "web", "image", "input", "transfer", "skill", "report", "agent", "integration", "wait"]);
const failureCategorySchema = z.enum(["command_not_found", "invalid_path", "network_error", "not_found", "non_zero_exit", "permission_denied", "provider_error", "syntax_error", "tests_failed", "timed_out"]).nullable();
const reportFilenameSchema = z.string().regex(/^pomegr-[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?-\d{4}-\d{2}-\d{2}\.md$/u);

const safeLocalSessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Resolve only a session identity supplied by the coding-agent host to this MCP subprocess. */
export function resolveCurrentSessionRef(environment = process.env) {
  const value = environment && typeof environment === "object" ? environment : {};
  const codexValues = [value.CODEX_THREAD_ID, value.CODEX_SESSION_ID]
    .filter((candidate) => typeof candidate === "string" && candidate.trim())
    .map((candidate) => candidate.trim());
  const claudeValues = [value.CLAUDE_CODE_SESSION_ID]
    .filter((candidate) => typeof candidate === "string" && candidate.trim())
    .map((candidate) => candidate.trim());
  if ([...codexValues, ...claudeValues].some((candidate) => !safeLocalSessionId.test(candidate))) return null;
  const codexIds = [...new Set(codexValues)];
  const claudeIds = [...new Set(claudeValues)];
  if (codexIds.length > 1 || claudeIds.length > 1 || codexIds.length + claudeIds.length !== 1) return null;
  return codexIds.length ? `codex:${codexIds[0]}` : `claude:${claudeIds[0]}`;
}

const responseSchema = z.object({
  schemaVersion: z.literal(AGENT_QUERY_SCHEMA_VERSION),
  readiness: readinessSchema,
  observedAt: timestampSchema,
  generatedAt: timestampSchema,
  revision: z.number().int().nonnegative().nullable(),
  reason: z.enum(["monitor_unavailable", "current_session_unavailable", "session_not_found", "session_unavailable", "agent_not_found", "context_unavailable", "report_unavailable"]).optional(),
  caveat: z.string().max(512).optional(),
  providers: z.array(z.union([
    z.object({
      provider: providerNameSchema,
      status: z.enum(["operational", "degraded", "outage", "maintenance", "unknown"]),
      readiness: readinessSchema,
      freshness: z.enum(["fresh", "stale", "unknown"]),
      checkedAt: timestampSchema,
      updatedAt: timestampSchema,
      statusPageUrl: z.string().max(300),
      incidents: z.array(z.object({
        id: z.string().max(64), label: z.string().max(200),
        status: z.enum(["investigating", "identified", "monitoring", "maintenance"]),
        impact: z.enum(["none", "minor", "major", "critical"]),
        updatedAt: timestampSchema, url: z.string().max(300),
      }).strict()).max(8),
    }).strict(),
    z.object({
      provider: providerNameSchema,
      readiness: readinessSchema,
      available: z.boolean(),
      origin: z.enum(["local_observation", "provider_api", "unavailable"]),
      freshness: z.enum(["fresh", "stale", "unknown"]),
      observedAt: timestampSchema,
      attemptedAt: timestampSchema,
      retryAt: timestampSchema,
      failureCategory: z.enum(["authentication_required", "rate_limited", "unavailable", "runtime_unavailable"]).nullable(),
      localActivity: z.object({
        scope: z.literal("machine_provider"),
        readiness: readinessSchema,
        observedAt: timestampSchema,
        liveSessions: z.number().int().min(0).max(10_000),
        workingSessions: z.number().int().min(0).max(10_000),
        unknownSessions: z.number().int().min(0).max(10_000),
        truncated: z.boolean(),
      }).strict().optional(),
      windows: z.array(z.object({
        id: z.string().max(80), window: z.string().max(80), usedPercent: z.number().min(0).max(100).nullable(),
        resetsAt: timestampSchema, severity: z.enum(["normal", "warning", "critical"]), active: z.boolean(),
      }).strict()).max(8),
    }).strict(),
  ])).max(2).optional(),
  sessions: z.array(z.object({
    sessionRef: sessionRefSchema, provider: providerNameSchema, title: z.string().max(256), project: z.string().max(256),
    state: z.enum(["live", "history"]), activityStatus: z.enum(["working", "needs_input", "idle", "closed", "unknown"]),
    createdAt: timestampSchema, updatedAt: timestampSchema,
  }).strict()).max(50).optional(),
  truncated: z.boolean().optional(),
  sessionRef: sessionRefSchema.optional(),
  agentId: agentIdSchema.nullable().optional(),
  agents: z.array(z.object({
    id: agentIdSchema, scope: z.enum(["main", "delegated"]), parentId: agentIdSchema.nullable(),
    label: z.string().max(256), role: z.enum(["orchestrator", "explore", "plan", "builder", "reviewer", "tester", "researcher", "general-purpose", "workflow-worker", "fork", "compaction", "unknown"]),
    status: z.enum(["active", "waiting", "needs_input", "warm", "finished", "stopped", "idle", "unknown"]),
    assignment: z.string().max(512).nullable(),
    currentActivity: z.object({ label: z.string().max(256), observedAt: timestampSchema }).strict().nullable(),
    startedAt: timestampSchema, updatedAt: timestampSchema, lastSeen: timestampSchema,
  }).strict()).max(128).optional(),
  context: z.object({
    agentId: agentIdSchema, kind: z.literal("latest_context_snapshot"), observedAt: timestampSchema,
    total: z.number().int().nonnegative(), uncachedInput: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(), output: z.number().int().nonnegative(), reasoningOutput: z.number().int().nonnegative().optional(),
    modelContextWindow: z.number().int().nonnegative().optional(), cacheLifetime: z.enum(["5m", "1h", "mixed", "30m+"]).nullable(),
  }).strict().nullable().optional(),
  withinMinutes: z.number().int().min(1).max(1440).optional(),
  failures: z.array(z.object({
    id: z.string().max(64), agentId: agentIdSchema, observedAt: timestampSchema, workKind: workKindSchema,
    toolLabel: z.string().max(64), lifecycle: z.enum(["failed", "stopped"]), failureCategory: failureCategorySchema,
  }).strict()).max(25).optional(),
  retainedCoverage: z.object({
    maximumWindowMinutes: z.literal(1440), maximumRetained: z.literal(256), oldestObservedAt: timestampSchema,
    newestObservedAt: timestampSchema, truncated: z.boolean(),
  }).strict().optional(),
  format: z.literal("markdown").optional(),
  filename: reportFilenameSchema.optional(),
  report: z.string().min(1).max(AGENT_QUERY_MAX_REPORT_LENGTH).optional(),
}).strict();

const unavailableResponse = (reason = "monitor_unavailable") => ({
  schemaVersion: AGENT_QUERY_SCHEMA_VERSION,
  readiness: "unavailable",
  observedAt: null,
  generatedAt: null,
  revision: null,
  reason,
});

function summary(toolName, data) {
  if (data.readiness === "unavailable") {
    const reason = ["monitor_unavailable", "current_session_unavailable", "session_not_found", "session_unavailable", "agent_not_found", "context_unavailable", "report_unavailable"].includes(data.reason)
      ? data.reason : "unknown reason";
    return `${toolName}: unavailable (${reason}).`;
  }
  if (toolName === "get_provider_health") return `${toolName}: provider health observation ready.`;
  if (toolName === "get_usage_limits") return `${toolName}: account usage-limit observation ready.`;
  if (toolName === "list_sessions") return `${toolName}: ${Array.isArray(data.sessions) ? data.sessions.length : 0} session(s) returned.`;
  if (toolName === "list_session_agents") return `${toolName}: ${Array.isArray(data.agents) ? data.agents.length : 0} agent(s) returned.`;
  if (toolName === "get_agent_context") return `${toolName}: latest context snapshot returned.`;
  if (toolName === "get_recent_failures") return `${toolName}: ${Array.isArray(data.failures) ? data.failures.length : 0} retained failure(s) returned.`;
  if (toolName === "get_session_report") return `${toolName}: current session report returned.`;
  return `${toolName}: observation returned.`;
}

function result(toolName, data) {
  const text = toolName === "get_session_report" && data.readiness !== "unavailable" && typeof data.report === "string"
    ? data.report
    : summary(toolName, data);
  return {
    structuredContent: data,
    content: [{ type: "text", text: toolName === "get_session_report" || text.length <= AGENT_QUERY_MAX_TEXT ? text : `${text.slice(0, AGENT_QUERY_MAX_TEXT - 1)}…` }],
  };
}

function invalidInternalResult(toolName) {
  return {
    isError: true,
    content: [{ type: "text", text: `${toolName}: Pomegr returned a malformed observation.` }],
  };
}

function responseMatchesTool(toolName, data) {
  if (data.readiness === "unavailable" && ["monitor_unavailable", "current_session_unavailable", "session_not_found", "session_unavailable", "agent_not_found", "context_unavailable", "report_unavailable"].includes(data.reason)) return true;
  if (toolName === "get_provider_health" || toolName === "get_usage_limits") return Array.isArray(data.providers);
  if (toolName === "list_sessions") return Array.isArray(data.sessions) && typeof data.truncated === "boolean";
  if (toolName === "list_session_agents") return typeof data.sessionRef === "string" && Array.isArray(data.agents);
  if (toolName === "get_agent_context") return typeof data.sessionRef === "string" && typeof data.agentId === "string" && Object.hasOwn(data, "context");
  if (toolName === "get_recent_failures") return typeof data.sessionRef === "string" && Array.isArray(data.failures) && data.retainedCoverage !== undefined;
  if (toolName === "get_session_report") return typeof data.sessionRef === "string" && data.format === "markdown" && typeof data.filename === "string" && typeof data.report === "string";
  return false;
}

async function readObservation(toolName, query, path, params) {
  try {
    const response = await query(path, params);
    const parsed = responseSchema.safeParse(response);
    if (!parsed.success || !responseMatchesTool(toolName, parsed.data)) return invalidInternalResult(toolName);
    return result(toolName, parsed.data);
  } catch {
    return result(toolName, unavailableResponse());
  }
}

const currentSession = z.object({
  session_ref: sessionRefSchema.optional().describe("Optional exact session reference. Omit it to use the current host session."),
}).strict();
const currentSessionAgent = z.object({
  session_ref: sessionRefSchema.optional().describe("Optional exact session reference. Omit it to use the current host session."),
  agent_id: agentIdSchema.optional().describe("Optional normalized agent ID. Omit it to use the current session's primary agent."),
}).strict();

export const AGENT_QUERY_TOOLS = Object.freeze({
  get_provider_health: {
    title: "Get Pomegr provider health",
    description: "Decision-triggered read of public provider health. Call before provider-sensitive long or parallel work when service condition could change the plan, or after a relevant provider/server failure. Do not poll routinely. The result includes normalized status, readiness, freshness, checked/update times, bounded active incidents, and official URLs. This reports public provider status and does not confirm impact on a specific account, model, or session; simultaneous timing is not proof of causation.",
    inputSchema: z.object({ provider: providerSchema.optional() }).strict(),
    path: "/api/agent/v1/provider-health",
    params: (input) => input.provider === undefined ? {} : { provider: input.provider },
  },
  get_usage_limits: {
    title: "Get Pomegr usage limits",
    description: "Decision-triggered read of current account-scoped usage windows. Call before expensive or lengthy work when remaining capacity could change scope, timing, or concurrency. Do not poll routinely. Usage windows expose usedPercent, reset time, and severity with bounded readiness/freshness and observation/attempt/retry times. Optional localActivity is a same-machine/provider observed lower-bound concurrency count, not matched-account attribution, other-machine activity, a burn rate, or billing. These limits are current account observations, not per-agent consumption, billing, or historical session usage.",
    inputSchema: z.object({ provider: providerSchema.optional() }).strict(),
    path: "/api/agent/v1/usage-limits",
    params: (input) => input.provider === undefined ? {} : { provider: input.provider },
  },
  list_sessions: {
    title: "List Pomegr sessions",
    description: "Decision-triggered discovery of exact qualified session references for a later session-specific query. Call only when an exact session reference is needed; do not poll routinely or infer a current session from the working directory.",
    inputSchema: z.object({
      provider: providerSchema.optional(),
      scope: z.enum(["live", "all"]).default("live").describe("Whether to list live sessions only or live and historical sessions."),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of sessions to return; capped at 50."),
    }).strict(),
    path: "/api/agent/v1/sessions",
    params: (input) => ({ provider: input.provider, scope: input.scope ?? "live", limit: input.limit ?? 20 }),
  },
  list_session_agents: {
    title: "List Pomegr session agents",
    description: "Decision-triggered listing of normalized main and delegated agents for the current host session by default, or one optional exact session reference. Use this only when agent identity can change a focused context or failure query. The main agent is always primary. Do not poll routinely; this result excludes tokens and task details.",
    inputSchema: currentSession,
    sessionScoped: true,
    path: (input) => `/api/agent/v1/sessions/${encodeURIComponent(input.session_ref)}/agents`,
    params: () => ({}),
  },
  get_agent_context: {
    title: "Get Pomegr agent context",
    description: "Decision-triggered read of the latest non-zero context snapshot for the current host session's primary agent by default. Optional exact session and agent references support focused delegated or historical inspection. Call when deciding whether to continue, compact, split, or stop work. Do not poll routinely. The snapshot is not cumulative consumption, billing, throughput, or session token spend; never add snapshots across requests.",
    inputSchema: currentSessionAgent,
    sessionScoped: true,
    path: (input) => `/api/agent/v1/sessions/${encodeURIComponent(input.session_ref)}/agents/${encodeURIComponent(input.agent_id)}/context`,
    params: () => ({}),
  },
  get_recent_failures: {
    title: "Get Pomegr recent failures",
    description: "Decision-triggered read of retained normalized failures for the current host session by default while diagnosing an observed problem. Optional exact session and agent references narrow the scope. Results contain only bounded opaque IDs, normalized agent/work labels, timestamps, lifecycle status, and failure categories, with retained coverage and truncation. Correlate cautiously with provider health; simultaneous failures and incidents do not establish causation. Do not poll routinely.",
    inputSchema: z.object({
      session_ref: sessionRefSchema.optional().describe("Optional exact session reference. Omit it to use the current host session."),
      agent_id: agentIdSchema.optional(),
      within_minutes: z.number().int().min(1).max(1440).default(15).describe("Lookback window in minutes; capped at 1,440."),
      limit: z.number().int().min(1).max(25).default(10).describe("Maximum retained failures to return; capped at 25."),
    }).strict(),
    sessionScoped: true,
    path: (input) => `/api/agent/v1/sessions/${encodeURIComponent(input.session_ref)}/failures`,
    params: (input) => ({ agent_id: input.agent_id, within_minutes: input.within_minutes ?? 15, limit: input.limit ?? 10 }),
  },
  get_session_report: {
    title: "Get Pomegr current session report",
    description: "Decision-triggered read of the same bounded Markdown observation report available from the dashboard download for the current host session. The report is generated from one committed, privacy-filtered session revision and never reads transcripts or starts hydration. Call it when the report can improve a harness decision, handoff, or diagnosis; do not poll routinely.",
    inputSchema: z.object({}).strict(),
    sessionScoped: true,
    path: (input) => `/api/agent/v1/sessions/${encodeURIComponent(input.session_ref)}/report`,
    params: () => ({}),
  },
});

export function registerAgentQueryTools(server, { query, currentSessionRef = null } = {}) {
  const read = typeof query === "function"
    ? query
    : async () => { throw new Error("Pomegr monitor query client is unavailable"); };
  const hostSessionRef = sessionRefSchema.safeParse(currentSessionRef).success ? currentSessionRef : null;

  for (const [name, definition] of Object.entries(AGENT_QUERY_TOOLS)) {
    server.registerTool(name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: responseSchema,
      annotations: readAnnotations,
    }, async (input) => {
      const resolved = definition.sessionScoped
        ? { ...input, session_ref: input.session_ref || hostSessionRef }
        : input;
      if (definition.sessionScoped && !resolved.session_ref) {
        return result(name, unavailableResponse("current_session_unavailable"));
      }
      if (name === "get_agent_context" && !resolved.agent_id) resolved.agent_id = "primary";
      return readObservation(
        name,
        read,
        typeof definition.path === "function" ? definition.path(resolved) : definition.path,
        definition.params(resolved),
      );
    });
  }
  return server;
}

export function createAgentQueryHandler(query) {
  return (name, input) => {
    const definition = AGENT_QUERY_TOOLS[name];
    if (!definition) throw new Error(`Unknown Pomegr agent query: ${name}`);
    return readObservation(
      name,
      query,
      typeof definition.path === "function" ? definition.path(input) : definition.path,
      definition.params(input),
    );
  };
}
