import { z } from "zod";
/** @typedef {import("../../shared/monitor-contract").ProviderId} ProviderId */
/** @typedef {import("../../shared/monitor-contract").ProviderSource} ProviderSource */
/** @typedef {import("../../shared/monitor-contract").ProviderCapabilities} ProviderCapabilities */
/** @typedef {{status: "supported"} | {status: "unsupported", limitation: {code: string, documentation: string}}} ProviderCapabilityManifestEntry */
/** @typedef {Record<string, ProviderCapabilityManifestEntry>} ProviderCapabilityManifest */
/** @typedef {{status: "ready"} | {status: "unavailable", reason: string} | {status: "not_applicable"}} ProviderReadinessEntry */
/** @typedef {Record<string, ProviderReadinessEntry>} ProviderRuntimeReadiness */
/** @typedef {{requestModelObservations: boolean, modelSelection: boolean, usageLimitActivity: object}} ProviderHomePolicy */
/** @typedef {{publishCatalog: (providerId: ProviderId, entries: z.infer<typeof providerSessionReferenceSchema>[], readiness?: "ready" | "unavailable") => void, publishSession: (providerId: ProviderId, localSessionId: string, evidence: ProviderSessionEvidence) => void, invalidateSession: (providerId: ProviderId, localSessionId: string, reason: string) => void, checkpointFor?: (providerId: ProviderId, localSessionId: string) => {fingerprint: string, completeOffset: number} | null}} NormalizedObservationPublisher */
/** @typedef {{publishCatalog: (entries: unknown[]) => void, publishSession: (localSessionId: string, evidence: unknown) => void, invalidateSession: (localSessionId: string, reason: string) => void, checkpointFor?: (localSessionId: string) => {fingerprint: string, completeOffset: number} | null}} ScopedNormalizedObservationPublisher */
/** @typedef {{start: (publisher: ScopedNormalizedObservationPublisher, signal: AbortSignal) => Promise<void> | void, hydrate: (localSessionId: string) => Promise<boolean> | boolean, listSessions: () => Promise<unknown[]> | unknown[], stop?: () => Promise<void> | void}} ProviderObserver */

export const PROVIDER_IDS = Object.freeze(["claude", "codex"]);

export const PROVIDER_SOURCES = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
});

/**
 * Single catalog for every harness. The catalog is monitor-private metadata
 * that drives conformance and generated documentation; browser clients receive
 * only the derived boolean capabilities.
 */
export const PROVIDER_CAPABILITY_CATALOG = Object.freeze([
  { key: "approvalMode", label: "Approval mode", evidencePath: "session.approvalMode", requiredOperation: "readSession" },
  { key: "automaticCompactions", label: "Automatic compactions", evidencePath: "compactions", requiredOperation: "readSession" },
  { key: "contextMachinery", label: "Context machinery", evidencePath: "session.contextMachinery", requiredOperation: "readSession" },
  { key: "estimatedCost", label: "Estimated cost", evidencePath: "session.cost", requiredOperation: "readSession" },
  { key: "liveSessions", label: "Live sessions", evidencePath: "catalog.isLive", requiredOperation: "listSessions" },
  { key: "needsInput", label: "Needs-input state", evidencePath: "catalog.needsInput", requiredOperation: "listSessions" },
  { key: "planTasks", label: "Plan tasks", evidencePath: "planTasks", requiredOperation: "readSession" },
  { key: "cacheWriteUsage", label: "Cache-write usage", evidencePath: "usageSnapshots.cacheWrite", requiredOperation: "readSession" },
  { key: "cacheUsageClassification", label: "Cache usage classification", evidencePath: "usageSnapshots.cacheComparable", requiredOperation: "readSession" },
  { key: "sessionSummary", label: "Session summary", evidencePath: "session.summary", requiredOperation: "readSession" },
  { key: "signals", label: "Agent-reported signals", evidencePath: "session.signal", requiredOperation: "readSession" },
  { key: "usageLimits", label: "Usage limits", evidencePath: "usageLimits", requiredOperation: "readUsageLimits" },
  { key: "workflows", label: "Workflows", evidencePath: "workflows", requiredOperation: "readSession" },
]);

export const PROVIDER_CAPABILITY_KEYS = Object.freeze(PROVIDER_CAPABILITY_CATALOG.map(({ key }) => key));

/** Bounded reasons an adapter intentionally cannot implement a capability. */
export const PROVIDER_LIMITATION_CODES = Object.freeze([
  "provider_does_not_expose",
  "monitor_not_implemented",
  "privacy_boundary",
  "unsupported_transcript_format",
  "unsupported_runtime_api",
]);

export const PROVIDER_OBSERVATION_API_KEYS = Object.freeze([
  "id",
  "source",
  "capabilityManifest",
  "readinessCapabilities",
  "homePolicy",
  "capabilities",
  "resolveReadiness",
  "listSessions",
  "readSession",
  "readTranscriptPath",
  "readUsageLimits",
  "unavailableMessage",
  "qaStats",
  "watchTargets",
  "createObserver",
]);

/**
 * Reasons are intentionally provider-neutral.  Native filesystem, event, or
 * API failure details stay inside the adapter and must never cross into a
 * committed observation or browser response.
 */
export const PROVIDER_OBSERVATION_INVALIDATION_REASONS = Object.freeze([
  "source_replaced",
  "source_unavailable",
  "source_invalid",
  "provider_unavailable",
]);

const providerIdSet = new Set(PROVIDER_IDS);
const capabilityKeySet = new Set(PROVIDER_CAPABILITY_KEYS);
const limitationCodeSet = new Set(PROVIDER_LIMITATION_CODES);
const providerObservationApiKeySet = new Set(PROVIDER_OBSERVATION_API_KEYS);
const providerObservationInvalidationReasonSet = new Set(PROVIDER_OBSERVATION_INVALIDATION_REASONS);
const SAFE_LOCAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @param {unknown} value @returns {value is ProviderId} */
export function isProviderId(value) {
  return typeof value === "string" && providerIdSet.has(value);
}

/** @param {ProviderId} providerId @returns {ProviderSource} */
export function providerSource(providerId) {
  if (!isProviderId(providerId)) throw new TypeError(`Unknown provider: ${String(providerId)}`);
  return PROVIDER_SOURCES[providerId];
}

/**
 * Optional capabilities are deny-by-default so adding a provider never causes
 * the UI to imply support for metadata the adapter did not explicitly supply.
 *
 * @param {Partial<ProviderCapabilities>} [overrides]
 * @returns {Readonly<ProviderCapabilities>}
 */
export function createProviderCapabilities(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Provider capabilities must be an object");
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!capabilityKeySet.has(key)) throw new TypeError(`Unknown provider capability: ${key}`);
    if (typeof value !== "boolean") throw new TypeError(`Provider capability ${key} must be boolean`);
  }
  const values = /** @type {Record<string, boolean | undefined>} */ (overrides);
  const capabilities = /** @type {ProviderCapabilities} */ (Object.fromEntries(
    PROVIDER_CAPABILITY_KEYS.map((key) => [key, values[key] ?? false]),
  ));
  return Object.freeze(capabilities);
}

/**
 * A capability declaration is intentionally more precise than the browser
 * boolean: static harness support is either explicit support or an explicit,
 * documented limitation. Omission is never a limitation.
 *
 * @param {ProviderCapabilityManifest} manifest
 */
export function createProviderCapabilityManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Provider capability manifest must be an object");
  }
  const keys = Object.keys(manifest);
  if (keys.length !== PROVIDER_CAPABILITY_KEYS.length
    || PROVIDER_CAPABILITY_KEYS.some((key) => !Object.hasOwn(manifest, key))) {
    throw new TypeError("Provider capability manifest must explicitly classify every capability");
  }
  for (const key of keys) {
    if (!capabilityKeySet.has(key)) throw new TypeError(`Unknown provider capability: ${key}`);
    const entry = manifest[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`Provider capability ${key} must be a manifest entry`);
    }
    const entryKeys = Object.keys(entry);
    if (entry.status === "supported") {
      if (entryKeys.length !== 1) throw new TypeError(`Supported provider capability ${key} must not declare a limitation`);
      continue;
    }
    const limitation = entry.limitation;
    if (entry.status !== "unsupported" || entryKeys.length !== 2
      || !limitation || typeof limitation !== "object" || Array.isArray(limitation)
      || Object.keys(limitation).length !== 2 || !limitationCodeSet.has(limitation.code)
      || typeof limitation.documentation !== "string" || !limitation.documentation.trim()
      || limitation.documentation.length > 512) {
      throw new TypeError(`Unsupported provider capability ${key} requires a bounded limitation code and documentation`);
    }
  }
  return Object.freeze(Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => {
    const entry = manifest[key];
    return [key, Object.freeze(entry.status === "supported"
      ? { status: "supported" }
      : { status: "unsupported", limitation: Object.freeze({
        code: entry.limitation.code,
        documentation: entry.limitation.documentation,
      }) })];
  })));
}

export const PROVIDER_READINESS_REASONS = Object.freeze([
  "runtime_unavailable",
  "provider_api_unavailable",
  "probe_failed",
]);
const readinessReasonSet = new Set(PROVIDER_READINESS_REASONS);

/** @param {ReturnType<typeof createProviderCapabilityManifest>} manifest @param {ProviderRuntimeReadiness} [overrides] */
export function createProviderRuntimeReadiness(manifest, overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Provider runtime readiness must be an object");
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!capabilityKeySet.has(key)) throw new TypeError(`Unknown provider capability readiness: ${key}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Provider readiness ${key} must be a structured entry`);
    }
    if (manifest[key].status !== "supported") {
      if (value.status === "not_applicable" && Object.keys(value).length === 1) continue;
      throw new TypeError(`Unsupported provider capability ${key} cannot declare runtime readiness`);
    }
    if (value.status === "ready" && Object.keys(value).length === 1) continue;
    if (value.status === "unavailable" && Object.keys(value).length === 2 && readinessReasonSet.has(value.reason)) continue;
    throw new TypeError(`Provider readiness ${key} must be ready or unavailable with a bounded reason`);
  }
  return Object.freeze(Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => [
    key,
    Object.freeze(manifest[key].status === "supported"
      ? overrides[key] ?? { status: "ready" }
      : { status: "not_applicable" }),
  ])));
}

/** @param {ReturnType<typeof createProviderCapabilityManifest>} manifest @param {ProviderRuntimeReadiness} [readiness] */
export function capabilitiesFromManifest(manifest, readiness = {}) {
  const resolved = createProviderRuntimeReadiness(manifest, readiness);
  return createProviderCapabilities(Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => [
    key,
    manifest[key].status === "supported" && resolved[key].status === "ready",
  ])));
}

/** @param {ReturnType<typeof createProviderCapabilityManifest>} manifest @param {string[]} [capabilities] */
export function createProviderReadinessCapabilities(manifest, capabilities = []) {
  if (!Array.isArray(capabilities) || capabilities.length > PROVIDER_CAPABILITY_KEYS.length) {
    throw new TypeError("Provider readiness capabilities must be a bounded array");
  }
  const unique = new Set();
  for (const capability of capabilities) {
    if (!capabilityKeySet.has(capability) || manifest[capability]?.status !== "supported") {
      throw new TypeError(`Provider readiness capability ${String(capability)} must be statically supported`);
    }
    if (unique.has(capability)) throw new TypeError(`Duplicate provider readiness capability: ${capability}`);
    unique.add(capability);
  }
  return Object.freeze([...unique]);
}

const policyIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);
const policySegment = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);
const providerUsageLimitActivityPolicySchema = z.object({
  enabled: z.boolean(),
  weeklyLimitIds: z.array(policyIdentifier).min(1).max(16).nullable(),
  trackedLimitIds: z.array(policyIdentifier).min(1).max(16).nullable(),
  modelScopes: z.array(z.object({
    limitId: policyIdentifier,
    modelSegments: z.array(policySegment).min(1).max(8),
  }).strict()).max(16),
  selection: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }).strict(),
    z.object({
      mode: z.literal("dominant_model_window"),
      defaultWindow: z.enum(["5h", "7d"]),
      defaultExcludedLimitSegments: z.array(policySegment).max(8),
      overrides: z.array(z.object({
        models: z.array(policySegment).min(1).max(8),
        window: z.enum(["5h", "7d"]),
        preferredLimitSegments: z.array(policySegment).max(8),
      }).strict()).max(8),
    }).strict(),
  ]),
}).strict();

/**
 * Home-level policy is adapter-owned, bounded, and has no provider IDs. It
 * prevents generic monitor code from growing Claude/Codex conditionals.
 * @param {ProviderHomePolicy} policy
 */
export function createProviderHomePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).length !== 3) {
    throw new TypeError("Provider home policy must be complete");
  }
  const { requestModelObservations, modelSelection, usageLimitActivity } = policy;
  if (typeof requestModelObservations !== "boolean" || typeof modelSelection !== "boolean") {
    throw new TypeError("Invalid provider home policy");
  }
  const parsedActivity = providerUsageLimitActivityPolicySchema.parse(usageLimitActivity);
  if (!parsedActivity.enabled && (parsedActivity.weeklyLimitIds !== null || parsedActivity.trackedLimitIds !== null
    || parsedActivity.modelScopes.length > 0 || parsedActivity.selection.mode !== "all")) {
    throw new TypeError("Disabled usage-limit activity must not declare selection policy");
  }
  return Object.freeze({
    requestModelObservations,
    modelSelection,
    usageLimitActivity: Object.freeze(parsedActivity),
  });
}

/**
 * Create the opaque browser/API identifier for a provider-local session.
 * Local IDs are data identifiers only; path separators, traversal, and extra
 * namespace delimiters are rejected.
 *
 * @param {ProviderId} providerId
 * @param {string} localSessionId
 */
export function qualifyProviderSessionId(providerId, localSessionId) {
  if (!isProviderId(providerId)) throw new TypeError(`Unknown provider: ${String(providerId)}`);
  if (typeof localSessionId !== "string" || !SAFE_LOCAL_SESSION_ID.test(localSessionId)) {
    throw new TypeError("Unsafe provider-local session ID");
  }
  return `${providerId}:${localSessionId}`;
}

/**
 * Parse an opaque browser/API identifier without resolving or accepting paths.
 *
 * @param {unknown} value
 * @returns {{ providerId: ProviderId, localSessionId: string } | null}
 */
export function parseProviderSessionId(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return null;
  const providerId = value.slice(0, separator);
  const localSessionId = value.slice(separator + 1);
  return isProviderId(providerId) && SAFE_LOCAL_SESSION_ID.test(localSessionId)
    ? { providerId, localSessionId }
    : null;
}

const evidenceText = (maximum = 4_096) => z.string().max(maximum);
const evidenceOneLine = (maximum = 512) => evidenceText(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f\r\n]/.test(value), "Expected bounded one-line text");
const evidenceTimestamp = evidenceText(64).refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const evidenceNullableTimestamp = evidenceTimestamp.nullable();
const evidenceCount = z.number().int().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/, "Unsafe identifier");
const evidenceNullableId = evidenceId.nullable();
const evidenceSignal = z.object({
  label: evidenceOneLine(256),
  tone: z.enum(["neutral", "info", "positive", "warning", "negative"]),
  reportedAt: evidenceNullableTimestamp,
  description: evidenceOneLine(512).optional(),
}).strict();
const evidenceWorkKind = z.enum(["shell", "search", "read", "write", "test", "build", "git", "git_push", "pull_request", "process", "web", "image", "input", "transfer", "skill", "report", "agent", "integration", "wait"]);
const evidenceTask = z.object({
  id: evidenceId, label: evidenceOneLine(512), kind: z.literal("shell"),
  workKind: evidenceWorkKind.optional(),
  status: z.enum(["running", "completed", "failed", "stopped"]), background: z.boolean(), backgroundId: evidenceNullableId,
  startedAt: evidenceTimestamp, finishedAt: evidenceNullableTimestamp, exitCode: z.number().int().finite().nullable(),
  failureCause: z.enum(["command_not_found", "invalid_path", "network_error", "not_found", "non_zero_exit", "permission_denied", "provider_error", "syntax_error", "tests_failed", "timed_out"]).nullable(),
  signal: evidenceSignal.nullable(),
}).strict();
const evidenceReviewDecisions = z.object({
  total: evidenceCount,
  allowed: evidenceCount,
  denied: evidenceCount,
  items: z.array(z.object({
    action: z.enum(["build_or_test", "browser_interaction", "dependency_change", "file_change", "filesystem_action", "local_process", "network_access", "version_control", "shell_command", "privileged_action"]),
    outcome: z.enum(["allowed", "denied"]),
    risk: z.enum(["low", "medium", "high", "unknown"]),
    durationMs: evidenceCount.nullable(),
    reviewedAt: evidenceTimestamp,
  }).strict()).max(100),
  truncated: z.boolean(),
}).strict();
const evidenceAgent = z.object({
  id: evidenceId, parentId: evidenceNullableId, transcriptAvailable: z.boolean().optional(), workflowId: evidenceNullableId,
  workflowPhaseId: evidenceNullableId, workflowOrder: evidenceCount.nullable(), workflowState: z.enum(["running", "done", "error", "unknown"]).nullable(),
  assignment: evidenceOneLine(512).nullable().optional(), label: evidenceOneLine(512), kind: evidenceOneLine(128), model: evidenceOneLine(256), effort: evidenceOneLine(128),
  status: z.enum(["active", "waiting", "needs_input", "warm", "finished", "stopped", "idle", "unknown"]),
  liveness: z.object({
    source: z.enum(["owning_app_server", "lifecycle_bridge", "rollout_activity_heuristic", "structured_lifecycle"]),
    observedAt: evidenceTimestamp,
    evidence: z.enum(["observed", "inferred", "unavailable"]).optional(),
    freshness: z.enum(["current", "stale"]).optional(),
    reason: z.enum(["source_not_integrated", "source_unavailable", "source_unsupported", "observation_gap", "ambiguous_event", "legacy_snapshot"]).optional(),
  }).strict().nullable().optional(),
  signal: evidenceSignal.nullable(), currentActivity: z.object({ label: evidenceOneLine(256), observedAt: evidenceTimestamp }).strict().nullable().optional(),
  toolCalls: evidenceCount, skills: z.array(z.object({ name: evidenceOneLine(128), calls: evidenceCount, lastUsed: evidenceNullableTimestamp }).strict()).max(256),
  executionTasks: z.array(evidenceTask).max(256), reviewDecisions: evidenceReviewDecisions.optional(),
  lastSeen: evidenceTimestamp, startedAt: evidenceTimestamp, updatedAt: evidenceTimestamp, durationMs: evidenceCount,
}).strict();
const evidenceUsageSnapshot = z.object({
  dedupeId: evidenceId, actorId: evidenceId, timestamp: evidenceTimestamp, input: evidenceCount, output: evidenceCount, cacheWrite: evidenceCount, cacheRead: evidenceCount,
  reasoningOutput: evidenceCount.optional(), totalTokens: evidenceCount.optional(), modelContextWindow: evidenceCount.nullable().optional(), model: evidenceText(256).optional(),
  comparisonGroup: evidenceCount.optional(), cacheComparable: z.boolean().optional(), cacheLifetime: z.enum(["5m", "1h", "mixed", "30m+"]).nullable().optional(),
  cacheMissReason: z.enum(["model_changed", "system_changed", "tools_changed", "messages_changed"]).nullable().optional(),
  cacheMissDiagnosticState: z.enum(["absent", "recognized_reason", "previous_cache_entry_unavailable", "inconclusive"]).optional(),
  cacheMissProviderStatus: z.literal("previous_cache_entry_unavailable").nullable().optional(), cacheToolChangeCause: z.literal("remote_control_connected").nullable().optional(),
  cacheMessageChangeSequence: z.literal("post_tool_task_notification_resume").nullable().optional(),
}).strict();
const evidenceToolCall = z.object({
  id: evidenceId, timestamp: evidenceTimestamp, actor: z.object({ id: evidenceId, label: evidenceOneLine(512) }).strict(), tool: evidenceOneLine(128), detail: evidenceOneLine(1_024),
  workKind: evidenceWorkKind.optional(),
  status: z.enum(["running", "completed", "failed"]).nullable(), repetitionSignature: evidenceOneLine(512),
  mutation: z.object({ display: evidenceOneLine(512), scopes: z.array(evidenceOneLine(256)).max(64) }).strict().nullable(),
}).strict();
const evidenceActivity = z.object({ id: evidenceId, timestamp: evidenceTimestamp, actor: evidenceOneLine(512), tool: evidenceOneLine(128), workKind: evidenceWorkKind.optional(), detail: evidenceOneLine(1_024), status: z.literal("failed").nullable() }).strict();
const evidencePlanTask = z.object({ id: evidenceId, subject: evidenceOneLine(512), status: z.enum(["pending", "in_progress", "completed"]), blocks: z.array(evidenceId).max(128), blockedBy: z.array(evidenceId).max(128) }).strict();
const evidenceWorkflow = z.object({
  id: evidenceId, name: evidenceText(256), summary: evidenceText(1_024).nullable(), status: z.enum(["running", "completed", "unknown"]), metadataStatus: z.enum(["pending", "ready", "unavailable"]),
  startedAt: evidenceNullableTimestamp, updatedAt: evidenceNullableTimestamp, durationMs: evidenceCount, agentIds: z.array(evidenceId).max(128),
  phases: z.array(z.object({ id: evidenceId, label: evidenceText(256), agentIds: z.array(evidenceId).max(128) }).strict()).max(64),
}).strict();
const evidenceCompaction = z.object({ actorId: evidenceId, timestamp: evidenceTimestamp, trigger: z.enum(["auto", "manual", "unknown"]), preTokens: evidenceCount.nullable(), inferred: z.literal(true).optional() }).strict();

/**
 * The single runtime authority for normalized adapter output. It is strict at
 * every object boundary: raw provider records cannot be smuggled through an
 * otherwise valid normalized field.
 */
export const providerSessionEvidenceSchema = z.object({
  localId: z.string().regex(SAFE_LOCAL_SESSION_ID, "Unsafe provider-local session ID"),
  historical: z.boolean(),
  observationSource: z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    completeOffset: evidenceCount,
  }).strict().optional(),
  session: z.object({
    title: evidenceText(512), project: evidenceText(512), cwd: evidenceText(2_048), startedAt: evidenceNullableTimestamp, updatedAt: evidenceNullableTimestamp,
    recordedGitBranch: evidenceText(512),
    cost: z.object({ amount: z.number().finite().min(0), currency: z.literal("USD"), type: z.literal("estimated"), observedAt: evidenceTimestamp }).strict().nullable(),
    approvalMode: z.object({ id: evidenceText(64), label: evidenceText(128), observedAt: evidenceNullableTimestamp, source: z.literal("provider") }).strict().nullable(),
    contextMachinery: z.object({ observedAt: evidenceNullableTimestamp, model: evidenceText(256), machineryTokens: evidenceCount, total: z.object({ used: evidenceText(64), limit: evidenceText(64), percentage: z.number().finite().min(0).max(100) }).strict().nullable(), categories: z.array(z.object({ name: evidenceText(128), tokens: evidenceText(64), percentage: z.number().finite().min(0).max(100) }).strict()).max(128), groups: z.array(z.object({ id: evidenceId, label: evidenceText(128), items: z.array(z.object({ name: evidenceText(128), detail: evidenceText(512), tokens: evidenceText(64) }).strict()).max(256) }).strict()).max(128) }).strict().nullable(),
    summary: z.object({ text: evidenceText(262_144), observedAt: evidenceNullableTimestamp, source: z.literal("provider") }).strict().nullable(),
    signal: evidenceSignal.nullable(),
    progress: z.object({ phase: z.enum(["planning", "implementing", "verifying", "blocked", "complete"]), percent: z.number().finite().min(0).max(100), remainingMinutesMin: evidenceCount.optional(), remainingMinutesMax: evidenceCount.optional(), confidence: z.enum(["low", "medium", "high"]), reportedAt: evidenceTimestamp }).strict().nullable(),
    pomegrPlugin: z.object({ status: z.literal("active"), version: evidenceText(64).nullable(), policyStatus: z.enum(["valid", "invalid", "missing"]), policyVersion: evidenceCount.nullable(), observedAt: evidenceNullableTimestamp }).strict().nullable(),
  }).strict(),
  agents: z.array(evidenceAgent).max(128), workflows: z.array(evidenceWorkflow).max(64), usageSnapshots: z.array(evidenceUsageSnapshot).max(4_096), toolCalls: z.array(evidenceToolCall).max(4_096),
  activity: z.array(evidenceActivity).max(4_096), planTasks: z.array(evidencePlanTask).max(256), compactions: z.array(evidenceCompaction).max(1_024),
  efficiencyRuleEvidence: z.object({ repetition: z.boolean(), concurrentMutation: z.boolean(), unsharedContext: z.boolean(), healthyFallback: z.boolean(), cacheUsageClassification: z.boolean() }).strict(),
  pullRequestCreations: z.array(z.object({ id: evidenceId, actorId: evidenceId, timestamp: evidenceNullableTimestamp, url: z.string().url().max(2_048) }).strict()).max(256),
  usageLimitRejections: z.array(z.object({ observedAt: evidenceTimestamp, resetsAt: evidenceTimestamp }).strict()).max(64).optional(),
}).strict();

export const providerSessionReferenceSchema = z.object({
  localId: z.string().regex(SAFE_LOCAL_SESSION_ID, "Unsafe provider-local session ID"),
  title: evidenceOneLine(512),
  project: evidenceOneLine(512),
  createdAt: evidenceTimestamp.optional(),
  updatedAt: evidenceTimestamp,
  isLive: z.boolean(),
  needsInput: z.boolean(),
  activityStatus: z.enum(["working", "needs_input", "idle", "open", "stopped", "unknown"]),
  resourceOwner: z.object({
    pid: z.number().int().positive(),
    processStartIdentity: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:+-]{0,79}$/),
  }).strict().nullable().optional(),
}).strict();

const providerUsageLimitSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/),
  label: evidenceOneLine(128),
  window: evidenceOneLine(64),
  percent: z.number().finite().min(0).max(100),
  resetsAt: evidenceNullableTimestamp,
  severity: z.enum(["normal", "warning", "critical"]),
  active: z.boolean(),
}).strict();

export const providerUsageLimitsSchema = z.object({
  available: z.boolean(),
  fetchedAt: evidenceNullableTimestamp,
  attemptedAt: evidenceNullableTimestamp,
  origin: z.enum(["local_observation", "provider_api"]).optional(),
  freshness: z.enum(["fresh", "stale"]).optional(),
  failureKind: z.enum(["authentication_required", "rate_limited", "unavailable", "runtime_unavailable"]).nullable().optional(),
  retryAt: evidenceNullableTimestamp.optional(),
  error: evidenceOneLine(512).optional(),
  limits: z.array(providerUsageLimitSchema).max(16),
  retainedLimits: z.object({
    fetchedAt: evidenceTimestamp,
    limits: z.array(providerUsageLimitSchema).min(1).max(16),
  }).strict().optional(),
}).strict();

/** @typedef {z.infer<typeof providerSessionEvidenceSchema>} ProviderSessionEvidence */

/** @param {unknown} value @param {string | undefined} [expectedLocalId] */
export function parseProviderSessionEvidence(value, expectedLocalId) {
  const evidence = providerSessionEvidenceSchema.parse(value);
  if (expectedLocalId !== undefined && evidence.localId !== expectedLocalId) {
    throw new TypeError("Provider evidence did not match the requested local session ID");
  }
  return evidence;
}

/**
 * Validate the monitor-owned publication boundary.  Provider adapters receive
 * a scoped publisher from the registry, but the monitor/store-facing shape
 * always retains the provider ID so no adapter can publish into another
 * provider's namespace.
 *
 * @param {unknown} publisher
 * @returns {NormalizedObservationPublisher}
 */
export function assertNormalizedObservationPublisher(publisher) {
  if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) {
    throw new TypeError("Normalized observation publisher must be an object");
  }
  const value = /** @type {Record<string, unknown>} */ (publisher);
  for (const key of ["publishCatalog", "publishSession", "invalidateSession"]) {
    if (typeof value[key] !== "function") {
      throw new TypeError(`Normalized observation publisher must implement ${key}`);
    }
  }
  return /** @type {NormalizedObservationPublisher} */ (value);
}

/**
 * Scope a monitor-owned publisher to a single adapter.  The wrapper validates
 * catalog references and evidence before the provider-neutral store ever sees
 * them.  It intentionally contains no native source data or paths.
 *
 * @param {ProviderId} providerId
 * @param {unknown} publisher
 * @returns {ScopedNormalizedObservationPublisher}
 */
export function createScopedNormalizedObservationPublisher(providerId, publisher) {
  if (!isProviderId(providerId)) throw new TypeError(`Unknown provider: ${String(providerId)}`);
  const target = assertNormalizedObservationPublisher(publisher);
  return Object.freeze({
    /** @param {unknown[]} entries */
    publishCatalog(entries) {
      if (!Array.isArray(entries)) throw new TypeError("Provider observer catalog must be an array");
      const normalized = entries.map((entry) => parseProviderSessionReference(entry));
      target.publishCatalog(providerId, normalized);
    },
    /** @param {string} localSessionId @param {unknown} candidate */
    publishSession(localSessionId, candidate) {
      qualifyProviderSessionId(providerId, localSessionId);
      target.publishSession(providerId, localSessionId, parseProviderSessionEvidence(candidate, localSessionId));
    },
    /** @param {string} localSessionId @param {string} reason */
    invalidateSession(localSessionId, reason) {
      qualifyProviderSessionId(providerId, localSessionId);
      if (!providerObservationInvalidationReasonSet.has(reason)) {
        throw new TypeError("Unknown provider observation invalidation reason");
      }
      target.invalidateSession(providerId, localSessionId, reason);
    },
    checkpointFor(localSessionId) {
      qualifyProviderSessionId(providerId, localSessionId);
      return typeof target.checkpointFor === "function" ? target.checkpointFor(providerId, localSessionId) : null;
    },
  });
}

/**
 * Provider observers are long-lived acquisition/normalization workers.  The
 * contract stays deliberately small: adapters own source schemas and cursors;
 * the shared layer sees only validated normalized candidates.
 *
 * @param {unknown} observer
 * @returns {ProviderObserver}
 */
export function assertProviderObserver(observer) {
  if (!observer || typeof observer !== "object" || Array.isArray(observer)) {
    throw new TypeError("Provider observer must be an object");
  }
  const value = /** @type {Record<string, unknown>} */ (observer);
  if (typeof value.start !== "function" || typeof value.hydrate !== "function"
    || typeof value.listSessions !== "function") {
    throw new TypeError("Provider observer must implement start, hydrate, and listSessions");
  }
  if (value.stop !== undefined && typeof value.stop !== "function") {
    throw new TypeError("Provider observer stop must be a function");
  }
  return /** @type {ProviderObserver} */ (value);
}

/** @param {unknown} value */
export function parseProviderSessionReference(value) {
  return providerSessionReferenceSchema.parse(value);
}

/** @param {unknown} value */
export function parseProviderUsageLimits(value) {
  return providerUsageLimitsSchema.parse(value);
}

/** @param {unknown} value @param {string} path @returns {unknown[]} */
function evidenceValuesAtPath(value, path) {
  return path.split(".").reduce((/** @type {unknown[]} */ values, segment) => values.flatMap((item) => {
    if (Array.isArray(item)) return item.flatMap((entry) => entry?.[segment] ?? []);
    const record = item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : null;
    const next = record?.[segment];
    return next === undefined || next === null ? [] : [next];
  }), /** @type {unknown[]} */ ([value]));
}

/** Monitor-private per-session observation state; never exposed as provider support. */
/** @param {ReturnType<typeof createProviderCapabilityManifest>} manifest @param {z.infer<typeof providerSessionEvidenceSchema>} evidence */
export function createProviderEvidenceAvailability(manifest, evidence) {
  return Object.freeze(Object.fromEntries(PROVIDER_CAPABILITY_CATALOG.map((capability) => {
    if (manifest[capability.key].status !== "supported") {
      return [capability.key, Object.freeze({ status: "not_applicable" })];
    }
    if (capability.evidencePath.startsWith("catalog.") || capability.evidencePath === "usageLimits") {
      return [capability.key, Object.freeze({ status: "outside_session" })];
    }
    const observed = evidenceValuesAtPath(evidence, capability.evidencePath).length > 0;
    return [capability.key, Object.freeze({ status: observed ? "observed" : "unavailable" })];
  })));
}

/**
 * Shared conformance assertion for every registered adapter and future harness
 * fixture set. It deliberately validates only normalized, browser-safe data.
 * @param {any} adapter
 * @param {unknown[]} [fixtures]
 */
export function assertProviderConformance(adapter, fixtures = []) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("Provider adapter must be an object");
  if (!isProviderId(adapter.id) || adapter.source !== providerSource(adapter.id)) throw new TypeError("Invalid provider identity");
  const manifest = createProviderCapabilityManifest(adapter.capabilityManifest);
  const readinessCapabilities = createProviderReadinessCapabilities(manifest, adapter.readinessCapabilities || []);
  if ((typeof adapter.resolveReadiness === "function") !== (readinessCapabilities.length > 0)) {
    throw new TypeError("Provider resolveReadiness and readinessCapabilities must be declared together");
  }
  const publicCapabilities = capabilitiesFromManifest(manifest);
  const adapterCapabilities = /** @type {Record<string, unknown> | undefined} */ (adapter.capabilities);
  const expectedCapabilities = /** @type {Record<string, unknown>} */ (publicCapabilities);
  if (!adapterCapabilities || PROVIDER_CAPABILITY_KEYS.some((key) => adapterCapabilities[key] !== expectedCapabilities[key])) {
    throw new TypeError("Provider browser capabilities must be derived from its manifest");
  }
  createProviderHomePolicy(adapter.homePolicy);
  if (adapter.createObserver !== undefined && typeof adapter.createObserver !== "function") {
    throw new TypeError("Provider createObserver must be a function");
  }
  for (const capability of PROVIDER_CAPABILITY_CATALOG) {
    if (manifest[capability.key].status === "supported" && typeof adapter[capability.requiredOperation] !== "function") {
      throw new TypeError(`Provider with ${capability.key} capability must implement ${capability.requiredOperation}`);
    }
  }
  if (!Array.isArray(fixtures)) throw new TypeError("Provider conformance fixtures must be an array");
  for (const fixture of fixtures) parseProviderSessionEvidence(fixture);
  return true;
}

/**
 * Validate and freeze an adapter declaration. This establishes the runtime
 * side of the TypeScript/JSDoc contract before providers are registered.
 *
 * @param {any} adapter
 */
export function defineProvider(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("Provider adapter must be an object");
  if (!isProviderId(adapter.id)) throw new TypeError(`Unknown provider: ${String(adapter.id)}`);
  for (const key of Object.keys(adapter)) {
    if (!providerObservationApiKeySet.has(key)) throw new TypeError(`Unknown provider observation API: ${key}`);
  }
  const expectedSource = providerSource(adapter.id);
  if (adapter.source !== expectedSource) throw new TypeError(`Provider ${adapter.id} source must be ${expectedSource}`);
  if (typeof adapter.listSessions !== "function") throw new TypeError("Provider adapter must implement listSessions");
  if (typeof adapter.readSession !== "function") throw new TypeError("Provider adapter must implement readSession");
  if (adapter.readTranscriptPath !== undefined && typeof adapter.readTranscriptPath !== "function") {
    throw new TypeError("Provider readTranscriptPath must be a function");
  }
  if (adapter.createObserver !== undefined && typeof adapter.createObserver !== "function") {
    throw new TypeError("Provider createObserver must be a function");
  }
  if (adapter.resolveReadiness !== undefined && typeof adapter.resolveReadiness !== "function") {
    throw new TypeError("Provider resolveReadiness must be a function");
  }
  if (adapter.unavailableMessage !== undefined && typeof adapter.unavailableMessage !== "function") {
    throw new TypeError("Provider unavailableMessage must be a function");
  }
  if (adapter.watchTargets !== undefined && (!Array.isArray(adapter.watchTargets)
    || adapter.watchTargets.some((/** @type {unknown} */ target) => typeof target !== "string" || !target))) {
    throw new TypeError("Provider watchTargets must contain non-empty strings");
  }
  if (adapter.capabilities !== undefined) {
    throw new TypeError("Provider declarations must use capabilityManifest, not browser capabilities");
  }
  const capabilityManifest = createProviderCapabilityManifest(adapter.capabilityManifest);
  const readinessCapabilities = createProviderReadinessCapabilities(capabilityManifest, adapter.readinessCapabilities || []);
  if ((typeof adapter.resolveReadiness === "function") !== (readinessCapabilities.length > 0)) {
    throw new TypeError("Provider resolveReadiness and readinessCapabilities must be declared together");
  }
  for (const capability of PROVIDER_CAPABILITY_CATALOG) {
    if (capabilityManifest[capability.key].status === "supported" && typeof adapter[capability.requiredOperation] !== "function") {
      throw new TypeError(`Provider with ${capability.key} capability must implement ${capability.requiredOperation}`);
    }
  }
  const homePolicy = adapter.homePolicy === undefined
    ? createProviderHomePolicy({
      requestModelObservations: false,
      modelSelection: false,
      usageLimitActivity: {
        enabled: false,
        weeklyLimitIds: null,
        trackedLimitIds: null,
        modelScopes: [],
        selection: { mode: "all" },
      },
    })
    : createProviderHomePolicy(adapter.homePolicy);
  const watchTargets = adapter.watchTargets ? Object.freeze([...adapter.watchTargets]) : undefined;
  return Object.freeze({
    ...adapter,
    capabilityManifest,
    readinessCapabilities,
    homePolicy,
    capabilities: capabilitiesFromManifest(capabilityManifest),
    ...(watchTargets ? { watchTargets } : {}),
  });
}
