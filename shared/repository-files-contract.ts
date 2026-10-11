// Repository file history served from the monitor's committed file-history cache.

export type FileChangeKind = "created" | "edited" | "deleted" | "moved";
export type FileHistoryReadiness = "loading" | "ready" | "unavailable" | "rebuilding";
export type FileHistoryProvider = "claude" | "codex";

export const FILE_ID_PATTERN = /^f[1-9][0-9]{0,15}$/u;
export const MAX_REPOSITORY_PATH_LENGTH = 512;

export type RepositoryFileEntry = {
  fileId: string;
  path: string; // current repository-relative path
  sessionCount: number; // distinct recorded sessions with at least one attributed change
  deleted: boolean; // last recorded state is deleted (a "historical file")
};

// Distinct-session rollup for one folder prefix (e.g.
export type RepositoryFolderCount = { path: string; sessionCount: number };

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

export type FileHistorySession = {
  sessionId: string;
  title: string | null; // committed catalog title; null when the session left the catalog
  provider: FileHistoryProvider | null;
  live: boolean;
  kind: FileChangeKind; // "created" when the session created the file, otherwise its newest kind
  editCount: number; // number of recorded "edited" changes in this session
  newestAt: string; // ISO time of the session's newest change to this file
  agents: Array<{ id: string; label: string | null; assignment: string | null; model: string | null }>;
  pathAtTime: string | null; // path during the session's newest change when it differs from the current path
};

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
