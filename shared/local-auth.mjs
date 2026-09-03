import { timingSafeEqual } from "node:crypto";

export const DESKTOP_AUTH_HEADER = "x-pomegr-desktop-authorization";
/** Capability used exclusively by local MCP agent-query routes. */
export const AGENT_QUERY_AUTH_HEADER = "x-pomegr-agent-authorization";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function requireDesktopToken(value, code = "DESKTOP_AUTH_INVALID") {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) throw new Error(code);
  return value;
}

export function tokensMatch(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function requestHasDesktopAuthorization(request, expectedToken) {
  const value = request?.headers?.[DESKTOP_AUTH_HEADER];
  return tokensMatch(Array.isArray(value) ? value[0] : value, expectedToken);
}

export function requestHasAgentQueryAuthorization(request, expectedToken) {
  const value = request?.headers?.[AGENT_QUERY_AUTH_HEADER];
  return tokensMatch(Array.isArray(value) ? value[0] : value, expectedToken);
}
