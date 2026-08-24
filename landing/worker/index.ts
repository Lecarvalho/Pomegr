import handler from "vinext/server/app-router-entry";

interface WorkerEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response> | Response;
  };
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const PUBLIC_PATHS = new Set([
  "/",
  "/about",
  "/api/waitlist",
  "/api/waitlist/status",
  "/pomegr-logo.png",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
]);

const PUBLIC_PREFIXES = ["/_next/", "/_vinext/", "/assets/", "/fonts/", "/landing/"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function harden(response: Response, isApi: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()");
  headers.set("X-Frame-Options", "DENY");

  if (isApi) {
    headers.delete("Access-Control-Allow-Credentials");
    headers.delete("Access-Control-Allow-Headers");
    headers.delete("Access-Control-Allow-Methods");
    headers.delete("Access-Control-Allow-Origin");
    headers.set("Cache-Control", "no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname.toLowerCase() === "www.pomegr.com") {
      const destination = new URL(request.url);
      destination.hostname = "pomegr.com";
      destination.protocol = "https:";
      destination.port = "";
      return Response.redirect(destination.toString(), 308);
    }

    if (!isPublicPath(url.pathname)) {
      return harden(new Response("Not found", { status: 404 }), false);
    }

    const isApi = url.pathname === "/api/waitlist" || url.pathname === "/api/waitlist/status";
    if (isApi && request.method === "OPTIONS") {
      return harden(new Response("Not found", { status: 404 }), true);
    }

    const response = await handler.fetch(request, env, ctx);
    return harden(response, isApi);
  },
};
