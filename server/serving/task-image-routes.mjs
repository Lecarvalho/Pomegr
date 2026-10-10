import { TASK_BODY_LIMIT_BYTES, isPlainObject, readLimitedBody, writeActionResult } from "./task-routes.mjs";

// The image routes of the task board (desktop token only; the request handler applies the private-action gate).
// An image is user-authored content like the task text. Its bytes cross only here: in on `image-add`, out on
// `image-read`, both to desktop main. No GET serves them, and no answer carries a path.
export const TASK_IMAGE_ACTIONS = Object.freeze(["image-add", "image-remove", "image-read"]);
// Mirrors `TASK_BOUNDS.imageBytes` and `TASK_IMAGE_TYPES` in server/tasks/task-record.mjs, which the serving layer may
// not import; tests/server/tasks/task-image-routes.test.mjs pins them together.
export const TASK_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
export const TASK_IMAGE_MEDIA_TYPES = Object.freeze({ png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" });

const PREFIX = "/internal/tasks/";
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
const IMAGE_ID_PATTERN = /^img-[0-9a-f]{12}$/u;
const STATUS = Object.freeze({ invalid: 400, not_found: 404, limit: 409, conflict: 409, unavailable: 503 });
const rejected = (error) => ({ ok: false, error });
const refuse = (response, error, status = STATUS[error], options) => writeActionResult(response, status, rejected(error), options);
const fixedError = (result) => (Object.hasOwn(STATUS, result?.error) ? result.error : "unavailable");

// `image-add` carries the bytes as the whole body, so the identifiers travel in the query: exactly one repository ID
// and task ID, and optionally the image ID the caller already wrote into the task text.
async function addImage({ request, response, requestUrl, taskStore }) {
  const keys = [...requestUrl.searchParams.keys()];
  const repositoryId = requestUrl.searchParams.get("repositoryId") || "";
  const taskId = requestUrl.searchParams.get("taskId") || "";
  const imageId = requestUrl.searchParams.get("imageId");
  const mediaType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (keys.length !== (imageId === null ? 2 : 3) || new Set(keys).size !== keys.length || !REPOSITORY_ID_PATTERN.test(repositoryId) || !TASK_ID_PATTERN.test(taskId)
    || (imageId !== null && !IMAGE_ID_PATTERN.test(imageId))
    || mediaType !== "application/octet-stream" || request.headers["transfer-encoding"] !== undefined) {
    refuse(response, "invalid", 400, { close: true });
    return;
  }
  if (Number(request.headers["content-length"] || 0) > TASK_IMAGE_LIMIT_BYTES) { refuse(response, "invalid", 413, { close: true }); return; }
  let bytes;
  try {
    bytes = await readLimitedBody(request, TASK_IMAGE_LIMIT_BYTES);
  } catch {
    refuse(response, "invalid", 400, { close: true });
    return;
  }
  if (bytes === null) { refuse(response, "invalid", 413, { close: true }); return; }
  const result = taskStore.addImage(repositoryId, imageId === null ? { taskId, bytes } : { taskId, bytes, imageId });
  if (result?.ok === true && typeof result.imageId === "string" && IMAGE_ID_PATTERN.test(result.imageId)) {
    writeActionResult(response, 200, { ok: true, imageId: result.imageId });
    return;
  }
  refuse(response, fixedError(result));
}

// `image-remove` and `image-read` take the usual `{ repositoryId, payload }` envelope with exactly a task ID and an image ID.
async function readEnvelope(request, response, requestUrl) {
  if (requestUrl.search) { refuse(response, "invalid"); return null; }
  if (Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES) { refuse(response, "invalid", 413, { close: true }); return null; }
  let raw;
  try {
    raw = await readLimitedBody(request, TASK_BODY_LIMIT_BYTES);
  } catch {
    refuse(response, "invalid", 400, { close: true });
    return null;
  }
  if (raw === null) { refuse(response, "invalid", 413, { close: true }); return null; }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { refuse(response, "invalid"); return null; }
  const valid = isPlainObject(body) && Object.keys(body).every((key) => key === "repositoryId" || key === "payload")
    && typeof body.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(body.repositoryId) && isPlainObject(body.payload)
    && Object.keys(body.payload).length === 2
    && typeof body.payload.taskId === "string" && TASK_ID_PATTERN.test(body.payload.taskId)
    && typeof body.payload.imageId === "string" && IMAGE_ID_PATTERN.test(body.payload.imageId);
  if (!valid) { refuse(response, "invalid"); return null; }
  return body;
}

/**
 * `POST /internal/tasks/image-add | image-remove | image-read`. `image-add` answers `{ ok: true, imageId }`,
 * `image-remove` `{ ok: true }`, and `image-read` the image bytes with their fixed media type. Every refusal is
 * `{ ok: false, error }` with a fixed code; no answer echoes the input or names a file.
 */
export async function serveTaskImageRoute({ request, response, requestUrl, taskStore }) {
  const action = requestUrl.pathname.slice(PREFIX.length);
  if (!TASK_IMAGE_ACTIONS.includes(action)) { refuse(response, "invalid", 404); return; }
  try {
    if (typeof taskStore?.addImage !== "function" || typeof taskStore.removeImage !== "function" || typeof taskStore.readImage !== "function") {
      refuse(response, "unavailable", 503, { close: true });
      return;
    }
    if (action === "image-add") {
      await addImage({ request, response, requestUrl, taskStore });
      return;
    }
    const body = await readEnvelope(request, response, requestUrl);
    if (body === null) return;
    const payload = { taskId: body.payload.taskId, imageId: body.payload.imageId };
    if (action === "image-remove") {
      const result = taskStore.removeImage(body.repositoryId, payload);
      if (result?.ok === true) writeActionResult(response, 200, { ok: true });
      else refuse(response, fixedError(result));
      return;
    }
    const result = taskStore.readImage(body.repositoryId, payload);
    const mediaType = result?.ok === true ? TASK_IMAGE_MEDIA_TYPES[result.type] : undefined;
    if (!mediaType || !(result.bytes instanceof Uint8Array) || result.bytes.length === 0 || result.bytes.length > TASK_IMAGE_LIMIT_BYTES) {
      refuse(response, result?.ok === true ? "unavailable" : fixedError(result));
      return;
    }
    response.writeHead(200, { "Content-Type": mediaType, "Content-Length": String(result.bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(result.bytes);
  } catch {
    refuse(response, "unavailable");
  }
}
