import { existsSync } from "node:fs";

import { createNativeSignInAction } from "./claude-auth.mjs";
import { nativeCodexEnvironment } from "./environment-policy.mjs";
import { resolveCodexExecutable } from "./plugin-cli.mjs";

export const CODEX_SIGN_IN_CHANNEL = "pomegr:start-codex-sign-in";

export function createCodexSignInAction(options = {}) {
  const environment = Object.freeze(nativeCodexEnvironment(options.environment || process.env));
  return createNativeSignInAction({
    ...options,
    resolveExecutable: () => resolveCodexExecutable(environment, options.fileExists || existsSync, options),
    nativeEnvironment: environment,
    arguments: ["login"],
  });
}
