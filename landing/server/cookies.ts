export const WAITLIST_COOKIE_NAME = "__Host-pomegr_waitlist";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const ONE_YEAR_MS = ONE_YEAR_SECONDS * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("Cookie signing secret is unavailable.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function createWaitlistCookie(secret: string, issuedAt = Date.now()): Promise<string> {
  const payload = new Uint8Array(32);
  crypto.getRandomValues(payload);
  new DataView(payload.buffer).setBigUint64(0, BigInt(Math.floor(issuedAt)), false);
  const value = toBase64Url(payload);
  const signature = await sign(value, secret);
  return `${WAITLIST_COOKIE_NAME}=${value}.${signature}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    if (segment.slice(0, separator).trim() === name) {
      return segment.slice(separator + 1).trim();
    }
  }
  return null;
}

export async function verifyWaitlistCookie(request: Request, secret: string, now = Date.now()): Promise<boolean> {
  const cookie = readCookie(request, WAITLIST_COOKIE_NAME);
  if (!cookie) return false;
  const separator = cookie.lastIndexOf(".");
  if (separator < 1) return false;
  const value = cookie.slice(0, separator);
  const suppliedSignature = cookie.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value) || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)) {
    return false;
  }
  const expectedSignature = await sign(value, secret);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return false;
  const payload = fromBase64Url(value);
  if (!payload || payload.byteLength !== 32) return false;
  const issuedAt = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, false));
  return Number.isSafeInteger(issuedAt)
    && issuedAt <= now + MAX_CLOCK_SKEW_MS
    && now - issuedAt <= ONE_YEAR_MS;
}
