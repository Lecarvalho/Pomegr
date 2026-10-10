import { createIssueReader } from "../repository/issues.mjs";

const HELD_REPOSITORY_LIMIT = 16;

/**
 * The monitor's GitHub issue composition for the task board. It joins the recognized repository root (monitor-private,
 * it never leaves this module) to the issue reader. Every call is an explicit desktop action: no GET reaches it and
 * nothing runs on a timer.
 *
 * The last successful list of each repository is held in memory only, for at most 16 repositories (the oldest is
 * evicted). It is never persisted, logged, or served as such: a promote always reads its issue again.
 *
 * @param {{ repositoryRoot: (repositoryId: string) => string | null | undefined, reader?: ReturnType<typeof createIssueReader>, now?: () => number }} options
 */
export function createTaskIssues({ repositoryRoot, reader = createIssueReader(), now = Date.now }) {
  const held = new Map();
  const rootOf = (repositoryId) => {
    const root = typeof repositoryRoot === "function" ? repositoryRoot(repositoryId) : null;
    return typeof root === "string" && root !== "" ? root : null;
  };

  /** `{ connection, repository }`; `repository` is `{ visibility, capabilities }` only when connected and the root is recognized. */
  async function status(repositoryId) {
    const connection = await reader.connection();
    const root = connection === "connected" ? rootOf(repositoryId) : null;
    if (root === null) return { connection, repository: null };
    const access = await reader.repositoryAccess(root);
    return { connection, repository: { visibility: access.visibility, capabilities: [...access.capabilities] } };
  }

  /** Reads the open issues now. Issues are empty unless the status is `ok`; an unknown root is `unavailable`. */
  async function list(repositoryId) {
    const root = rootOf(repositoryId);
    const result = root === null ? { status: "unavailable", issues: [], truncated: false } : await reader.listOpenIssues(root);
    const answer = {
      status: result.status,
      readAt: new Date(now()).toISOString(),
      truncated: result.status === "ok" && result.truncated === true,
      issues: result.status === "ok" ? result.issues : [],
    };
    if (answer.status === "ok") {
      held.delete(repositoryId);
      held.set(repositoryId, answer);
      while (held.size > HELD_REPOSITORY_LIMIT) held.delete(held.keys().next().value);
    }
    return answer;
  }

  /** Reads one issue again from GitHub, never from the held list. */
  async function read(repositoryId, number) {
    const root = rootOf(repositoryId);
    if (root === null) return { status: "unavailable", issue: null };
    const result = await reader.readIssue(root, number);
    return { status: result.status, issue: result.status === "ok" ? result.issue : null };
  }

  /** Creates one issue now. `{ status: "ok", number }` or one fixed failure; an unknown root is `unavailable`. */
  async function create(repositoryId, { title, body }) {
    const root = rootOf(repositoryId);
    if (root === null) return { status: "unavailable", number: null };
    const result = await reader.createIssue(root, { title, body });
    return { status: result.status, number: result.status === "ok" ? result.number : null };
  }

  return Object.freeze({ status, list, read, create, held: (repositoryId) => held.get(repositoryId) ?? null });
}
