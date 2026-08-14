import { createWaitlistCookie, verifyWaitlistCookie } from "./cookies";
import { invalidRequest, jsonResponse, serviceUnavailable, tooManyRequests } from "./responses";
import {
  FixedWindowLimiter,
  honeypotIsPopulated,
  isTrustedBrowserRequest,
  parseJsonBody,
  readTurnstileToken,
  trustedClientIp,
  validateWaitlistPayload,
} from "./security";
import { verifyTurnstile } from "./turnstile";
import type { WaitlistEnv } from "./types";

export interface WaitlistHandlerDependencies {
  fetchImplementation?: typeof fetch;
  limiter?: FixedWindowLimiter;
  now?: () => number;
}

const productionLimiter = new FixedWindowLimiter();

export function createWaitlistHandlers(dependencies: WaitlistHandlerDependencies = {}) {
  const limiter = dependencies.limiter ?? productionLimiter;
  const now = dependencies.now ?? Date.now;

  return {
    async post(request: Request, env: WaitlistEnv): Promise<Response> {
      if (!isTrustedBrowserRequest(request, env)) return invalidRequest();

      const payload = await parseJsonBody(request);
      if (!payload) return invalidRequest();
      if (honeypotIsPopulated(payload)) return invalidRequest();

      const clientIp = trustedClientIp(request, env);
      if (!clientIp) return invalidRequest();
      if (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") {
        if (!env.WAITLIST_RATE_LIMITER) return serviceUnavailable();
        try {
          const rateLimit = await env.WAITLIST_RATE_LIMITER.limit({ key: clientIp });
          if (!rateLimit.success) return tooManyRequests();
        } catch {
          return serviceUnavailable();
        }
      } else if (!limiter.attempt(clientIp, now())) {
        return tooManyRequests();
      }

      const turnstileToken = readTurnstileToken(payload);
      if (!turnstileToken) return invalidRequest();

      const turnstileResult = await verifyTurnstile(
        turnstileToken,
        clientIp,
        env,
        dependencies.fetchImplementation,
      );
      if (turnstileResult === "unavailable") return serviceUnavailable();
      if (turnstileResult === "invalid") return invalidRequest();

      const validated = validateWaitlistPayload(payload);
      if (!validated) return invalidRequest();

      let id: string;
      let cookie: string;
      try {
        id = crypto.randomUUID();
        cookie = await createWaitlistCookie(env.WAITLIST_COOKIE_SECRET, now());
      } catch {
        return serviceUnavailable();
      }

      try {
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO waitlist_entries
            (id, email, desktop, ios, android, created_at)
           VALUES (?, ?, 0, 0, 0, ?)`,
        )
          .bind(
            id,
            validated.email,
            new Date(now()).toISOString(),
          )
          .run();
        if (!result.success) return serviceUnavailable();
      } catch {
        return serviceUnavailable();
      }

      return jsonResponse({ joined: true }, 200, { "set-cookie": cookie });
    },

    async status(request: Request, env: WaitlistEnv): Promise<Response> {
      let joined = false;
      try {
        joined = await verifyWaitlistCookie(request, env.WAITLIST_COOKIE_SECRET, now());
      } catch {
        joined = false;
      }
      return jsonResponse({ joined });
    },
  };
}
