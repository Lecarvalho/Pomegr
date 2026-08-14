import type { TurnstileVerification, WaitlistEnv } from "./types";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult = "valid" | "invalid" | "unavailable";

export async function verifyTurnstile(
  token: string,
  clientIp: string,
  env: WaitlistEnv,
  fetchImplementation: typeof fetch = fetch,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) return "unavailable";
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: clientIp,
  });

  let response: Response;
  try {
    response = await fetchImplementation(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return "unavailable";
  }
  if (!response.ok) return "unavailable";

  let result: TurnstileVerification;
  try {
    result = (await response.json()) as TurnstileVerification;
  } catch {
    return "unavailable";
  }

  if (!result.success) return "invalid";
  if (result.hostname !== "pomegr.com" || result.action !== "waitlist_signup") return "invalid";
  return "valid";
}
