// Desktop main declares the session ID of the agent chat's own run for one turn, and withdraws it after: the ID and
// nothing else. The monitor keeps it in memory; see the agent chat's privacy rules.

export const CHAT_RUN_DECLARE_PATH = "/internal/agent-chat/run-declare";
export const CHAT_RUN_WITHDRAW_PATH = "/internal/agent-chat/run-withdraw";
export const CHAT_RUN_PATHS = new Set([CHAT_RUN_DECLARE_PATH, CHAT_RUN_WITHDRAW_PATH]);

/** Answers `{ ok }` for a request the caller already admitted as desktop main's own POST. */
export function serveChatRunRoute({ request, response, requestUrl, runtime }) {
  const keys = [...requestUrl.searchParams.keys()];
  const sessionId = requestUrl.searchParams.get("sessionId") || "";
  const valid = keys.length === 1 && keys[0] === "sessionId" && requestUrl.searchParams.getAll("sessionId").length === 1
    && Number(request.headers["content-length"] || 0) === 0 && request.headers["transfer-encoding"] === undefined;
  const declaring = requestUrl.pathname === CHAT_RUN_DECLARE_PATH;
  let ok = false;
  try { ok = valid && Boolean(declaring ? runtime.declareChatRun?.(sessionId) : runtime.withdrawChatRun?.(sessionId)); } catch { ok = false; }
  response.writeHead(ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok }));
}
