"use client";

// A paired device's one write.

export async function postPairedTaskAction(repositoryId: string, action: string, payload: unknown): Promise<unknown> {
  const response = await fetch("/api/tasks/action", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryId, action, payload }),
  });
  return response.json();
}
