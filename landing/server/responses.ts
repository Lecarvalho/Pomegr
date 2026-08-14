const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(JSON_HEADERS);
  if (headers) {
    new Headers(headers).forEach((value, key) => responseHeaders.set(key, value));
  }

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function invalidRequest(): Response {
  return jsonResponse({ error: "Invalid request." }, 400);
}

export function tooManyRequests(): Response {
  return jsonResponse({ error: "Too many requests." }, 429, { "retry-after": "60" });
}

export function serviceUnavailable(): Response {
  return jsonResponse({ error: "Service unavailable." }, 503);
}
