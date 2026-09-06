/** Current local setup only. Never substitutes for session-observed plugin metadata. */
export type RepositoryPluginSetup = {
  readiness: "loading" | "ready" | "unavailable";
  installation: "installed" | "not_installed" | "unknown";
  version: string | null;
  enabled: boolean | null;
  scope: "user" | "project" | "local" | null;
  checkedAt: string | null;
  update: {
    status: "current" | "available" | "pinned" | "unavailable" | "unknown";
    version: string | null;
    checkedAt: string | null;
  };
  canInstall: boolean;
  canUpdate: boolean;
};

export type RepositoryReportingSetup = {
  status: "configured" | "missing" | "invalid" | "unknown";
  version: number | null;
  checkedAt: string | null;
};

export type RepositoryPluginAction = "recheck" | "install" | "update";
export type RepositoryPluginActionStatus = "completed" | "cancelled" | "busy" | "unavailable" | "timed_out" | "failed" | "changed";
