import { createHomeReadiness } from "./observation-readiness.mjs";
import { requestHasDesktopAuthorization, requireDesktopToken } from "../shared/local-auth.mjs";

/** Create the loopback monitor's HTTP serving boundary around a prepared runtime. */
export function createRequestHandler({ runtime, authorizationToken: rawAuthorizationToken = "" } = {}) {
  if (!runtime) throw new TypeError("Monitor request handler requires a runtime");
  const authorizationToken = rawAuthorizationToken
    ? requireDesktopToken(rawAuthorizationToken, "MONITOR_INVALID_AUTHORIZATION")
    : "";
  return async (request, response) => {
    const localAddress = request.socket?.localAddress;
    const localPort = request.socket?.localPort;
    const expectedHost = localAddress && localPort ? `${localAddress}:${localPort}` : "";
    const desktopRequestAllowed = !authorizationToken || (
      ["GET", "HEAD"].includes(request.method || "")
      && request.headers.host === expectedHost
      && request.headers.origin === undefined
      && requestHasDesktopAuthorization(request, authorizationToken)
    );
    if (!desktopRequestAllowed) {
      response.writeHead(401, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Unauthorized");
      return;
    }
    if (!authorizationToken) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const requestedRevisionValue = requestUrl.searchParams.get("revision");
    const requestedRevision = /^\d+$/u.test(requestedRevisionValue || "") ? Number(requestedRevisionValue) : null;
    const writeCommitted = (result, fallbackValue) => {
      if (result?.status === "unchanged") {
        response.writeHead(204);
        response.end();
        return;
      }
      const snapshot = result?.snapshot;
      const serialized = snapshot?.serialized || snapshot?.serializedState || JSON.stringify(fallbackValue);
      const revision = snapshot?.revision;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        ...(Number.isSafeInteger(revision) ? { "X-Pomegr-Revision": String(revision) } : {}),
      });
      response.end(serialized);
    };
    if (requestUrl.pathname === "/api/sessions") {
      try {
        if (runtime.observationActive?.()) {
          writeCommitted(runtime.serveCatalog(requestedRevision), {
            revision: 0,
            readiness: { catalog: "loading", sessionSummaries: {} },
            sessions: [],
            liveSessions: [],
          });
          return;
        }
        const body = JSON.stringify(await runtime.sessionFeed());
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(body);
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ sessions: [], liveSessions: [], error: "Session catalog error" }));
      }
      return;
    }
    if (requestUrl.pathname === "/api/home") {
      try {
        if (runtime.observationActive?.()) {
          writeCommitted(runtime.serveHome(requestedRevision), {
            revision: 0,
            generatedAt: null,
            providerLimits: [],
            limitActivities: [],
            projects: [],
            readiness: createHomeReadiness(),
          });
          return;
        }
        const snapshot = await runtime.homeSnapshot();
        const body = JSON.stringify(requestUrl.searchParams.get("scope") === "aggregates"
          ? {
            generatedAt: snapshot.generatedAt,
            providerLimits: snapshot.providerLimits,
            limitActivities: snapshot.limitActivities,
            ...(snapshot.error ? { error: snapshot.error } : {}),
          }
          : snapshot);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(body);
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(requestUrl.searchParams.get("scope") === "aggregates"
          ? { generatedAt: null, providerLimits: [], limitActivities: [], error: "Home snapshot error" }
          : { generatedAt: null, providerLimits: [], limitActivities: [], projects: [], error: "Home snapshot error" }));
      }
      return;
    }
    if (requestUrl.pathname === "/api/usage-limits") {
      try {
        if (runtime.observationActive?.()) {
          writeCommitted(runtime.serveUsageLimits(requestedRevision), {
            revision: 0,
            readiness: {},
            providers: [],
          });
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ revision: 0, readiness: {}, providers: [] }));
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ revision: 0, readiness: {}, providers: [] }));
      }
      return;
    }
    if (requestUrl.pathname === "/api/transcript-path") {
      if (request.method !== "GET" || request.headers.origin !== undefined) {
        response.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Transcript path request denied." }));
        return;
      }
      const sessionId = requestUrl.searchParams.get("sessionId") || "";
      const agentId = requestUrl.searchParams.get("agentId") || "";
      if (!sessionId || !agentId || sessionId.length > 256 || agentId.length > 256) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "A valid session and agent are required." }));
        return;
      }
      try {
        const transcriptPath = await runtime.transcriptPath(sessionId, agentId);
        if (!transcriptPath) {
          response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Transcript path unavailable." }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ path: transcriptPath }));
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Transcript path unavailable." }));
      }
      return;
    }
    if (requestUrl.pathname === "/api/state") {
      try {
        const sessionId = requestUrl.searchParams.get("sessionId") || "";
        if (runtime.observationActive?.()) {
          const result = runtime.serveSession(sessionId, requestedRevision);
          writeCommitted(result, result.loadingState || runtime.analyzeEmpty());
          return;
        }
        const body = JSON.stringify(await runtime.analyze(sessionId));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(body);
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ...runtime.analyzeEmpty(), error: "Monitor error" }));
      }
      return;
    }
    if (requestUrl.pathname === "/health") { response.writeHead(204); response.end(); return; }
    response.writeHead(404); response.end("Not found");
  };
}
