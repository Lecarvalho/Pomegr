import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const revision = requestUrl.searchParams.get("revision");
  const monitorParams = new URLSearchParams({ scope: "aggregates" });
  if (revision !== null && revision !== "") monitorParams.set("revision", revision);
  return proxyMonitorJson({
    path: `/api/home?${monitorParams}`,
    timeoutMs: 10000,
    unavailableBody: { generatedAt: null, providerLimits: [], limitActivities: [], error: "Home overview is unavailable." },
  });
}
