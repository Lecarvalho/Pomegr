import { startMonitorServer } from "./server.mjs";

let handle;
try {
  handle = await startMonitorServer({ logger: console });
} catch (error) {
  console.error(`[threadlight] ${error?.code || "MONITOR_START_FAILED"}`);
  process.exitCode = 1;
}

if (handle) {
  const close = () => { void handle.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const result = await handle.exit;
  if (result.code === "MONITOR_EXIT_UNEXPECTED") process.exitCode = 1;
}
