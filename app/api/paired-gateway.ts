function isLoopbackHost(value: string | null) {
  if (!value) return false;
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(`http://${value}`).hostname);
  } catch { return false; }
}

// Compares every character whatever the first difference, so the time taken says nothing about the token.
function tokensMatch(actual: string, expected: string) {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

/**
 * True for a request the desktop's LAN gateway forwarded for a paired device. The gateway forwards only for a paired
 * device, marks what it forwards, and is the only sender of that mark that also holds the desktop token. The
 * development server sets the same mark on a peer that is not local, which has no token, so it is never paired.
 */
export function isPairedGatewayRequest(request: Request) {
  const expected = process.env.POMEGR_MONITOR_TOKEN;
  const supplied = request.headers.get("x-pomegr-desktop-authorization");
  if (!expected || !supplied || request.headers.get("x-pomegr-lan-gateway") !== "1") return false;
  const host = request.headers.get("host");
  let url: URL;
  try { url = new URL(request.url); } catch { return false; }
  return isLoopbackHost(host) && host === url.host && request.headers.get("origin") === null && tokensMatch(supplied, expected);
}
