import { createHomeReadiness } from "./observation-readiness.mjs";
import { createEmptyProviderStatusSnapshot } from "../shared/provider-status.mjs";
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
    if (requestUrl.pathname === "/api/events") {
      if (request.method !== "GET" || typeof runtime.subscribeRevisionEvents !== "function") {
        response.writeHead(request.method === "GET" ? 503 : 405, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(request.method === "GET" ? "Revision events unavailable" : "Method not allowed");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders?.();
      let closed = false;
      let unsubscribe = null;
      const writeRevision = (event) => {
        if (closed || event?.domain !== "sessions"
          || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
        try {
          response.write(`event: catalog\ndata: ${JSON.stringify({ domain: "sessions", revision: event.revision })}\n\n`);
        } catch { close(); }
      };
      const heartbeat = setInterval(() => {
        if (!closed) response.write(": keep-alive\n\n");
      }, 15_000);
      heartbeat.unref?.();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try { unsubscribe?.(); } catch { /* connection cleanup remains best-effort */ }
        unsubscribe = null;
      };
      response.once("close", close);
      response.once("error", close);
      request.once("aborted", close);
      try {
        const subscription = runtime.subscribeRevisionEvents(writeRevision);
        if (closed) subscription();
        else unsubscribe = subscription;
      } catch {
        close();
        response.end();
      }
      return;
    }
    if (requestUrl.pathname === "/api/sessions") {
      try {
        if (runtime.observationActive?.()) {
          writeCommitted(runtime.serveCatalog(requestedRevision), {
            revision: 0,
            readiness: { catalog: "loading" },
            sessions: [],
          });
          return;
        }
        const body = JSON.stringify(await runtime.sessionFeed());
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(body);
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ sessions: [], error: "Session catalog error" }));
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
    if (requestUrl.pathname === "/api/provider-status") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      try {
        writeCommitted(runtime.serveProviderStatus?.(requestedRevision), createEmptyProviderStatusSnapshot());
      } catch {
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(createEmptyProviderStatusSnapshot("unavailable")));
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
    if (requestUrl.pathname === "/api/agents") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      const project = requestUrl.searchParams.get("project") || "all";
      const days = requestUrl.searchParams.get("days") || "30";
      const scope = requestUrl.searchParams.get("scope") || "all";
      if (project.length > 512 || /[\u0000-\u001f\u007f]/.test(project) || !["7", "30", "90"].includes(days) || !["all", "main", "delegated"].includes(scope)) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Invalid agents filters" }));
        return;
      }
      try {
        const result = runtime.serveAgents?.({ project, days: Number(days), scope }, requestedRevision);
        if (result?.status === "invalid") {
          response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Agents filters unavailable" }));
          return;
        }
        writeCommitted(result, {
          revision: 0,
          readiness: "loading",
          generatedAt: null,
          coverage: { retainedSessions: 0, eligibleSessions: 0, missingSessions: 0, retainedRuns: 0, truncated: false, earliestStartedAt: null },
          filters: { project, days: Number(days), scope, projects: [] },
          summary: { runCount: 0, sessionCount: 0, modelCount: 0, mainRunCount: 0, delegatedRunCount: 0 },
          models: [], work: [], runs: [], roster: [],
        });
      } catch {
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Agents analytics unavailable" }));
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
