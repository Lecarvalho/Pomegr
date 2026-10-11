import type { ProviderSource } from "../../shared/monitor-contract";

/** Names the provider in words only. */
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
