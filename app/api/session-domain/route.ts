import { proxyMonitorJson } from "../monitor-proxy";
import { SESSION_DOMAINS, type SessionDomain } from "../../../shared/session-domain-contract";

export const dynamic = "force-dynamic";

const allowed = new Set(["sessionId", "domain", "agentId", "revision"]);
const domains = new Set<string>(SESSION_DOMAINS);
const sessionIdPattern = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export async function GET(request: Request) {
  const source = new URL(request.url);
  const domainValue = source.searchParams.get("domain") || "session-summary";
  const sessionId = source.searchParams.get("sessionId") || "";
  const agentId = source.searchParams.get("agentId");
  const revision = source.searchParams.get("revision");
  const validKeys = [...source.searchParams.keys()].every((key) => allowed.has(key) && source.searchParams.getAll(key).length === 1);
  if (!validKeys || !domains.has(domainValue) || !sessionIdPattern.test(sessionId)
    || agentId !== null && !agentIdPattern.test(agentId) || revision !== null && !/^\d+$/u.test(revision)) {
    return Response.json({ error: "Invalid session domain request" }, { status: 400 });
  }
  const params = new URLSearchParams();
  for (const [key, value] of source.searchParams) if (allowed.has(key)) params.append(key, value);
  if (!params.has("domain")) params.set("domain", domainValue);
  const domain = domainValue as SessionDomain;
  return proxyMonitorJson({
    ifNoneMatch: request.headers.get("if-none-match"),
    path: `/api/session-domain?${params}`,
    timeoutMs: 7500,
    unavailableBody: { domain, sessionId, revision: 0, readiness: "unavailable", observedAt: null },
    acceptEncoding: request.headers.get("accept-encoding"),
  });
}
