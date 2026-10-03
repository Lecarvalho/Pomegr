import { claudeProvider, createClaudeProvider } from "./claude/index.mjs";
import { createCodexProvider, resolveCodexHome } from "./codex/index.mjs";
import { createCodexAppServerRateLimitsReader } from "./codex/app-server-client.mjs";
import { createProviderRegistry } from "./registry.mjs";
import { readProviderServiceStatus } from "./kernel/provider-service-status.mjs";
import { createClaudeCodeReleaseReader } from "./claude/release-observation.mjs";
import { createCodexCliReleaseReader } from "./codex/release-observation.mjs";
import { createCodexModelObservation, createOpenAIModelAnnouncementReader, codexModelSourceScope } from "./codex/model-observation.mjs";
import { createCodexAppServerModelCatalogReader } from "./codex/app-server-client.mjs";
import { codexUsageSourceScope } from "./codex/usage-limits.mjs";
import { CLAUDE_MODEL_SOURCE_CAPABILITIES } from "./claude/model-observation.mjs";
import { CODEX_MODEL_SOURCE_CAPABILITIES } from "./codex/model-observation.mjs";
import path from "node:path";

/** Public adapter seam for bounded official release publication reads. */
export function createOfficialProviderReleaseReaders(options = {}) {
  return Object.freeze([createClaudeCodeReleaseReader(options), createCodexCliReleaseReader(options)]);
}

/** Read-only model sources use the effective profile; stat identities never leave the adapter seam. */
export function createProviderModelReaders(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome(options);
  const environment = { ...(options.env || process.env), CODEX_HOME: codexHome };
  const sourceScope = () => {
    const auth = codexUsageSourceScope(path.join(codexHome, "auth.json"));
    const config = codexUsageSourceScope(path.join(codexHome, "config.toml"));
    return auth ? codexModelSourceScope(`${codexHome}\0${auth}\0${config || "absent"}`) : null;
  };
  const catalog = createCodexModelObservation({ ...options, sourceScope,
    catalogReader: options.catalogReader || createCodexAppServerModelCatalogReader({ ...options, env: environment }) });
  const announcement = createOpenAIModelAnnouncementReader(options);
  const wrap = (reader) => Object.assign(() => reader.read(), { stop: () => reader.stop() });
  return Object.freeze({ catalogs: Object.freeze([wrap(catalog)]), announcements: Object.freeze([wrap(announcement)]) });
}

export const PROVIDER_MODEL_SOURCE_CAPABILITIES = Object.freeze({
  claude: CLAUDE_MODEL_SOURCE_CAPABILITIES, codex: CODEX_MODEL_SOURCE_CAPABILITIES,
});

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
