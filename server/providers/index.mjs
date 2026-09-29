import { claudeProvider, createClaudeProvider } from "./claude/index.mjs";
import { createCodexProvider } from "./codex/index.mjs";
import { createCodexAppServerRateLimitsReader } from "./codex/app-server-client.mjs";
import { createProviderRegistry } from "./registry.mjs";
import { readProviderServiceStatus } from "./kernel/provider-service-status.mjs";

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
  ], { serviceStatusReader: options.serviceStatusReader || readProviderServiceStatus });
}

export const providerRegistry = createProviderRegistry([
  claudeProvider,
  createCodexProvider(defaultCodexOptions()),
], { serviceStatusReader: readProviderServiceStatus });
