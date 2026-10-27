// Public, bounded notification data.
export type NotificationKind = "needs_input" | "provider_incident" | "provider_recovery" | "monitor_unreachable" | "usage_window_reset" | "usage_capacity_restored" | "usage_reset_available" | "usage_authentication_required" | "release_published" | "installation_update_available" | "model_announced" | "model_deprecated" | "model_client_listed" | "aril_follow_up";
export type NotificationCategory = "attention" | "provider_service" | "system" | "usage" | "provider_news" | "model_news" | "aril";
export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationAction = "open_session" | "open_sessions" | "open_providers" | "open_workspace" | "open_usage_limits" | "open_aril_chat";
export type NotificationSourceReadiness = "loading" | "ready" | "partial" | "stale" | "unavailable";
export type NotificationTimeBasis = "recorded" | "observed";

export type NotificationBase = {
  // Opaque digest; never a provider or session identifier.
  id: string;
  kind: NotificationKind;
  category: NotificationCategory;
  severity: NotificationSeverity;
  lifecycle: "active" | "resolved";
  priority: number;
  occurredAt: string;
  timeBasis: NotificationTimeBasis;
  deliveryEligible: boolean;
  action: NotificationAction;
};

export type NotificationRecord =
  | (NotificationBase & { kind: "model_announced" | "model_deprecated" | "model_client_listed"; provider: "claude" | "codex"; data: {
    modelId: string; label: string; evidence: "official_announcement" | "client_catalog";
  } })
  | (NotificationBase & { kind: "release_published" | "installation_update_available"; provider: "claude" | "codex" | null; data: {
    product: "claude_code" | "codex_cli" | "pomegr_plugin"; version: string; channel: "latest" | "main"; affectedRepositories?: number; excerpt?: string;
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
  | (NotificationBase & { kind: "monitor_unreachable"; provider: null; data: Record<string, never> })
  // A grant follow-up: its repository, the chat message it opens (null when none was written), and fixed task-log facts.
  | (NotificationBase & { kind: "aril_follow_up"; provider: null; data: {
    repositoryId: string; conversationId: string | null; messageId: string | null;
    items: { kind: string; task: string | null; provider: "claude" | "codex" | null }[]; more: number;
    ended: "stopped" | "expired" | "tasks_used" | "start_failed" | "app_restart" | null;
  } });

// Revision changes only after an accepted, material state transition.
export type NotificationSnapshot = {
  version: 1;
  revision: number;
  generatedAt: string | null;
  readiness: { catalog: NotificationSourceReadiness; providerStatus: NotificationSourceReadiness };
  occurrences: NotificationRecord[];
  activeSessionOverflow: number;
};
