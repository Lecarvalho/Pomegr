import { isIssueNumber, stripHiddenComments } from "../repository/issues.mjs";
import { TASK_BODY_LIMIT_BYTES, isPlainObject, readLimitedBody, writeActionResult } from "./task-routes.mjs";

// The GitHub issue routes of the task board (desktop token only; the request handler applies the private-action gate).
// Issue text is written by other people and is untrusted: nothing from the request body reaches the store except the
// issue number and digest, which are only compared against a fresh read of the issue from GitHub.
export const TASK_ISSUE_ACTIONS = Object.freeze(["github-status", "issues-list", "issue-promote"]);

const PREFIX = "/internal/tasks/";
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const STATUS = Object.freeze({ invalid: 400, not_found: 404, conflict: 409, limit: 409, unavailable: 503 });
const rejected = (error) => ({ ok: false, error });
const refuse = (response, error, status = STATUS[error], options) => writeActionResult(response, status, rejected(error), options);

/** An explicit allowlist: `taskText` and every other field of the held issue never reach the answer. */
function projectIssue(issue, taskId) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    bodyTruncated: issue.bodyTruncated === true,
    hiddenComments: {
      count: issue.hiddenComments.count,
      ranges: issue.hiddenComments.ranges.map((range) => ({ start: range.start, end: range.end })),
    },
    characters: issue.characters,
    tooLong: issue.tooLong === true,
    authorAssociation: issue.authorAssociation,
    updatedAt: issue.updatedAt,
    digest: issue.digest,
    taskId,
  };
}

async function readEnvelope(request, response, requestUrl) {
  if (requestUrl.search) { refuse(response, "invalid"); return null; }
  if (Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES) { refuse(response, "invalid", 413, { close: true }); return null; }
  let raw;
  try {
    raw = await readLimitedBody(request, TASK_BODY_LIMIT_BYTES);
  } catch {
    refuse(response, "invalid", 400, { close: true });
    return null;
  }
  if (raw === null) { refuse(response, "invalid", 413, { close: true }); return null; }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { refuse(response, "invalid"); return null; }
  const valid = isPlainObject(body) && Object.keys(body).every((key) => key === "repositoryId" || key === "payload")
    && typeof body.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(body.repositoryId) && isPlainObject(body.payload);
  if (!valid) { refuse(response, "invalid"); return null; }
  return body;
}

const emptyPayload = (payload) => Object.keys(payload).length === 0;
const promotePayload = (payload) => {
  const keys = Object.keys(payload);
  return keys.length === 2 && keys.includes("number") && keys.includes("digest")
    && isIssueNumber(payload.number) && typeof payload.digest === "string" && DIGEST_PATTERN.test(payload.digest);
};

async function promote({ response, taskStore, taskIssues, repositoryId, payload }) {
  const { status, issue } = await taskIssues.read(repositoryId, payload.number);
  if (status !== "ok" || issue === null) {
    if (status === "not_found") refuse(response, "not_found");
    else refuse(response, "unavailable");
    return;
  }
  if (issue.digest !== payload.digest) { refuse(response, "conflict"); return; }
  if (issue.tooLong) { refuse(response, "limit"); return; }
  const result = taskStore.apply(repositoryId, "promote_issue", { number: issue.number, title: issue.title, body: stripHiddenComments(issue.body) });
  if (result?.ok === true && typeof result.taskId === "string") {
    writeActionResult(response, 200, { ok: true, taskId: result.taskId });
    return;
  }
  refuse(response, Object.hasOwn(STATUS, result?.error) ? result.error : "unavailable");
}

/**
 * `POST /internal/tasks/github-status | issues-list | issue-promote`. The body is `{ repositoryId, payload }`; the
 * answer is `{ ok: true, ... }` or `{ ok: false, error }`, never an echo of the input, a path, or the repository root.
 */
export async function serveTaskIssueRoute({ request, response, requestUrl, taskStore, taskIssues }) {
  const action = requestUrl.pathname.slice(PREFIX.length);
  if (!TASK_ISSUE_ACTIONS.includes(action)) { refuse(response, "invalid", 404); return; }
  const body = await readEnvelope(request, response, requestUrl);
  if (body === null) return;
  if (!(action === "issue-promote" ? promotePayload(body.payload) : emptyPayload(body.payload))) { refuse(response, "invalid"); return; }
  try {
    if (typeof taskStore?.apply !== "function" || typeof taskStore.promotedIssues !== "function" || typeof taskIssues?.list !== "function") {
      refuse(response, "unavailable");
      return;
    }
    const { repositoryId, payload } = body;
    if (action === "github-status") {
      const { connection, repository } = await taskIssues.status(repositoryId);
      writeActionResult(response, 200, {
        ok: true,
        connection,
        repository: repository === null ? null : { visibility: repository.visibility, capabilities: [...repository.capabilities] },
      });
    } else if (action === "issues-list") {
      const result = await taskIssues.list(repositoryId);
      const promoted = result.status === "ok" ? taskStore.promotedIssues(repositoryId) : new Map();
      writeActionResult(response, 200, {
        ok: true,
        status: result.status,
        readAt: result.readAt,
        truncated: result.truncated === true,
        issues: result.status === "ok" ? result.issues.map((issue) => projectIssue(issue, promoted.get(issue.number) ?? null)) : [],
      });
    } else {
      await promote({ response, taskStore, taskIssues, repositoryId, payload });
    }
  } catch {
    refuse(response, "unavailable");
  }
}
