import { claudeProvider } from "./claude.mjs";
import { createProviderRegistry } from "./registry.mjs";

// TL-CX-05 establishes multi-provider orchestration. Codex is registered only
// after its catalog adapter is implemented in TL-CX-06.
export const providerRegistry = createProviderRegistry([claudeProvider]);

