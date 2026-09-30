export function webRuntimeOptions(environment = process.env) {
  return {
    host: environment.POMEGR_WEB_HOST || "127.0.0.1",
    port: environment.POMEGR_WEB_PORT === undefined ? 3003 : Number(environment.POMEGR_WEB_PORT),
    monitorOrigin: environment.POMEGR_MONITOR_ORIGIN || "http://127.0.0.1:4317",
  };
}
