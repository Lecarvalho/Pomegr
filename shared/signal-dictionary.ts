import type { CacheLifetimeInference, CacheMessageChangeSequence, CacheRefillOccurrence, CacheRefillProviderStatus, CacheRefillReason } from "./monitor-contract";

export const SIGNAL_DICTIONARY_DOCUMENT_URL = "https://github.com/Lecarvalho/pomegr/blob/main/docs/internal/architecture/signal-dictionary.md";

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

/** A recognized provider reason on a rewrite that still read part of the prefix from cache. */
export const CACHE_PROVIDER_DIAGNOSED_REFILL_SIGNAL_DEFINITION: CacheSignalDefinition = {
  code: "cache.provider_diagnosed_refill",
  anchor: "cache-provider-diagnosed-refill",
  href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#cache-provider-diagnosed-refill`,
  observed: "The provider named this reason for the rewrite.",
  impact: "Part of the prefix was reused; counted separately.",
};

/** An elapsed-lifetime inference on a rewrite that still read part of the prefix from cache. */
export const CACHE_LIFETIME_ELAPSED_PARTIAL_REFILL_SIGNAL_DEFINITION: CacheSignalDefinition = {
  code: "cache.lifetime_elapsed_partial_refill",
  anchor: "cache-lifetime-elapsed-partial-refill",
  href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#cache-lifetime-elapsed-partial-refill`,
  observed: "Pomegr found that the preceding request's resolved cache-lifetime threshold had elapsed.",
  impact: "Part of the prefix was reused; counted separately.",
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
  deferred_definitions_loaded: definition(
    "cache.tools_changed.deferred_definitions_loaded",
    "cache-tools-changed-deferred-definitions-loaded",
    "Claude reported changed tool definitions, and Pomegr saw new tool definitions recorded after a tool search.",
  ),
} as const;

export const DEFERRED_DEFINITION_COUNT_CAP = 64;

/** The bounded added-definition count of a deferred-definitions attribution, or null when missing or out of range. */
export function deferredDefinitionCount(attribution: { addedDefinitionCount?: unknown } | null | undefined) {
  const count = attribution?.addedDefinitionCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && count <= DEFERRED_DEFINITION_COUNT_CAP ? count : null;
}

export const CACHE_MESSAGE_CHANGE_SIGNAL_DEFINITIONS: Record<CacheMessageChangeSequence, CacheSignalDefinition> = {
  post_tool_task_notification_resume: {
    code: "cache.messages_changed.post_tool_notification_resume",
    anchor: "cache-messages-changed-post-tool-notification-resume",
    href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#cache-messages-changed-post-tool-notification-resume`,
    observed: "Tool use and its result were followed by a provider task notification and the directly resumed request.",
    impact: "The request also met Pomegr's possible full-refill thresholds.",
  },
};

export function cacheReadReuseDroppedSignalDefinition(): CacheSignalDefinition {
  return {
    code: "cache.read_reuse_dropped",
    anchor: "cache-read-reuse-dropped",
    href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#cache-read-reuse-dropped`,
    observed: "Pomegr observed a comparable cache-read share drop.",
    impact: "No positive cache-write evidence was recorded.",
  };
}

export function cacheReadReuseDroppedModelChangeSignalDefinition(): CacheSignalDefinition {
  return {
    code: "cache.read_reuse_dropped.model_change",
    anchor: "cache-read-reuse-dropped-model-change",
    href: `${SIGNAL_DICTIONARY_DOCUMENT_URL}#cache-read-reuse-dropped-model-change`,
    observed: "Cache reuse dropped across a model change.",
    impact: "A refill and its cause cannot be confirmed.",
  };
}

export function cacheRefillSignalDefinition(occurrence: Pick<CacheRefillOccurrence, "cacheLifetimeInference" | "kind" | "messageChangeSequence" | "providerStatus" | "reason" | "toolChangeAttribution">) {
  if (occurrence.kind === "provider_diagnosed") return CACHE_PROVIDER_DIAGNOSED_REFILL_SIGNAL_DEFINITION;
  if (occurrence.kind === "lifetime_elapsed") return occurrence.cacheLifetimeInference ? CACHE_LIFETIME_ELAPSED_PARTIAL_REFILL_SIGNAL_DEFINITION : null;
  if (occurrence.messageChangeSequence) return CACHE_MESSAGE_CHANGE_SIGNAL_DEFINITIONS[occurrence.messageChangeSequence];
  const toolChange = occurrence.reason === "tools_changed" ? occurrence.toolChangeAttribution : null;
  if (toolChange?.cause === "remote_control_connected") return CACHE_TOOL_CHANGE_SIGNAL_DEFINITIONS.remote_control_connected;
  if (toolChange?.cause === "deferred_definitions_loaded" && deferredDefinitionCount(toolChange) !== null) {
    return CACHE_TOOL_CHANGE_SIGNAL_DEFINITIONS.deferred_definitions_loaded;
  }
  if (occurrence.reason) return CACHE_REFILL_REASON_SIGNAL_DEFINITIONS[occurrence.reason] || null;
  if (occurrence.providerStatus) return CACHE_REFILL_PROVIDER_STATUS_SIGNAL_DEFINITIONS[occurrence.providerStatus] || null;
  return occurrence.cacheLifetimeInference
    ? CACHE_LIFETIME_INFERENCE_SIGNAL_DEFINITIONS[occurrence.cacheLifetimeInference.cause] || null
    : null;
}
