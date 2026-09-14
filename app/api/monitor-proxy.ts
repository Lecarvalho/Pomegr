import { gzipSync } from "node:zlib";

const DEFAULT_MONITOR_ORIGIN = "http://127.0.0.1:4317";

export function monitorOrigin(value = process.env.POMEGR_MONITOR_ORIGIN) {
  if (!value) return DEFAULT_MONITOR_ORIGIN;
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:" || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash || !origin.port
      || !["127.0.0.1", "[::1]"].includes(origin.hostname)) {
      return DEFAULT_MONITOR_ORIGIN;
    }
    return origin.origin;
  } catch {
    return DEFAULT_MONITOR_ORIGIN;
  }
}

type MonitorProxyOptions = {
  path: string;
  timeoutMs: number;
  unavailableBody: object;
  acceptEncoding?: string | null;
  ifNoneMatch?: string | null;
};

export function acceptsGzipEncoding(value: string | null) {
  let gzip: number | null = null;
  let wildcard: number | null = null;
  for (const entry of (value || "").split(",")) {
    const [rawName, ...parameters] = entry.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== "gzip" && name !== "*") continue;
    let quality = 1;
    let hasInvalidQuality = false;
    let hasQuality = false;
    for (const parameter of parameters) {
      const qualityParameter = /^\s*q\s*=\s*(.*?)\s*$/iu.exec(parameter);
      if (!qualityParameter) continue;
      if (hasQuality || !/^(?:0(?:\.\d{1,3})?|\.\d{1,3}|1(?:\.0{1,3})?)$/u.test(qualityParameter[1])) {
        hasInvalidQuality = true;
        continue;
      }
      hasQuality = true;
      quality = Number(qualityParameter[1]);
    }
    if (hasInvalidQuality) quality = 0;
    if (name === "gzip") gzip = gzip === null ? quality : Math.max(gzip, quality);
    else wildcard = wildcard === null ? quality : Math.max(wildcard, quality);
  }
  return (gzip ?? wildcard ?? 0) > 0;
}

function proxyRevision(value: string | null) {
  return value && /^\d{1,20}$/u.test(value) ? value : null;
}

function proxyEtag(value: string | null) {
  return value && /^(?:W\/)?"[\x21\x23-\x7e]{0,510}"$/u.test(value) ? value : null;
}

function revisionHeaders(response: Response) {
  const revision = proxyRevision(response.headers.get("x-pomegr-revision"));
  const etag = proxyEtag(response.headers.get("etag"));
  return {
    ...(revision ? { "X-Pomegr-Revision": revision } : {}),
    ...(etag ? { ETag: etag } : {}),
  };
}

export async function proxyMonitorJson({ path, timeoutMs, unavailableBody, acceptEncoding = null, ifNoneMatch = null }: MonitorProxyOptions) {
  try {
    const authorizationToken = process.env.POMEGR_MONITOR_TOKEN;
    const conditionalTag = proxyEtag(ifNoneMatch);
    const response = await fetch(`${monitorOrigin()}${path}`, {
      cache: "no-store",
      headers: {
        "accept-encoding": "identity",
        ...(conditionalTag ? { "if-none-match": conditionalTag } : {}),
        ...(authorizationToken ? { "x-pomegr-desktop-authorization": authorizationToken } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Monitor returned ${response.status}`);
    if (response.status === 204) {
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          Vary: "Accept-Encoding",
          ...revisionHeaders(response),
        },
      });
    }
    const text = await response.text();
    const compressed = acceptsGzipEncoding(acceptEncoding) && Buffer.byteLength(text) >= 1_024;
    const body = compressed ? new Uint8Array(gzipSync(Buffer.from(text))) : text;
    return new Response(body, {
      status: response.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding",
        ...(compressed ? { "Content-Encoding": "gzip" } : {}),
        ...revisionHeaders(response),
      },
    });
  } catch {
    return Response.json(unavailableBody, {
      status: 503,
      headers: { "Cache-Control": "no-store", Vary: "Accept-Encoding" },
    });
  }
}

export async function proxyMonitorEventStream(signal?: AbortSignal) {
  try {
    const authorizationToken = process.env.POMEGR_MONITOR_TOKEN;
    const response = await fetch(`${monitorOrigin()}/api/events`, {
      cache: "no-store",
      headers: authorizationToken
        ? { "x-pomegr-desktop-authorization": authorizationToken }
        : undefined,
      signal,
    });
    if (!response.ok || !response.body) throw new Error("Monitor revision stream unavailable");
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return new Response("Revision events unavailable", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}
