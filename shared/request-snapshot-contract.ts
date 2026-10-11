// Normalized cache lifetime; 30m+ is a documented model-policy minimum, not a recorded expiry.
export type CacheLifetime = "5m" | "1h" | "mixed" | "30m+";

// Bounded monitor-derived purpose.
export type WorkKind = "shell" | "search" | "read" | "write" | "test" | "build" | "git" | "git_push" | "pull_request" | "process" | "web" | "image" | "input" | "transfer" | "skill" | "report" | "agent" | "integration" | "wait" | "reply" | "plan" | "other";

export type RequestSnapshot = {
  id: string;
  agentId: string;
  observedAt: string;
  cacheLifetime: CacheLifetime | null;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  // Bounded work-kind tallies.
  precedingWork: Array<{ kind: WorkKind; count: number }>;
  precedingAssociation: "transcript_adjacency" | null;
  issuedWork: Array<{ kind: WorkKind; count: number }>;
  issuedAssociation: "recorded_link" | null;
};

export type RequestSnapshotFeed = {
  status: "ready" | "unavailable";
  items: RequestSnapshot[];
};

export type SessionReportRequestSnapshot = Omit<RequestSnapshot,
  "precedingWork" | "precedingAssociation" | "issuedWork" | "issuedAssociation">;
