import { claudeProvider, createClaudeProvider } from "./claude.mjs";
import { codexProvider, createCodexProvider } from "./codex.mjs";
import { createProviderRegistry } from "./registry.mjs";

export function createDefaultProviderRegistry() {
  return createProviderRegistry([createClaudeProvider(), createCodexProvider()]);
}

export const providerRegistry = createProviderRegistry([claudeProvider, codexProvider]);
