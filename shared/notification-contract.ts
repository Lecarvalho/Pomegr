/** Public, bounded notification data. Upstream payloads and source scopes stay private. */
export type NotificationKind = "needs_input" | "provider_incident" | "provider_recovery" | "monitor_unreachable";
export type NotificationCategory = "attention" | "provider_service" | "system";
export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationAction = "open_session" | "open_sessions" | "open_providers" | "open_workspace";
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
