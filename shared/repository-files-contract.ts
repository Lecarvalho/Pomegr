/**
 * Repository file history served from the monitor's committed file-history cache.
 *
 * Privacy: only normalized repository/session/agent identities, an opaque file identity
 * (`f<integer>`), bounded repository-relative paths validated monitor-side, fixed change
 * kinds, bounded counts, and ISO timestamps. Never commands, tool arguments, provider or
 * transcript paths, or absolute paths. Session and agent attribution appears only where
 * recorded evidence proves it; Git-observed moves add file continuity, never attribution.
 */

export type FileChangeKind = "created" | "edited" | "deleted" | "moved";
export type FileHistoryReadiness = "loading" | "ready" | "unavailable" | "rebuilding";
export type FileHistoryProvider = "claude" | "codex";

/** Opaque file identity: `f` followed by the store's integer file ID. */
export const FILE_ID_PATTERN = /^f[1-9][0-9]{0,15}$/u;
/** Upper bound for a repository-relative path accepted in a query or served in a response. */
export const MAX_REPOSITORY_PATH_LENGTH = 512;

/** One file in a repository listing. */
export type RepositoryFileEntry = {
  fileId: string;
  path: string; // current repository-relative path
  sessionCount: number; // distinct recorded sessions with at least one attributed change
  deleted: boolean; // last recorded state is deleted (a "historical file")
};

/** Distinct-session rollup for one folder prefix (e.g. "app/components"); never a sum. */
export type RepositoryFolderCount = { path: string; sessionCount: number };

/** GET /api/repository-files?repositoryId=<id> */
export type RepositoryFilesResponse = {
  kind: "files";
  revision: number;
  readiness: FileHistoryReadiness;
  repositoryId: string;
  files: RepositoryFileEntry[]; // path-ascending, includes deleted files; bounded
  folders: RepositoryFolderCount[]; // over non-deleted files; the client may hide deleted ones
  historicalFolders: RepositoryFolderCount[]; // same rollup including deleted files
  truncated: boolean; // more files exist beyond the bound
};

/** One session's grouped changes to a single file identity. */
export type FileHistorySession = {
  sessionId: string;
  title: string | null; // committed catalog title; null when the session left the catalog
  provider: FileHistoryProvider | null;
  live: boolean;
  kind: FileChangeKind; // "created" when the session created the file, otherwise its newest kind
  editCount: number; // number of recorded "edited" changes in this session
  newestAt: string; // ISO time of the session's newest change to this file
  agents: Array<{ id: string; label: string | null }>; // normalized agent IDs; label only when committed evidence names it
  pathAtTime: string | null; // path during the session's newest change when it differs from the current path
};

/** GET /api/repository-files?repositoryId=<id>&fileId=<f..> or &path=<relative path> */
export type FileHistoryResponse = {
  kind: "history";
  revision: number;
  readiness: FileHistoryReadiness;
  repositoryId: string;
  fileId: string | null; // null when the path matched no recorded file
  path: string | null; // current path of the file, or the requested path when unmatched
  sessions: FileHistorySession[]; // newest first, bounded
  unattributedChanges: number; // changes with no session attribution (Git-observed moves)
  truncated: boolean;
};

export type RepositoryFilesQuery = { repositoryId: string; fileId?: string; path?: string };

export function createLoadingRepositoryFiles(repositoryId: string): RepositoryFilesResponse {
  return { kind: "files", revision: 0, readiness: "loading", repositoryId, files: [], folders: [], historicalFolders: [], truncated: false };
}

export function createLoadingFileHistory(repositoryId: string, path: string | null = null): FileHistoryResponse {
  return { kind: "history", revision: 0, readiness: "loading", repositoryId, fileId: null, path, sessions: [], unattributedChanges: 0, truncated: false };
}
