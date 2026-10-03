/** Cache-only notification GET. The owning runtime has already committed and serialized the value. */
export function serveNotificationRoute({ request, response, runtime, requestedRevision, writeCommitted }) {
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }
  try {
    const result = runtime.serveNotifications?.(requestedRevision);
    if (!result?.snapshot) throw new TypeError("Notifications unavailable");
    writeCommitted(result);
  } catch {
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ version: 1, revision: 0, generatedAt: null,
      readiness: { catalog: "unavailable", providerStatus: "unavailable" },
      occurrences: [], activeSessionOverflow: 0 }));
  }
}
