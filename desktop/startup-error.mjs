export const DESKTOP_STARTUP_ERROR_CODE = "DESKTOP_START_FAILED";

export function startupErrorDocument() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Threadlight</title><style>body{margin:0;background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{max-width:34rem;padding:2rem}h1{font-size:1.25rem}p{color:#bbb;line-height:1.5}</style></head><body><main><h1>Threadlight could not start</h1><p>The local services did not become ready. Close Threadlight and try again.</p><p>Error code: ${DESKTOP_STARTUP_ERROR_CODE}</p></main></body></html>`;
}
