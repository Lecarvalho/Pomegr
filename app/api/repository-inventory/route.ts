import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supplied = new URL(request.url).searchParams;
  const repositoryId = supplied.get("repositoryId") || "";
  const provider = supplied.get("provider") || "";
  const revisionId = supplied.get("revisionId") || "";
  if (!/^repo-[a-f0-9]{24}$/u.test(repositoryId) || !["claude", "codex"].includes(provider)
    || !/^ctx-\d{3,9}$/u.test(revisionId)) {
    return Response.json({ error: "Invalid repository inventory reference" }, { status: 400 });
  }
  const params = new URLSearchParams({ repositoryId, provider, revisionId });
  return proxyMonitorJson({
    path: `/api/repository-inventory?${params}`,
    timeoutMs: 4_000,
    unavailableBody: { error: "Repository inventory unavailable" },
  });
}
