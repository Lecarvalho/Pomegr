// The temporary loopback bridge of one chat turn: the way the chat's own MCP server reads a task of the turn's repository. It lives
// only while the turn runs, takes only the two task reads, and answers only what the monitor's non-writing task reader answers.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;

/**
 * One memory-only capability per turn. Only this bridge knows the repository and the desktop credential. `monitor(pathname, init)`
 * is the caller's request to the monitor, and `current(turn)` says whether the turn is still the one that runs: the bridge answers a read
 * only while it does. `opens(turn)` says whether the bridge may be opened for a turn at all, and is `current` unless given: a warm run's
 * bridge opens before its turn exists, answers nothing until a turn takes the run, and `current` then says whether that turn runs.
 * Answers the MCP server entry with the bridge's origin and key in its environment, the entry unchanged when the bridge could not
 * start, or null when the turn ended meanwhile or there is no MCP server.
 */
export function createTaskBridge({ mcpServer, monitor, current, opens = current }) {
  return async function taskReadServer(turn) {
    if (!mcpServer) return null;
    const key = randomBytes(32).toString("base64url");
    const server = createServer(async (request, response) => {
      const supplied = request.headers["x-pomegr-chat-task-key"];
      const authenticated = typeof supplied === "string" && /^[A-Za-z0-9_-]{43}$/u.test(supplied)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(key));
      let url = null;
      try { url = new URL(request.url || "/", "http://127.0.0.1"); } catch { /* malformed request is refused */ }
      const taskId = url?.searchParams.get("task_id");
      const listing = url?.pathname === "/tasks";
      const filters = ["query", "state", "feature", "editable"];
      const listValid = listing && [...url.searchParams.keys()].every((name) => filters.includes(name))
        && [...url.searchParams.keys()].length === new Set(url.searchParams.keys()).size;
      const valid = authenticated && request.headers.origin === undefined
        && request.headers.host === `127.0.0.1:${server.address()?.port}`
        && request.method === "GET" && (listing ? listValid : url?.pathname === "/task" && TASK_ID.test(taskId ?? "")
          && [...url.searchParams.keys()].length === 1) && !request.headers["transfer-encoding"]
        && !(Number(request.headers["content-length"] || 0) > 0) && current(turn) && !turn.stopped;
      let answer = { ok: false };
      if (valid) {
        try {
          const params = listing ? Object.fromEntries(url.searchParams) : { taskId };
          answer = await monitor(`/internal/agent-chat/task?${new URLSearchParams({ repositoryId: turn.repositoryId, ...params })}`, { method: "GET" });
        }
        catch { /* fixed unavailable answer */ }
      }
      response.writeHead(valid ? 200 : 403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(answer));
    });
    const close = () => { server.close(); server.closeAllConnections(); };
    turn.closeTaskRead = close;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      if (turn.stopped || !opens(turn)) { close(); return null; }
      return { ...mcpServer, env: { ...mcpServer.env,
        POMEGR_CHAT_TASK_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        POMEGR_CHAT_TASK_KEY: key,
      } };
    } catch { close(); return mcpServer; }
  };
}
