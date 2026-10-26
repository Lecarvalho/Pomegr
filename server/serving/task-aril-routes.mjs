import { isBranchName } from "../../shared/git-branch-name.mjs";

const STATUS = Object.freeze({ invalid: 400, not_found: 404, limit: 409, conflict: 409, not_ready: 409, unsupported: 501 });
const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
};

export function serveArilActionRoute({ request, response, taskStore, repositoryId, action, payload }) {
  try {
    if (request.headers["x-pomegr-lan-gateway"] === "1") {
      if (action === "aril_settings_set" && payload.settings && typeof payload.settings === "object"
        && !Array.isArray(payload.settings) && Object.hasOwn(payload.settings, "pairedDevices")) {
        json(response, 400, { ok: false, error: "invalid" });
        return;
      }
      if (action !== "grant_stop" && taskStore?.readBoard(repositoryId)?.aril?.settings?.pairedDevices !== true) {
        json(response, 403, { ok: false, error: "unavailable" });
        return;
      }
    }
    if (typeof taskStore?.apply !== "function") {
      json(response, 503, { ok: false, error: "conflict" });
      return;
    }
    const result = taskStore.apply(repositoryId, action, payload);
    if (result?.ok === true) {
      if (action === "grant_start" && result.grant && typeof result.grant === "object") {
        json(response, 200, { ok: true, grant: result.grant });
        return;
      }
      if (action === "aril_settings_set" && result.settings && typeof result.settings === "object" && !Array.isArray(result.settings)) {
        json(response, 200, { ok: true, settings: result.settings });
        return;
      }
      if ((action === "aril_memory_add" || action === "aril_memory_update") && result.entry && typeof result.entry === "object" && !Array.isArray(result.entry)) {
        json(response, 200, { ok: true, entry: result.entry });
        return;
      }
      if (action === "aril_memory_remove" || action === "grant_stop") {
        json(response, 200, { ok: true });
        return;
      }
    }
    const error = Object.hasOwn(STATUS, result?.error) ? result.error : "conflict";
    json(response, STATUS[error], { ok: false, error });
  } catch {
    json(response, 503, { ok: false, error: "conflict" });
  }
}

const GRANT_STATUS = Object.freeze({ invalid: 400, not_found: 404, not_active: 409, not_eligible: 409, not_allowed: 409, limit: 409, unavailable: 503 });
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const rejected = (error) => ({ ok: false, error });

export function serveArilRework({ request, response, taskStore, body }) {
  if (request.headers["x-pomegr-lan-gateway"] !== undefined) { json(response, 403, rejected("unavailable")); return; }
  const fields = ["repositoryId", "fix", "reworks", "cause"];
  if (!isPlainObject(body) || Object.keys(body).length !== fields.length || !fields.every((key) => Object.hasOwn(body, key))
    || typeof body.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(body.repositoryId)) {
    json(response, 400, rejected("invalid")); return;
  }
  try {
    const result = taskStore?.declareArilRework?.(body.repositoryId, { fix: body.fix, reworks: body.reworks, cause: body.cause });
    if (result?.ok === true && ["recorded", "exists"].includes(result.status)) {
      json(response, 200, { ok: true, status: result.status }); return;
    }
    const error = ["invalid", "not_found", "limit"].includes(result?.error) ? result.error : "unavailable";
    json(response, GRANT_STATUS[error], rejected(error));
  } catch { json(response, 503, rejected("unavailable")); }
}

const headKnown = (head) => typeof head === "string" && /^[a-f0-9]{40}$/u.test(head);
const pullKnown = (number) => Number.isSafeInteger(number) && number > 0;
const methodKnown = (method) => [null, "squash", "merge", "rebase"].includes(method);
const modeKnown = (mode) => ["direct", "auto"].includes(mode);
const modelKnown = (model) => typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u.test(model);
const effortKnown = (effort) => ["low", "medium", "high", "xhigh"].includes(effort);
const runKnown = (run) => isPlainObject(run) && Object.keys(run).length === 3
  && ["provider", "model", "effort"].every((key) => Object.hasOwn(run, key))
  && ["claude", "codex"].includes(run.provider)
  && (run.model === null || modelKnown(run.model))
  && (run.effort === null || effortKnown(run.effort));
export function serveGrantRunner({ request, response, taskStore, resolveGateFacts, resolveUsage, resolvePullRequestFacts, action, body }) {
  if (request.headers["x-pomegr-lan-gateway"] === "1") { json(response, 403, rejected("unavailable")); return; }
  const fields = action === "grant-next" ? [] : action === "grant-record" ? ["repositoryId", "taskId", "kind"]
    : action === "grant-write-tasks" ? ["repositoryId", "plan", "tasks"]
    : action === "grant-send-back" ? ["repositoryId", "taskId"]
    : action === "grant-merge-attempt" ? ["repositoryId", "taskId", "headOid"]
    : action === "grant-merge-result" ? ["repositoryId", "taskId", "headOid", "outcome"]
    : action === "grant-branch-result" ? ["repositoryId", "taskId", "outcome"]
    : action === "grant-end" ? ["repositoryId", "reason"] : action === "grant-end-all" ? ["reason"] : ["repositoryId"];
  if (!isPlainObject(body) || Object.keys(body).length !== fields.length || !fields.every((key) => Object.hasOwn(body, key))
    || (fields.includes("repositoryId") && (typeof body.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(body.repositoryId)))
    || (action === "grant-send-back" && (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId)))
    || (fields.includes("headOid") && (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId) || !headKnown(body.headOid)))
    || (action === "grant-branch-result" && (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId) || !["deleted", "refused"].includes(body.outcome)))
    || (action === "grant-merge-result" && !["merged", "auto_enabled", "refused", "failed"].includes(body.outcome))
    || (action === "grant-record" && (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId) || !["start", "review"].includes(body.kind)))
    || (action === "grant-end" && !["start_failed", "app_restart"].includes(body.reason))
    || (action === "grant-end-all" && body.reason !== "app_restart")) {
    json(response, 400, rejected("invalid")); return;
  }
  try {
    const result = action === "grant-end-all" ? taskStore?.endAllGrants?.({ reason: body.reason })
      : action === "grant-next" ? taskStore?.nextGrantSteps?.({ resolveGateFacts, resolveUsage, resolvePullRequestFacts })
      : action === "grant-write-tasks" ? taskStore?.writeGrantTasks?.(body.repositoryId, { plan: body.plan, tasks: body.tasks })
      : action === "grant-merge-attempt" ? taskStore?.attemptGrantMerge?.(body.repositoryId, { taskId: body.taskId, headOid: body.headOid }, resolvePullRequestFacts)
      : action === "grant-merge-result" ? taskStore?.recordGrantMerge?.(body.repositoryId, { taskId: body.taskId, headOid: body.headOid, outcome: body.outcome })
      : action === "grant-branch-result" ? taskStore?.recordGrantBranchDelete?.(body.repositoryId, { taskId: body.taskId, outcome: body.outcome })
      : action === "grant-send-back" ? taskStore?.sendBackGrant?.(body.repositoryId, { taskId: body.taskId })
      : action === "grant-record" ? taskStore?.recordGrant?.(body.repositoryId, { taskId: body.taskId, kind: body.kind })
        : action === "grant-check" ? taskStore?.checkGrant?.(body.repositoryId) : taskStore?.endGrant?.(body.repositoryId, { reason: body.reason });
    if (result?.ok !== true) {
      const error = action === "grant-write-tasks" ? (["not_active", "not_allowed", "limit", "invalid"].includes(result?.error) ? result.error : "invalid")
        : Object.hasOwn(GRANT_STATUS, result?.error) ? result.error : "unavailable";
      json(response, GRANT_STATUS[error], rejected(error)); return;
    }
    if (action === "grant-next") {
      if (!Array.isArray(result.steps)) throw new TypeError("Grant steps unavailable");
      const steps = result.steps.filter((entry) => isPlainObject(entry) && typeof entry.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(entry.repositoryId)
        && (!Object.hasOwn(entry, "run") || (entry.kind === "review" && runKnown(entry.run)))
        && (entry.kind === "write_tasks" ? Array.isArray(entry.plans) && entry.plans.length > 0 && entry.plans.every((plan) => typeof plan === "string")
          : typeof entry.taskId === "string" && TASK_ID_PATTERN.test(entry.taskId) && ["start", "review", "send_back", "merge", "delete_branch"].includes(entry.kind))
        && (entry.kind !== "merge" || pullKnown(entry.pullRequest) && headKnown(entry.headOid) && methodKnown(entry.mergeMethod) && modeKnown(entry.mergeMode))
        && (entry.kind !== "delete_branch" || pullKnown(entry.pullRequest) && isBranchName(entry.branch)))
        .slice(0, 16).map(({ repositoryId, taskId, kind, plans, pullRequest, headOid, mergeMethod, mergeMode, branch, run }) => kind === "write_tasks" ? { repositoryId, kind, plans }
          : { repositoryId, taskId, kind, ...(kind === "merge" ? { pullRequest, headOid, mergeMethod, mergeMode } : {}), ...(kind === "delete_branch" ? { pullRequest, branch } : {}), ...(kind === "review" && run ? { run } : {}) });
      json(response, 200, { ok: true, steps });
    } else if (action === "grant-write-tasks") {
      if (!Array.isArray(result.taskIds) || !result.taskIds.every((id) => typeof id === "string" && TASK_ID_PATTERN.test(id))) throw new TypeError("Written tasks unavailable");
      json(response, 200, { ok: true, taskIds: result.taskIds });
    } else if (action === "grant-merge-attempt") {
      if (!pullKnown(result.pullRequest)) throw new TypeError("Merge unavailable");
      json(response, 200, { ok: true, pullRequest: result.pullRequest });
    } else if (action === "grant-check") {
      if (typeof result.active !== "boolean") throw new TypeError("Grant state unavailable");
      json(response, 200, { ok: true, active: result.active });
    } else if (action === "grant-end-all") {
      if (!Number.isSafeInteger(result.ended) || result.ended < 0) throw new TypeError("Grant count unavailable");
      json(response, 200, { ok: true, ended: result.ended });
    } else json(response, 200, { ok: true });
  } catch { json(response, action === "grant-write-tasks" ? 400 : 503, rejected(action === "grant-write-tasks" ? "invalid" : "unavailable")); }
}
