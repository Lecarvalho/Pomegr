import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const revision = new URL(request.url).searchParams.get("revision");
  const params = new URLSearchParams();
  if (revision && /^\d+$/u.test(revision)) params.set("revision", revision);
  return proxyMonitorJson({
    ifNoneMatch: request.headers.get("if-none-match"),
    acceptEncoding: request.headers.get("accept-encoding"),
    path: `/api/repositories${params.size ? `?${params}` : ""}`,
    timeoutMs: 4_000,
    unavailableBody: { revision: 0, readiness: "unavailable", repositories: [] },
  });
}
