import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CACHE_LIFETIME_INFERENCE_SIGNAL_DEFINITIONS,
  CACHE_MESSAGE_CHANGE_SIGNAL_DEFINITIONS,
  CACHE_REFILL_PROVIDER_STATUS_SIGNAL_DEFINITIONS,
  CACHE_REFILL_REASON_SIGNAL_DEFINITIONS,
  CACHE_TOOL_CHANGE_SIGNAL_DEFINITIONS,
  cacheRefillSignalDefinition,
} from "../../shared/signal-dictionary";

describe("signal dictionary", () => {
  it("keeps the public cache sequence code and document anchor aligned", () => {
    const document = fs.readFileSync(path.join(process.cwd(), "docs", "SIGNAL_DICTIONARY.md"), "utf8");
    const definitions = [
      CACHE_REFILL_REASON_SIGNAL_DEFINITIONS.model_changed,
      CACHE_REFILL_REASON_SIGNAL_DEFINITIONS.system_changed,
      CACHE_REFILL_REASON_SIGNAL_DEFINITIONS.messages_changed!,
      CACHE_REFILL_REASON_SIGNAL_DEFINITIONS.tools_changed!,
      CACHE_REFILL_PROVIDER_STATUS_SIGNAL_DEFINITIONS.previous_cache_entry_unavailable,
      CACHE_LIFETIME_INFERENCE_SIGNAL_DEFINITIONS.cache_lifetime_elapsed,
      CACHE_TOOL_CHANGE_SIGNAL_DEFINITIONS.remote_control_connected,
      CACHE_MESSAGE_CHANGE_SIGNAL_DEFINITIONS.post_tool_task_notification_resume,
    ];

    for (const definition of definitions) {
      expect(definition.href).toBe(`https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md#${definition.anchor}`);
      expect(definition.href).not.toContain("?");
      expect(document).toContain(`<a id="${definition.anchor}"></a>`);
      expect(document).toContain(`### \`${definition.code}\``);
    }
  });

  it("selects the strongest supported definition without inventing an attribution", () => {
    const occurrence = {
      observedAt: "2026-08-15T12:01:00.000Z",
      providerStatus: null,
      cacheLifetimeInference: null,
      messageChangeSequence: null,
      toolChangeAttribution: null,
      reason: "tools_changed" as const,
    };

    expect(cacheRefillSignalDefinition(occurrence)?.code).toBe("cache.tools_changed");
    expect(cacheRefillSignalDefinition({
      ...occurrence,
      toolChangeAttribution: { cause: "remote_control_connected", changes: [] },
    })?.code).toBe("cache.tools_changed.remote_control_connected");
    expect(cacheRefillSignalDefinition({
      ...occurrence,
      reason: "messages_changed",
      messageChangeSequence: "post_tool_task_notification_resume",
    })?.code).toBe("cache.messages_changed.post_tool_notification_resume");
    expect(cacheRefillSignalDefinition({
      ...occurrence,
      reason: null,
      providerStatus: "previous_cache_entry_unavailable",
    })?.code).toBe("cache.previous_cache_entry_unavailable");
    expect(cacheRefillSignalDefinition({
      ...occurrence,
      reason: null,
      cacheLifetimeInference: { cause: "cache_lifetime_elapsed", cacheLifetime: "1h", elapsedMs: 61 * 60_000 },
    })?.code).toBe("cache.lifetime_elapsed");
  });
});
