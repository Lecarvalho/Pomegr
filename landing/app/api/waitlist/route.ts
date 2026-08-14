import { env } from "cloudflare:workers";
import { jsonResponse } from "../../../server/responses";
import { createWaitlistHandlers } from "../../../server/waitlist";
import type { WaitlistEnv } from "../../../server/types";

export const dynamic = "force-dynamic";

const handlers = createWaitlistHandlers();

export async function POST(request: Request): Promise<Response> {
  return handlers.post(request, env as unknown as WaitlistEnv);
}

export async function OPTIONS(): Promise<Response> {
  return jsonResponse({ error: "Method not allowed." }, 405, { allow: "POST" });
}
