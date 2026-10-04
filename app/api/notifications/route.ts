import type { NotificationSnapshot } from "../../../shared/notification-contract";
import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

const UNAVAILABLE_NOTIFICATIONS: NotificationSnapshot = {
  version: 1,
  revision: 0,
  generatedAt: null,
  readiness: { catalog: "unavailable", providerStatus: "unavailable" },
  occurrences: [],
  activeSessionOverflow: 0,
};

export async function GET(request: Request) {
  const revision = new URL(request.url).searchParams.get("revision");
  const params = new URLSearchParams();
  if (revision !== null && /^\d{1,20}$/u.test(revision)) params.set("revision", revision);
  return proxyMonitorJson({
    ifNoneMatch: request.headers.get("if-none-match"),
    acceptEncoding: request.headers.get("accept-encoding"),
    path: `/api/notifications${params.size ? `?${params}` : ""}`,
    timeoutMs: 7500,
    unavailableBody: UNAVAILABLE_NOTIFICATIONS,
  });
}
