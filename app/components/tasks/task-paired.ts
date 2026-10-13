"use client";

// Fixed writes from a paired device.

export async function postPairedTaskAction(repositoryId: string, action: string, payload: unknown): Promise<unknown> {
  const response = await fetch("/api/tasks/action", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryId, action, payload }),
  });
  return response.json();
}

export async function postPairedTaskStart(repositoryId: string, taskId: string, separateWorktree: boolean): Promise<unknown> {
  const response = await fetch("/api/tasks/start", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryId, taskId, confirmed: true, ...(separateWorktree ? { worktree: true } : {}) }),
  });
  if (!response.ok) return { status: "unavailable" };
  return response.json();
}

/** The fixed error names a paired image route answers with. */
export type PairedImageAnswer = { ok: true; imageId?: string; type?: string; bytes?: Uint8Array } | { ok: false; error: string };

const imageQuery = (repositoryId: string, taskId: string, imageId: string) => new URLSearchParams({ repositoryId, taskId, imageId }).toString();

async function answerOf(response: Response): Promise<PairedImageAnswer> {
  if (response.headers.get("content-type")?.startsWith("application/json")) return await response.json() as PairedImageAnswer;
  return { ok: false, error: "unavailable" };
}

export async function postPairedTaskImageAdd(repositoryId: string, taskId: string, imageId: string, bytes: Uint8Array): Promise<PairedImageAnswer> {
  const response = await fetch(`/api/tasks/image-add?${imageQuery(repositoryId, taskId, imageId)}`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([new Uint8Array(bytes)]),
  });
  return answerOf(response);
}

export async function postPairedTaskImageRemove(repositoryId: string, taskId: string, imageId: string): Promise<PairedImageAnswer> {
  const response = await fetch("/api/tasks/image-remove", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryId, taskId, imageId }),
  });
  return answerOf(response);
}

export async function getPairedTaskImage(repositoryId: string, taskId: string, imageId: string): Promise<PairedImageAnswer> {
  const response = await fetch(`/api/tasks/image-read?${imageQuery(repositoryId, taskId, imageId)}`, { cache: "no-store" });
  if (!response.ok) return { ok: false, error: "unavailable" };
  const type = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("application/json")) return answerOf(response);
  return { ok: true, type, bytes: new Uint8Array(await response.arrayBuffer()) };
}
