import { createLoadingFileHistory, createLoadingRepositoryFiles, FILE_ID_PATTERN, MAX_REPOSITORY_PATH_LENGTH } from "../../../shared/repository-files-contract";
import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DRIVE_PREFIX = /^[A-Za-z]:/u;

// Shape-only mirror of the monitor's `isSafeRecordedRepositoryPath` (monitor/repository-snapshot.mjs):
// an early, low-cost rejection. The monitor is the real authority and re-validates every path itself.
function isSafeRepositoryPath(value: string) {
  if (value.length < 1 || value.length > MAX_REPOSITORY_PATH_LENGTH || CONTROL.test(value) || value.includes("\\") || DRIVE_PREFIX.test(value)) {
    return false;
  }
  return !value.split("/").some((segment) => !segment || segment === "." || segment === ".." || [".claude", ".codex"].includes(segment.toLowerCase()));
}

export async function GET(request: Request) {
  const supplied = new URL(request.url).searchParams;
  const repositoryId = supplied.get("repositoryId") || "";
  const fileId = supplied.get("fileId");
  const path = supplied.get("path");
  const validQuery = [...supplied.keys()].every((key) => ["repositoryId", "fileId", "path"].includes(key) && supplied.getAll(key).length === 1)
    && !(fileId !== null && path !== null)
    && REPOSITORY_ID_PATTERN.test(repositoryId)
    && (fileId === null || FILE_ID_PATTERN.test(fileId))
    && (path === null || isSafeRepositoryPath(path));
  if (!validQuery) {
    return Response.json({ error: "Invalid repository files query" }, { status: 400 });
  }
  const params = new URLSearchParams({ repositoryId });
  if (fileId !== null) params.set("fileId", fileId);
  if (path !== null) params.set("path", path);
  const unavailableBody = fileId || path ? createLoadingFileHistory(repositoryId, path) : createLoadingRepositoryFiles(repositoryId);
  return proxyMonitorJson({
    ifNoneMatch: request.headers.get("if-none-match"),
    acceptEncoding: request.headers.get("accept-encoding"),
    path: `/api/repository-files?${params}`,
    timeoutMs: 5_000,
    unavailableBody: { ...unavailableBody, readiness: "unavailable" },
  });
}
