import { createHomeReadiness } from "./observation-readiness.mjs";
import { createEmptyProviderStatusSnapshot } from "../shared/provider-status.mjs";
import { requestHasAgentQueryAuthorization, requestHasDesktopAuthorization, requireDesktopToken } from "../shared/local-auth.mjs";

/** Create the loopback monitor's HTTP serving boundary around a prepared runtime. */
export function createRequestHandler({ runtime, authorizationToken: rawAuthorizationToken = "", agentAuthorizationToken: rawAgentAuthorizationToken = "" } = {}) {
  if (!runtime) throw new TypeError("Monitor request handler requires a runtime");
  const authorizationToken = rawAuthorizationToken
    ? requireDesktopToken(rawAuthorizationToken, "MONITOR_INVALID_AUTHORIZATION")
    : "";
  const agentAuthorizationToken = rawAgentAuthorizationToken
    ? requireDesktopToken(rawAgentAuthorizationToken, "MONITOR_INVALID_AGENT_AUTHORIZATION")
    : "";
  return async (request, response) => {
    const localAddress = request.socket?.localAddress;
    const localPort = request.socket?.localPort;
    const expectedHost = localAddress && localPort ? `${localAddress}:${localPort}` : "";
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const isAgentQuery = requestUrl.pathname === "/api/agent/v1"
      || requestUrl.pathname.startsWith("/api/agent/v1/");
    const agentRequestAllowed = isAgentQuery
      && request.headers.host === expectedHost
      && request.headers.origin === undefined
      && (!agentAuthorizationToken || requestHasAgentQueryAuthorization(request, agentAuthorizationToken));
    if (isAgentQuery) {
      if (!agentRequestAllowed) {
        response.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unauthorized");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      const requestedRevisionValue = requestUrl.searchParams.get("revision");
      const requestedRevision = /^\d+$/u.test(requestedRevisionValue || "") ? Number(requestedRevisionValue) : null;
      const segments = requestUrl.pathname.split("/").slice(4).filter(Boolean).map((segment) => {
        try { return decodeURIComponent(segment); } catch { return ""; }
      });
      const query = requestUrl.searchParams;
      let name = segments[0] || "";
      let args = {};
      let allowedQueryKeys = new Set(["revision"]);
      if (name === "provider-health" && segments.length === 1) {
        name = "providerHealth";
        allowedQueryKeys = new Set(["provider", "revision"]);
      } else if (name === "usage-limits" && segments.length === 1) {
        name = "usageLimits";
        allowedQueryKeys = new Set(["provider", "revision"]);
      }
      else if (name === "sessions") {
        if (segments.length === 1) {
          name = "listSessions";
          allowedQueryKeys = new Set(["provider", "scope", "limit", "revision"]);
          args = { provider: query.get("provider") || null, scope: query.get("scope") || "live", limit: Number(query.get("limit") || 20) };
        } else if (segments[2] === "agents" && segments.length === 3) {
          name = "listSessionAgents";
          args = { sessionRef: segments[1] };
        } else if (segments[2] === "agents" && segments[4] === "context" && segments.length === 5) {
          name = "getAgentContext";
          args = { sessionRef: segments[1], agentId: segments[3] };
        } else if (segments[2] === "failures" && segments.length === 3) {
          name = "getRecentFailures";
          allowedQueryKeys = new Set(["agent_id", "within_minutes", "limit", "revision"]);
          args = { sessionRef: segments[1], agentId: query.get("agent_id") || null, withinMinutes: Number(query.get("within_minutes") || 15), limit: Number(query.get("limit") || 10) };
        } else name = "";
      } else name = "";
      if (name === "providerHealth" && query.get("provider")) args = { provider: query.get("provider") };
      if (name === "usageLimits" && query.get("provider")) args = { provider: query.get("provider") };
      const providerValue = args.provider || null;
      const validProvider = providerValue === null || ["claude", "codex"].includes(providerValue);
      const validScope = !Object.hasOwn(args, "scope") || ["live", "all"].includes(args.scope);
      const validLimit = !Object.hasOwn(args, "limit") || Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= (name === "getRecentFailures" ? 25 : 50);
      const validWindow = !Object.hasOwn(args, "withinMinutes") || Number.isSafeInteger(args.withinMinutes) && args.withinMinutes >= 1 && args.withinMinutes <= 1_440;
      const validSessionRef = !Object.hasOwn(args, "sessionRef") || /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(args.sessionRef);
      const validAgentId = !Object.hasOwn(args, "agentId") || args.agentId === null || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(args.agentId);
      const validRefs = validSessionRef && validAgentId;
      const validQuery = [...query.keys()].every((key) => allowedQueryKeys.has(key) && query.getAll(key).length === 1);
      if (!validProvider || !validScope || !validLimit || !validWindow || !validRefs || !validQuery) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Invalid agent query arguments" }));
        return;
      }
      if (!name || typeof runtime.serveAgentQuery !== "function") {
        response.writeHead(404); response.end(JSON.stringify({ error: "Agent query unavailable" })); return;
      }
      try {
        const result = runtime.serveAgentQuery(name, args, requestedRevision);
        if (result?.status === "unchanged") { response.writeHead(204); response.end(); return; }
        const snapshot = result?.snapshot;
        response.writeHead(200, { ...(Number.isSafeInteger(result?.revision) ? { "X-Pomegr-Revision": String(result.revision) } : {}) });
        response.end(snapshot?.serialized || JSON.stringify(snapshot?.value || { schemaVersion: 1, readiness: "unavailable", reason: "monitor_unavailable" }));
      } catch {
        response.writeHead(503); response.end(JSON.stringify({ schemaVersion: 1, readiness: "unavailable", reason: "monitor_unavailable", sessions: [] }));
      }
      return;
    }
    const repositoryCaptureRequest = requestUrl.pathname === "/internal/repository-inventory/capture";
    const desktopReadAllowed = !repositoryCaptureRequest && (!authorizationToken || (
      ["GET", "HEAD"].includes(request.method || "")
      && request.headers.host === expectedHost
      && request.headers.origin === undefined
      && requestHasDesktopAuthorization(request, authorizationToken)
    ));
    const desktopCaptureAllowed = repositoryCaptureRequest && Boolean(authorizationToken)
      && request.method === "POST" && request.headers.host === expectedHost
      && request.headers.origin === undefined
      && requestHasDesktopAuthorization(request, authorizationToken);
    if (!desktopReadAllowed && !desktopCaptureAllowed) {
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
    if (repositoryCaptureRequest) {
      const allowedKeys = new Set(["repositoryId", "provider"]);
      const repositoryId = requestUrl.searchParams.get("repositoryId") || "";
      const provider = requestUrl.searchParams.get("provider") || "";
      const validQuery = [...requestUrl.searchParams.keys()].every((key) => allowedKeys.has(key)
        && requestUrl.searchParams.getAll(key).length === 1);
      if (!validQuery || !/^repo-[a-f0-9]{24}$/u.test(repositoryId) || !["claude", "codex"].includes(provider)
        || Number(request.headers["content-length"] || 0) > 0 || request.headers["transfer-encoding"] !== undefined) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "failed" }));
        return;
      }
      try {
        const status = await runtime.captureRepositoryInventory(repositoryId, provider);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status }));
      } catch {
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "failed" }));
      }
      return;
    }
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const requestedRevisionValue = requestUrl.searchParams.get("revision");
    const requestedRevision = /^\d+$/u.test(requestedRevisionValue || "") ? Number(requestedRevisionValue) : null;
    const writeCommitted = (result, fallbackValue) => {
      if (result?.status === "unchanged") {
        response.writeHead(204);
        response.end();
        return;
      }
      const snapshot = result?.snapshot || result?.unavailableSnapshot;
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
        if (closed || !["sessions", "repositories"].includes(event?.domain)
          || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
        try {
          const eventName = event.domain === "sessions" ? "catalog" : "repositories";
          response.write(`event: ${eventName}\ndata: ${JSON.stringify({ domain: event.domain, revision: event.revision })}\n\n`);
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
    if (requestUrl.pathname === "/api/repositories") {
      if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }); response.end(); return; }
      try {
        writeCommitted(runtime.serveRepositories?.(requestedRevision), { revision: 0, readiness: "loading", repositories: [] });
      } catch {
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ revision: 0, readiness: "unavailable", repositories: [] }));
      }
      return;
    }
    if (requestUrl.pathname === "/api/repository-inventory") {
      if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }); response.end(); return; }
      const allowedKeys = new Set(["repositoryId", "provider", "revisionId"]);
      const repositoryId = requestUrl.searchParams.get("repositoryId") || "";
      const provider = requestUrl.searchParams.get("provider") || "";
      const revisionId = requestUrl.searchParams.get("revisionId") || "";
      const validQuery = [...requestUrl.searchParams.keys()].every((key) => allowedKeys.has(key)
        && requestUrl.searchParams.getAll(key).length === 1);
      if (!validQuery || !/^repo-[a-f0-9]{24}$/u.test(repositoryId) || !["claude", "codex"].includes(provider)
        || !/^ctx-\d{3,9}$/u.test(revisionId)) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Invalid repository inventory reference" }));
        return;
      }
      try {
        const detail = await runtime.readRepositoryInventory?.(repositoryId, provider, revisionId);
        if (!detail) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(detail));
      } catch { response.writeHead(503); response.end(); }
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
