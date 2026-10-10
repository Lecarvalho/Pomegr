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
  /** Returns bounded groups instead of a row page. `feature` groups only sessions started for a feature's task. */
  group?: "project" | "provider" | "feature";
  /** One feature ID: only the sessions started for that feature's tasks. */
  feature?: string;
  sort?: "newest" | "oldest" | "title";
  pageSize?: number;
  cursor?: string;
  revision?: string | number;
};

/**
 * The task a session was started for, joined from the task store when a directory page is served to a
 * same-computer client. Never task text, a condition, a column, a report, or an issue title or body; never stored in the
 * session catalog.
 */
export type SessionTaskReference = {
  /** "T-<n>", unique inside `repositoryId`. */
  id: string;
  /** The repository whose board holds the task. A task worktree gives the session itself another repository ID. */
  repositoryId: string;
  /** An outcome the session's own state cannot show, else null. */
  state: "needs_review" | "stalled" | "blocked" | "done" | null;
  featureId: string | null;
  /** The feature's name. */
  feature: string | null;
  step: number | null;
  /**
   * The number (1 to 999999999) of the GitHub issue the task was promoted from, or null. The monitor always sends it;
   * it is optional here because the session view's own reader keeps only the fields it uses.
   */
  issue?: number | null;
};

/**
 * Whether directory rows carry `task`. `desktop_only`: this client is not on the same computer and gets no task
 * reference. `unavailable`: the task store could not be read. Rows have no `task` key unless it is `ready`.
 */
export type SessionDirectoryTaskReadiness = "ready" | "desktop_only" | "unavailable";

/** A directory row: the catalog summary, plus the task reference when the page was served with `taskReadiness: "ready"`. */
export type WithSessionTask<Row> = Row & { task?: SessionTaskReference | null };

/** What a directory page adds to the catalog snapshot for tasks. */
export type SessionDirectoryTaskFields<Row> = {
  sessions: WithSessionTask<Row>[];
  taskReadiness?: SessionDirectoryTaskReadiness;
  /** Present under a feature scope: the feature, or null when the ID names none. */
  feature?: { id: string; name: string } | null;
};

/** One project, provider or feature group of a grouped directory response: scoped tallies and its newest-created rows. */
export type SessionDirectoryGroup<Row> = {
  /** The project name, the normalized provider ID, or the feature ID; passed back as the `project`, `provider` or `feature` scope. */
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
  groupBy?: "project" | "provider" | "feature";
  /** A bounded list ordered by each group's newest-created session; `groupCount` may exceed it. */
  groups?: SessionDirectoryGroup<Row>[];
  groupCount?: number;
};
