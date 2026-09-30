import { startWebServer } from "./server.mjs";
import { webRuntimeOptions } from "./runtime-options.mjs";

let handle;
try {
  handle = await startWebServer({
    ...webRuntimeOptions(),
    logger: console,
  });
} catch (error) {
  console.error(`[pomegr] ${error?.code || "WEB_START_FAILED"}`);
  process.exitCode = 1;
}

if (handle) {
  const close = () => { void handle.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const result = await handle.exit;
  if (result.code === "WEB_EXIT_UNEXPECTED") process.exitCode = 1;
}
