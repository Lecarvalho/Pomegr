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
