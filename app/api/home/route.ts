import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyMonitorJson({
    path: "/api/home",
    timeoutMs: 10000,
    unavailableBody: { generatedAt: null, providerLimits: [], limitActivities: [], projects: [], error: "Home overview is unavailable." },
  });
}
