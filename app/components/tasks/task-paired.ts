"use client";

// A paired device's one write: a fixed task action sent to `POST /api/tasks/action`, which only the desktop's LAN
// gateway forwards. The answer is a fixed result, never the board: the client reads the board again through
// GET /api/tasks. Task content stays in memory: never in browser storage or a URL.

/** Posts one fixed action and answers the route's body unread; the caller validates it. Throws when the request fails. */
export async function postPairedTaskAction(repositoryId: string, action: string, payload: unknown): Promise<unknown> {
  const response = await fetch("/api/tasks/action", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryId, action, payload }),
  });
  return response.json();
}
