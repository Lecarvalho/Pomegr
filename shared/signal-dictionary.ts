import type { CacheLifetimeInference, CacheMessageChangeSequence, CacheRefillOccurrence, CacheRefillProviderStatus, CacheRefillReason } from "./monitor-contract";

export const SIGNAL_DICTIONARY_DOCUMENT_URL = "https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md";

export type CacheSignalDefinition = {
  code: string;
  anchor: string;
  href: string;
  observed: string;
  impact: string;
};

function definition(code: string, anchor: string, observed: string): CacheSignalDefinition {
  return {
    code,
    anchor,
    href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#${anchor}`,
    observed,
    impact: "The request also met Pomegr's possible full-refill thresholds.",
  };
}

export const CACHE_REFILL_REASON_SIGNAL_DEFINITIONS: Record<CacheRefillReason, CacheSignalDefinition> = {
  model_changed: definition(
    "cache.model_changed",
    "cache-model-changed",
    "Claude reported that the request's model configuration changed.",
  ),
  system_changed: definition(
    "cache.system_changed",
    "cache-system-changed",
    "Claude reported that the request's system instructions changed.",
  ),
  messages_changed: definition(
    "cache.messages_changed",
    "cache-messages-changed",
    "Claude reported that the request's message history changed.",
  ),
  tools_changed: definition(
    "cache.tools_changed",
    "cache-tools-changed",
    "Claude reported that the request's tool definitions changed.",
  ),
};

export const CACHE_REFILL_PROVIDER_STATUS_SIGNAL_DEFINITIONS: Record<CacheRefillProviderStatus, CacheSignalDefinition> = {
  previous_cache_entry_unavailable: definition(
    "cache.previous_cache_entry_unavailable",
    "cache-previous-cache-entry-unavailable",
    "Pomegr normalized Claude's diagnostic as the previous cache entry being unavailable.",
  ),
};

export const CACHE_LIFETIME_INFERENCE_SIGNAL_DEFINITIONS: Record<CacheLifetimeInference["cause"], CacheSignalDefinition> = {
  cache_lifetime_elapsed: definition(
    "cache.lifetime_elapsed",
    "cache-lifetime-elapsed",
    "Pomegr found that the preceding request's resolved cache-lifetime threshold had elapsed.",
  ),
};

export const CACHE_TOOL_CHANGE_SIGNAL_DEFINITIONS = {
  remote_control_connected: definition(
    "cache.tools_changed.remote_control_connected",
    "cache-tools-changed-remote-control-connected",
    "Claude reported changed tool definitions, and Pomegr matched the fixed Remote Control connection transition.",
  ),
} as const;

export const CACHE_MESSAGE_CHANGE_SIGNAL_DEFINITIONS: Record<CacheMessageChangeSequence, CacheSignalDefinition> = {
  post_tool_task_notification_resume: {
    code: "cache.messages_changed.post_tool_notification_resume",
    anchor: "cache-messages-changed-post-tool-notification-resume",
    href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#cache-messages-changed-post-tool-notification-resume`,
    observed: "Tool use and its result were followed by a provider task notification and the directly resumed request.",
    impact: "The request also met Pomegr's possible full-refill thresholds.",
  },
};

export function cacheRefillSignalDefinition(occurrence: Pick<CacheRefillOccurrence, "cacheLifetimeInference" | "messageChangeSequence" | "providerStatus" | "reason" | "toolChangeAttribution">) {
  if (occurrence.messageChangeSequence) return CACHE_MESSAGE_CHANGE_SIGNAL_DEFINITIONS[occurrence.messageChangeSequence];
  if (occurrence.reason === "tools_changed" && occurrence.toolChangeAttribution?.cause === "remote_control_connected") {
    return CACHE_TOOL_CHANGE_SIGNAL_DEFINITIONS.remote_control_connected;
  }
  if (occurrence.reason) return CACHE_REFILL_REASON_SIGNAL_DEFINITIONS[occurrence.reason] || null;
  if (occurrence.providerStatus) return CACHE_REFILL_PROVIDER_STATUS_SIGNAL_DEFINITIONS[occurrence.providerStatus] || null;
  return occurrence.cacheLifetimeInference
    ? CACHE_LIFETIME_INFERENCE_SIGNAL_DEFINITIONS[occurrence.cacheLifetimeInference.cause] || null
    : null;
}
