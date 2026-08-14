import { beforeEach, describe, expect, it, vi } from "vitest";
import { WAITLIST_COOKIE_NAME } from "../../server/cookies";
import { FixedWindowLimiter } from "../../server/security";
import type { D1DatabaseLike, D1PreparedStatementLike, D1RunResultLike, WaitlistEnv } from "../../server/types";
import { createWaitlistHandlers } from "../../server/waitlist";

const COOKIE_SECRET = "test-cookie-secret-that-is-at-least-thirty-two-characters";

class MockDatabase implements D1DatabaseLike {
  calls: Array<{ query: string; values: unknown[] }> = [];
  emails = new Set<string>();
  rows = new Map<string, unknown[]>();
  success = true;

  prepare(query: string): D1PreparedStatementLike {
    let values: unknown[] = [];
    return {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return {
          bind: () => {
            throw new Error("Unexpected second bind.");
          },
          run: async (): Promise<D1RunResultLike> => {
            this.calls.push({ query, values });
            if (this.success) {
              const email = String(values[1]);
              this.emails.add(email);
              if (!this.rows.has(email)) this.rows.set(email, values);
            }
            return { success: this.success };
          },
        };
      },
      run: async () => {
        throw new Error("Statement must be bound.");
      },
    };
  }
}

function env(database = new MockDatabase(), overrides: Partial<WaitlistEnv> = {}): WaitlistEnv {
  return {
    DB: database,
    WAITLIST_COOKIE_SECRET: COOKIE_SECRET,
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    ENVIRONMENT: "test",
    ...overrides,
  };
}

function request(
  body: Record<string, unknown> = {
    email: "Person@Example.com ",
    turnstileToken: "valid-token",
    website: "",
  },
  headers: Record<string, string | null> = {},
  url = "https://pomegr.com/api/waitlist",
): Request {
  const initialHeaders: Record<string, string> = {
    host: "pomegr.com",
    origin: "https://pomegr.com",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "cf-connecting-ip": "203.0.113.7",
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) delete initialHeaders[key];
    else initialHeaders[key] = value;
  }
  return new Request(url, { method: "POST", headers: initialHeaders, body: JSON.stringify(body) });
}

function turnstileFetch(result: Record<string, unknown> = {
  success: true,
  hostname: "pomegr.com",
  action: "waitlist_signup",
}) {
  return vi.fn(async () => new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function freshHandlers(fetchImplementation = turnstileFetch()) {
  return {
    fetchImplementation,
    handlers: createWaitlistHandlers({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      limiter: new FixedWindowLimiter(),
      now: () => Date.UTC(2026, 7, 14, 17, 0, 0),
    }),
  };
}

describe("protected waitlist", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    ["missing Host", { host: null }],
    ["wrong Host", { host: "www.pomegr.com" }],
    ["missing Origin", { origin: null }],
    ["cross-origin", { origin: "https://attacker.example" }],
    ["missing Fetch Metadata", { "sec-fetch-site": null }],
    ["cross-site Fetch Metadata", { "sec-fetch-site": "cross-site" }],
    ["missing trusted Cloudflare IP", { "cf-connecting-ip": null }],
    ["non-JSON content", { "content-type": "text/plain" }],
  ])("rejects %s without external or database work", async (_label, headers) => {
    const database = new MockDatabase();
    const { handlers, fetchImplementation } = freshHandlers();
    const response = await handlers.post(request(undefined, headers), env(database));
    expect(response.status).toBe(400);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(0);
  });

  it("rejects oversized bodies before external or database work", async () => {
    const database = new MockDatabase();
    const { handlers, fetchImplementation } = freshHandlers();
    const response = await handlers.post(request({
      email: "person@example.com",
      turnstileToken: "x".repeat(4_100),
      website: "",
    }), env(database));
    expect(response.status).toBe(400);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(0);
  });

  it("rejects a populated honeypot before limiter, Turnstile, or D1", async () => {
    const database = new MockDatabase();
    const limiter = new FixedWindowLimiter(1, 60_000);
    const fetchImplementation = turnstileFetch();
    const handlers = createWaitlistHandlers({ fetchImplementation: fetchImplementation as unknown as typeof fetch, limiter });
    expect((await handlers.post(request({
      email: "bot@example.com",
      turnstileToken: "valid-token",
      website: "buy things",
    }), env(database))).status).toBe(400);
    expect((await handlers.post(request(), env(database))).status).toBe(200);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(database.calls).toHaveLength(1);
  });

  it("limits each trusted Cloudflare IP to five attempts per minute without D1 writes", async () => {
    const database = new MockDatabase();
    const fetchImplementation = turnstileFetch({ success: false, "error-codes": ["invalid-input-response"] });
    const { handlers } = freshHandlers(fetchImplementation);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await handlers.post(request(), env(database))).status).toBe(400);
    }
    const limited = await handlers.post(request(), env(database));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
    expect(database.calls).toHaveLength(0);
  });

  it("uses the native Cloudflare rate limiter in production and fails closed if absent", async () => {
    const database = new MockDatabase();
    const nativeLimiter = { limit: vi.fn(async () => ({ success: false })) };
    const { handlers, fetchImplementation } = freshHandlers();
    const limited = await handlers.post(request(), env(database, {
      ENVIRONMENT: "production",
      WAITLIST_RATE_LIMITER: nativeLimiter,
    }));
    expect(limited.status).toBe(429);
    expect(nativeLimiter.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(database.calls).toHaveLength(0);

    const missingBinding = await handlers.post(request(undefined, { "cf-connecting-ip": "203.0.113.8" }), env(database, {
      ENVIRONMENT: "production",
    }));
    expect(missingBinding.status).toBe(503);
    expect(database.calls).toHaveLength(0);
  });

  it.each([
    ["wrong hostname", { success: true, hostname: "attacker.example", action: "waitlist_signup" }],
    ["wrong action", { success: true, hostname: "pomegr.com", action: "other_action" }],
    ["expired or invalid token", { success: false, "error-codes": ["timeout-or-duplicate"] }],
  ])("rejects Turnstile %s without touching D1", async (_label, result) => {
    const database = new MockDatabase();
    const { handlers } = freshHandlers(turnstileFetch(result));
    expect((await handlers.post(request(), env(database))).status).toBe(400);
    expect(database.calls).toHaveLength(0);
  });

  it("treats Turnstile network and decoding failures as a generic 503", async () => {
    const database = new MockDatabase();
    const networkFailure = vi.fn(async () => { throw new Error("private upstream detail"); });
    const handlers = createWaitlistHandlers({
      fetchImplementation: networkFailure as unknown as typeof fetch,
      limiter: new FixedWindowLimiter(),
    });
    const response = await handlers.post(request(), env(database));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service unavailable." });
    expect(database.calls).toHaveLength(0);
  });

  it("relies on Turnstile to reject replayed single-use tokens", async () => {
    const database = new MockDatabase();
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, hostname: "pomegr.com", action: "waitlist_signup" }))
      .mockResolvedValueOnce(Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    const { handlers } = freshHandlers(fetchImplementation);
    expect((await handlers.post(request(), env(database))).status).toBe(200);
    expect((await handlers.post(request(), env(database))).status).toBe(400);
    expect(database.calls).toHaveLength(1);
  });

  it("normalizes email and keeps the same duplicate response", async () => {
    const database = new MockDatabase();
    const { handlers } = freshHandlers();
    const first = await handlers.post(request({
      email: "  Person@Example.COM ",
      turnstileToken: "one",
      website: "",
    }), env(database));
    const duplicate = await handlers.post(request({
      email: "person@example.com",
      turnstileToken: "two",
      website: "",
    }), env(database));
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await first.json()).toEqual({ joined: true });
    expect(await duplicate.json()).toEqual({ joined: true });
    expect(database.calls[0]?.values).toHaveLength(3);
    expect(database.calls[0]?.values[1]).toBe("person@example.com");
    expect(database.calls[0]?.query).toContain("VALUES (?, ?, 0, 0, 0, ?)");
    expect(database.calls[1]?.query).toContain("INSERT OR IGNORE");
    expect(database.emails).toEqual(new Set(["person@example.com"]));
    expect(database.rows.get("person@example.com")?.[1]).toBe("person@example.com");
  });

  it("validates email only after successful Turnstile and before D1", async () => {
    const database = new MockDatabase();
    const { handlers, fetchImplementation } = freshHandlers();
    const response = await handlers.post(request({
      email: "not-an-email",
      turnstileToken: "valid-token",
      website: "",
    }), env(database));
    expect(response.status).toBe(400);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(database.calls).toHaveLength(0);
  });

  it("uses an opaque signed strict cookie and status reveals only a boolean", async () => {
    const database = new MockDatabase();
    const { handlers } = freshHandlers();
    const joined = await handlers.post(request(), env(database));
    const setCookie = joined.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${WAITLIST_COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=31536000");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie.toLowerCase()).not.toContain("person@example.com");

    const cookiePair = setCookie.split(";", 1)[0];
    const status = await handlers.status(new Request("https://pomegr.com/api/waitlist/status", {
      headers: { cookie: cookiePair },
    }), env(database));
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ joined: true });

    const tampered = cookiePair.slice(0, -1) + (cookiePair.endsWith("a") ? "b" : "a");
    const invalid = await handlers.status(new Request("https://pomegr.com/api/waitlist/status", {
      headers: { cookie: tampered },
    }), env(database));
    expect(await invalid.json()).toEqual({ joined: false });

    const expiredHandlers = createWaitlistHandlers({
      now: () => Date.UTC(2027, 7, 15, 17, 0, 1),
      limiter: new FixedWindowLimiter(),
    });
    const expired = await expiredHandlers.status(new Request("https://pomegr.com/api/waitlist/status", {
      headers: { cookie: cookiePair },
    }), env(database));
    expect(await expired.json()).toEqual({ joined: false });
  });

  it("permits explicit localhost development without weakening production", async () => {
    const database = new MockDatabase();
    const { handlers } = freshHandlers();
    const localHeaders = {
      host: "localhost:8788",
      origin: "http://localhost:8788",
      "cf-connecting-ip": null,
    };
    expect((await handlers.post(
      request(undefined, localHeaders, "http://localhost:8788/api/waitlist"),
      env(database),
    )).status).toBe(400);
    expect((await handlers.post(
      request(undefined, localHeaders, "http://localhost:8788/api/waitlist"),
      env(database, { WAITLIST_ALLOW_LOCAL_DEV: "true" }),
    )).status).toBe(200);
  });

  it("returns a generic 503 if D1 fails", async () => {
    const database = new MockDatabase();
    database.success = false;
    const { handlers } = freshHandlers();
    const response = await handlers.post(request(), env(database));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service unavailable." });
    expect(database.calls).toHaveLength(1);
  });
});
