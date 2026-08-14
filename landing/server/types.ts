export interface D1RunResultLike {
  success: boolean;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface RateLimitBindingLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface WaitlistEnv {
  DB: D1DatabaseLike;
  WAITLIST_RATE_LIMITER?: RateLimitBindingLike;
  WAITLIST_COOKIE_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  ENVIRONMENT?: string;
  WAITLIST_ALLOW_LOCAL_DEV?: string;
}

export interface TurnstileVerification {
  success?: boolean;
  hostname?: string;
  action?: string;
  [key: string]: unknown;
}

export interface WaitlistPayload {
  email: string;
  turnstileToken: string;
  website?: string;
}
