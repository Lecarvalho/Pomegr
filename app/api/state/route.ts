import { createEmptyMonitorState, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";
import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const sessionId = requestUrl.searchParams.get("sessionId") || "";
  const monitorParams = new URLSearchParams();
  if (sessionId) monitorParams.set("sessionId", sessionId);
  const path = `/api/state${monitorParams.size ? `?${monitorParams}` : ""}`;

  return proxyMonitorJson({
    path,
    timeoutMs: 7500,
    unavailableBody: createEmptyMonitorState({
      usageLimits: createEmptyUsageLimits({ error: "Usage limits are unavailable." }),
      error: "The local session monitor is unavailable.",
    }),
  });
}
