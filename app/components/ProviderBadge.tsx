import type { ProviderSource } from "../../shared/monitor-contract";

/**
 * Names the provider in words only. Provider logos are third-party trademarks, so Pomegr
 * shows the product name in an outline chip, or as plain text inside headings and
 * inline metadata where a chip would compete with the surrounding type.
 */
export function ProviderBadge({ source, variant = "chip" }: { source: ProviderSource; variant?: "chip" | "text" }) {
  const isCodex = source === "Codex";
  return (
    <span
      className={variant === "chip" ? "commandChip providerBadge" : "providerBadge providerBadgeText"}
      data-provider={isCodex ? "codex" : "claude"}
      title={isCodex ? "Codex by OpenAI" : "Claude Code by Anthropic"}
    >
      {source}
    </span>
  );
}
