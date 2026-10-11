// Counts describe validated top-level identities, never transcript files or agents.
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
  // Returns bounded groups instead of a row page.
  group?: "project" | "provider" | "feature";
  // One feature ID: only the sessions started for that feature's tasks.
  feature?: string;
  sort?: "newest" | "oldest" | "title";
  pageSize?: number;
  cursor?: string;
  revision?: string | number;
};

export type SessionTaskReference = {
  id: string;
  repositoryId: string;
  // An outcome the session's own state cannot show, else null.
  state: "needs_review" | "stalled" | "blocked" | "done" | null;
  featureId: string | null;
  feature: string | null;
  step: number | null;
  issue?: number | null;
};

// Whether directory rows carry `task`.
export type SessionDirectoryTaskReadiness = "ready" | "desktop_only" | "unavailable";

export type WithSessionTask<Row> = Row & { task?: SessionTaskReference | null };

export type SessionDirectoryTaskFields<Row> = {
  sessions: WithSessionTask<Row>[];
  taskReadiness?: SessionDirectoryTaskReadiness;
  feature?: { id: string; name: string } | null;
};

export type SessionDirectoryGroup<Row> = {
  key: string;
  label: string;
  count: number;
  live: number;
  needs: number;
  latestUpdatedAt: string | null;
  sessions: Row[];
};

export type SessionDirectoryGroups<Row> = {
  groupBy?: "project" | "provider" | "feature";
  groups?: SessionDirectoryGroup<Row>[];
  groupCount?: number;
};
