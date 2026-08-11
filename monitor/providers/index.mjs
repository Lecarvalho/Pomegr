import { claudeProvider } from "./claude.mjs";
import { codexProvider } from "./codex.mjs";
import { createProviderRegistry } from "./registry.mjs";

export const providerRegistry = createProviderRegistry([claudeProvider, codexProvider]);
