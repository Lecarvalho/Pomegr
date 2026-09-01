import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supplied = new URL(request.url).searchParams;
  const project = supplied.get("project");
  const days = supplied.get("days");
  const scope = supplied.get("scope");
  const revision = supplied.get("revision");
  const params = new URLSearchParams({
    project: project && project.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(project) ? project : "all",
    days: days && ["7", "30", "90"].includes(days) ? days : "30",
    scope: scope && ["all", "main", "delegated"].includes(scope) ? scope : "all",
  });
  if (revision !== null && revision.length <= 16 && /^\d+$/u.test(revision) && Number.isSafeInteger(Number(revision))) params.set("revision", String(Number(revision)));
  return proxyMonitorJson({
    path: "/api/agents?" + params,
    timeoutMs: 7500,
    unavailableBody: { readiness: "unavailable", generatedAt: null, error: "Agent summary is unavailable." },
  });
}
