import { claudeProvider, createClaudeProvider } from "./claude.mjs";
import { createCodexProvider } from "./codex.mjs";
import { createCodexAppServerRateLimitsReader } from "./codex-app-server-client.mjs";
import { createProviderRegistry } from "./registry.mjs";

function defaultCodexOptions(options = {}) {
  const codexOptions = { ...(options.codexOptions || {}) };
  if (!codexOptions.rateLimitsReader) {
    codexOptions.rateLimitsReader = options.codexRateLimitsReader
      || createCodexAppServerRateLimitsReader({
        env: codexOptions.env || options.env,
      });
  }
  return codexOptions;
}

export function createDefaultProviderRegistry(options = {}) {
  return createProviderRegistry([
    createClaudeProvider(options.claudeOptions || {}),
    createCodexProvider(defaultCodexOptions(options)),
  ]);
}

export const providerRegistry = createProviderRegistry([
  claudeProvider,
  createCodexProvider(defaultCodexOptions()),
]);
