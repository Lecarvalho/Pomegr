export type ContextInventoryReference = {
  repositoryId: string;
  provider: "claude" | "codex";
  revisionId: string;
  capturedAt: string;
  model: string;
  machineryTokens: number;
  categoryCount: number;
  itemCount: number;
  detailRetained: boolean;
};

export type ContextInventoryRevisionSummary = Omit<ContextInventoryReference, "repositoryId" | "provider" | "revisionId" | "detailRetained"> & {
  id: string;
  change: { state: "first_capture" | "unchanged" | "changed"; previousRevisionId: string | null };
};

export type ContextInventoryRevisionDetail = ContextInventoryRevisionSummary & {
  repositoryId: string;
  provider: "claude" | "codex";
  categories: Array<{ name: string; tokens: string; percentage: number }>;
  groups: Array<{
    id: string;
    label: string;
    items: Array<{ name: string; detail: string; tokens: string }>;
  }>;
};

export type RepositoryProviderInventory = {
  provider: "claude" | "codex";
  source: "Claude Code" | "Codex";
  sessionCount: number;
  supported: boolean;
  status: "not_captured" | "capturing" | "current" | "failed" | "unavailable";
  failureKind: "executable_unavailable" | "timed_out" | "invalid_output" | "runtime_unavailable" | null;
  currentRevision: ContextInventoryRevisionSummary | null;
  revisions: ContextInventoryRevisionSummary[];
};

export type RepositorySummary = {
  id: string;
  name: string;
  displayName: string;
  sessionCount: number;
  liveCount: number;
  historyCount: number;
  providerCount: number;
  updatedAt: string | null;
  providers: RepositoryProviderInventory[];
};

export type RepositoryInventorySnapshot = {
  revision: number | string | null;
  readiness: "loading" | "ready" | "unavailable";
  repositories: RepositorySummary[];
};
