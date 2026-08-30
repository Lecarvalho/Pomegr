import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const revision = requestUrl.searchParams.get("revision");
  const monitorParams = new URLSearchParams();
  if (revision !== null && revision !== "") monitorParams.set("revision", revision);
  return proxyMonitorJson({
    path: `/api/sessions${monitorParams.size ? `?${monitorParams}` : ""}`,
    timeoutMs: 7500,
    unavailableBody: { sessions: [], error: "Historical sessions are unavailable." },
  });
}
