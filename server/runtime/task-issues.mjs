import { createIssueReader } from "../repository/issues.mjs";

const HELD_REPOSITORY_LIMIT = 16;

/**
 * @param {{ repositoryRoot: (repositoryId: string) => string | null | undefined, reader?: ReturnType<typeof createIssueReader>, now?: () => number }} options
 */
export function createTaskIssues({ repositoryRoot, reader = createIssueReader(), now = Date.now }) {
  const held = new Map();
  const rootOf = (repositoryId) => {
    const root = typeof repositoryRoot === "function" ? repositoryRoot(repositoryId) : null;
    return typeof root === "string" && root !== "" ? root : null;
  };

  async function status(repositoryId) {
    const connection = await reader.connection();
    const root = connection === "connected" ? rootOf(repositoryId) : null;
    if (root === null) return { connection, repository: null };
    const access = await reader.repositoryAccess(root);
    return { connection, repository: { visibility: access.visibility, capabilities: [...access.capabilities] } };
  }

  // Reads the open issues now.
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

  async function read(repositoryId, number) {
    const root = rootOf(repositoryId);
    if (root === null) return { status: "unavailable", issue: null };
    const result = await reader.readIssue(root, number);
    return { status: result.status, issue: result.status === "ok" ? result.issue : null };
  }

  async function create(repositoryId, { title, body }) {
    const root = rootOf(repositoryId);
    if (root === null) return { status: "unavailable", number: null };
    const result = await reader.createIssue(root, { title, body });
    return { status: result.status, number: result.status === "ok" ? result.number : null };
  }

  return Object.freeze({ status, list, read, create, held: (repositoryId) => held.get(repositoryId) ?? null });
}
