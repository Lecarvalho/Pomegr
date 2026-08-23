const OPAQUE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROUTE_PREFIXES = [
  ["codex", "codex-"],
  ["claude", "claude-"],
];

/** @param {string} internalId */
export function encodeSessionRoute(internalId) {
  const separator = internalId.indexOf(":");
  const provider = internalId.slice(0, separator);
  const opaqueId = internalId.slice(separator + 1);
  const prefix = ROUTE_PREFIXES.find(([id]) => id === provider)?.[1];
  if (!prefix || separator <= 0 || !OPAQUE_SESSION_ID.test(opaqueId)) {
    throw new Error("Invalid session ID");
  }
  return `${prefix}${opaqueId}`;
}

/** @param {string} segment */
export function decodeSessionRoute(segment) {
  if (typeof segment !== "string") return null;
  const route = ROUTE_PREFIXES.find(([, prefix]) => segment.startsWith(prefix));
  if (!route) return null;
  const opaqueId = segment.slice(route[1].length);
  return OPAQUE_SESSION_ID.test(opaqueId) ? `${route[0]}:${opaqueId}` : null;
}
