import { fileURLToPath } from "node:url";

import { runCodexLifecycleBridge } from "./codex-lifecycle-bridge-core.mjs";

await runCodexLifecycleBridge({
  // This path is calculated by packaged source, never accepted from hook JSON.
  ownerWatcherPath: fileURLToPath(new URL("./codex-lifecycle-owner.bundle.mjs", import.meta.url)),
});
