const OPAQUE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Route parsing is deliberately syntactic. Provider registration remains the
// authority that decides whether a parsed provider is supported; keeping that
// allowlist out of this browser-safe helper means a new first-party provider
// does not require another routing branch.
const ROUTE_PROVIDER_ID = /^[a-z][a-z0-9]{0,31}$/;

/** @param {string} internalId */
export function encodeSessionRoute(internalId) {
  const separator = internalId.indexOf(":");
  const provider = internalId.slice(0, separator);
  const opaqueId = internalId.slice(separator + 1);
  if (separator <= 0 || separator !== internalId.lastIndexOf(":")
    || !ROUTE_PROVIDER_ID.test(provider) || !OPAQUE_SESSION_ID.test(opaqueId)) {
    throw new Error("Invalid session ID");
  }
  return `${provider}-${opaqueId}`;
}

/** @param {string} segment */
export function decodeSessionRoute(segment) {
  if (typeof segment !== "string") return null;
  const separator = segment.indexOf("-");
  if (separator <= 0) return null;
  const provider = segment.slice(0, separator);
  const opaqueId = segment.slice(separator + 1);
  return ROUTE_PROVIDER_ID.test(provider) && OPAQUE_SESSION_ID.test(opaqueId)
    ? `${provider}:${opaqueId}`
    : null;
}
