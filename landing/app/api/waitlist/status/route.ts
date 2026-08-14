import { env } from "cloudflare:workers";
import { createWaitlistHandlers } from "../../../../server/waitlist";
import type { WaitlistEnv } from "../../../../server/types";

export const dynamic = "force-dynamic";

const handlers = createWaitlistHandlers();

export async function GET(request: Request): Promise<Response> {
  return handlers.status(request, env as unknown as WaitlistEnv);
}
