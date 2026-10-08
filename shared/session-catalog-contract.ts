/** Counts describe validated top-level identities, never transcript files or agents. */
export type SessionCatalogCoverage = {
  status: "discovering" | "complete" | "partial";
  knownCount: number;
  exactTotal: number | null;
  observedAt: string | null;
  lastCompletedTotal: number | null;
  lastCompletedAt: string | null;
};

export type SessionDirectoryQuery = {
  query?: string;
  filter?: "all" | "live" | "needs";
  project?: string;
  repositoryId?: string;
  provider?: "claude" | "codex";
  /** Returns bounded groups instead of a row page. */
  group?: "project" | "provider";
  sort?: "newest" | "oldest" | "title";
  pageSize?: number;
  cursor?: string;
  revision?: string | number;
};

/** One project or provider group of a grouped directory response: scoped tallies and its newest-created rows. */
export type SessionDirectoryGroup<Row> = {
  /** The project name, or the normalized provider ID; passed back as the `project` or `provider` scope. */
  key: string;
  label: string;
  count: number;
  live: number;
  needs: number;
  /** The newest recorded update among the group's sessions. */
  latestUpdatedAt: string | null;
  /** A bounded head of the group, newest-created first; `count` may exceed it. */
  sessions: Row[];
};

/** Present on a grouped directory response, which carries `groups` instead of a row page and has no cursor. */
export type SessionDirectoryGroups<Row> = {
  groupBy?: "project" | "provider";
  /** A bounded list ordered by newest recorded update; `groupCount` may exceed it. */
  groups?: SessionDirectoryGroup<Row>[];
  groupCount?: number;
};
