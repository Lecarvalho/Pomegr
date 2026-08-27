import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyMonitorJson({
    path: "/api/home?scope=aggregates",
    timeoutMs: 10000,
    unavailableBody: { generatedAt: null, providerLimits: [], limitActivities: [], error: "Home overview is unavailable." },
  });
}
