import type { WaitlistEnv, WaitlistPayload } from "./types";

const MAX_BODY_BYTES = 4 * 1024;
const PRODUCTION_HOST = "pomegr.com";
const PRODUCTION_ORIGIN = "https://pomegr.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class FixedWindowLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  attempt(key: string, now = Date.now()): boolean {
    const previous = this.#entries.get(key);
    if (!previous || previous.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + this.windowMs });
      this.#prune(now);
      return true;
    }
    previous.count += 1;
    return previous.count <= this.limit;
  }

  clear(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    if (this.#entries.size < 4_096) return;
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
  }
}

export function isTrustedBrowserRequest(request: Request, env: WaitlistEnv): boolean {
  const host = request.headers.get("host")?.toLowerCase() ?? "";
  const origin = request.headers.get("origin") ?? "";
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;

  if (host === PRODUCTION_HOST && origin === PRODUCTION_ORIGIN) return true;
  if (env.WAITLIST_ALLOW_LOCAL_DEV !== "true") return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (!LOCAL_HOSTS.has(requestUrl.hostname)) return false;
  return host === requestUrl.host.toLowerCase() && origin === requestUrl.origin;
}

export function trustedClientIp(request: Request, env: WaitlistEnv): string | null {
  const cloudflareIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) return cloudflareIp.slice(0, 64);
  if (env.WAITLIST_ALLOW_LOCAL_DEV === "true") return "local-development";
  return null;
}

export async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_BODY_BYTES) return null;
  }

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (totalBytes === 0) return null;

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function honeypotIsPopulated(payload: Record<string, unknown>): boolean {
  const value = payload.website;
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

export function readTurnstileToken(payload: Record<string, unknown>): string | null {
  if (typeof payload.turnstileToken !== "string") return null;
  const token = payload.turnstileToken.trim();
  return token.length >= 1 && token.length <= 2_048 ? token : null;
}

export function validateWaitlistPayload(payload: Record<string, unknown>): WaitlistPayload | null {
  if (typeof payload.email !== "string" || typeof payload.turnstileToken !== "string") return null;

  const email = payload.email.trim().toLowerCase();
  const turnstileToken = readTurnstileToken(payload);
  if (email.length < 3 || email.length > 254 || !turnstileToken) return null;
  if (/\s|[\u0000-\u001f\u007f]/u.test(email)) return null;
  if (!/^[^@]+@[^@.]+(?:\.[^@.]+)+$/u.test(email)) return null;

  return {
    email,
    turnstileToken,
    website: typeof payload.website === "string" ? payload.website : undefined,
  };
}
