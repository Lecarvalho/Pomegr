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
  sort?: "newest" | "oldest" | "title";
  pageSize?: number;
  cursor?: string;
  revision?: string | number;
};
