import { createEmptyProviderStatusSnapshot } from "../../../shared/provider-status.mjs";
import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const revision = new URL(request.url).searchParams.get("revision");
  const params = new URLSearchParams();
  if (revision !== null && /^\d+$/u.test(revision)) params.set("revision", revision);
  return proxyMonitorJson({
    path: `/api/provider-status${params.size ? `?${params}` : ""}`,
    timeoutMs: 7500,
    unavailableBody: createEmptyProviderStatusSnapshot("unavailable"),
  });
}
