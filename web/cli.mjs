import { startWebServer } from "./server.mjs";

const port = process.env.THREADLIGHT_WEB_PORT === undefined
  ? 3003
  : Number(process.env.THREADLIGHT_WEB_PORT);

let handle;
try {
  handle = await startWebServer({
    host: process.env.THREADLIGHT_WEB_HOST || "127.0.0.1",
    port,
    monitorOrigin: process.env.THREADLIGHT_MONITOR_ORIGIN || "http://127.0.0.1:4317",
    logger: console,
  });
} catch (error) {
  console.error(`[threadlight] ${error?.code || "WEB_START_FAILED"}`);
  process.exitCode = 1;
}

if (handle) {
  const close = () => { void handle.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const result = await handle.exit;
  if (result.code === "WEB_EXIT_UNEXPECTED") process.exitCode = 1;
}
