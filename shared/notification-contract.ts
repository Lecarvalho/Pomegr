/** Public, bounded notification data. Upstream payloads and source scopes stay private. */
export type NotificationKind = "needs_input" | "provider_incident" | "provider_recovery" | "monitor_unreachable" | "usage_window_reset" | "usage_capacity_restored" | "usage_reset_available" | "usage_authentication_required" | "release_published" | "installation_update_available";
export type NotificationCategory = "attention" | "provider_service" | "system" | "usage" | "provider_news";
export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationAction = "open_session" | "open_sessions" | "open_providers" | "open_workspace" | "open_usage_limits";
export type NotificationSourceReadiness = "loading" | "ready" | "partial" | "stale" | "unavailable";
export type NotificationTimeBasis = "recorded" | "observed";

export type NotificationBase = {
  /** Opaque digest; never a provider or session identifier. */
  id: string;
  kind: NotificationKind;
  category: NotificationCategory;
  severity: NotificationSeverity;
  lifecycle: "active" | "resolved";
  priority: number;
  occurredAt: string;
  timeBasis: NotificationTimeBasis;
  /** False for an existing condition seen at the producer's startup baseline. */
  deliveryEligible: boolean;
  action: NotificationAction;
};

export type NotificationRecord =
  | (NotificationBase & { kind: "release_published" | "installation_update_available"; provider: "claude" | "codex" | null; data: {
    product: "claude_code" | "codex_cli" | "pomegr_plugin"; version: string; channel: "latest" | "main"; affectedRepositories?: number;
  } })
  | (NotificationBase & { kind: "usage_authentication_required"; provider: "claude" | "codex"; data: Record<string, never> })
  | (NotificationBase & { kind: "usage_window_reset" | "usage_capacity_restored"; provider: "claude" | "codex"; data: {
    window: "five_hour" | "weekly" | "model_weekly" | "primary" | "secondary";
    origin: "local_observation" | "provider_api"; otherExhausted: boolean;
  } })
  | (NotificationBase & { kind: "usage_reset_available"; provider: "codex"; data: { availableCount: number } })
  | (NotificationBase & { kind: "needs_input"; provider: "claude" | "codex"; data: { sessionId: string; sessionTitle: string } })
  | (NotificationBase & { kind: "provider_incident"; provider: "claude" | "codex"; data: { status: "degraded" | "outage" | "maintenance" } })
  | (NotificationBase & { kind: "provider_recovery"; provider: "claude" | "codex"; data: { status: "operational" } })
  | (NotificationBase & { kind: "monitor_unreachable"; provider: null; data: Record<string, never> });

/** Revision changes only after an accepted, material state transition. */
export type NotificationSnapshot = {
  version: 1;
  revision: number;
  generatedAt: string | null;
  readiness: { catalog: NotificationSourceReadiness; providerStatus: NotificationSourceReadiness };
  occurrences: NotificationRecord[];
  activeSessionOverflow: number;
};
