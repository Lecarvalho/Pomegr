import { monitorOrigin } from "../../monitor-proxy";
import { isPairedGatewayRequest } from "../../paired-gateway";

export const dynamic = "force-dynamic";

// A paired device's task-board actions.

const ACTIONS = new Set([
  "create", "update", "delete", "move",
  "feature_create",
  "queue_add", "queue_remove", "queue_reorder", "queue_settings",
  "resolve_done", "resolve_requeue",
]);
const MONITOR_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported"]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const PAYLOAD_MAX_BYTES = 16 * 1024;
const BODY_MAX_BYTES = PAYLOAD_MAX_BYTES + 1024;

type Answer = { ok: true; taskId?: string } | { ok: false; error: string };

function answer(body: Answer, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
  if (!isPairedGatewayRequest(request)) return answer({ ok: false, error: "unavailable" }, 403);
  const mediaType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (new URL(request.url).search || mediaType !== "application/json") return answer({ ok: false, error: "invalid" });
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > BODY_MAX_BYTES) return answer({ ok: false, error: "invalid" });
    body = JSON.parse(raw);
  } catch { return answer({ ok: false, error: "invalid" }); }
  if (!plainObject(body) || Object.keys(body).some((key) => key !== "repositoryId" && key !== "action" && key !== "payload")
    || typeof body.repositoryId !== "string" || !REPOSITORY_ID.test(body.repositoryId)
    || typeof body.action !== "string" || !ACTIONS.has(body.action) || !plainObject(body.payload)) return answer({ ok: false, error: "invalid" });
  const { repositoryId, action, payload } = body;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_MAX_BYTES) return answer({ ok: false, error: "invalid" });
  try {
    const response = await fetch(`${monitorOrigin()}/internal/tasks/${action}`, {
      method: "POST",
      cache: "no-store",
      headers: { "x-pomegr-desktop-authorization": process.env.POMEGR_MONITOR_TOKEN || "", "content-type": "application/json" },
      body: `{"repositoryId":${JSON.stringify(repositoryId)},"payload":${serialized}}`,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const parsed: unknown = await response.json();
    if (!plainObject(parsed)) return answer({ ok: false, error: "unavailable" });
    if (parsed.ok === true) {
      if (!response.ok) return answer({ ok: false, error: "unavailable" });
      return answer(action === "create" && typeof parsed.taskId === "string" && TASK_ID.test(parsed.taskId) ? { ok: true, taskId: parsed.taskId } : { ok: true });
    }
    return answer({ ok: false, error: typeof parsed.error === "string" && MONITOR_ERRORS.has(parsed.error) ? parsed.error : "unavailable" });
  } catch {
    return answer({ ok: false, error: "unavailable" });
  }
}
