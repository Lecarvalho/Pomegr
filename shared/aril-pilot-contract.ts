export type ArilPilotProvider = "claude" | "codex";

export type ArilPilotRun = {
  provider: ArilPilotProvider;
  model: string | null;
};

export type ArilPilotReceipt = {
  at: string;
  taskId: string | null;
  action: string;
  status: string;
  provider: string | null;
  model: string | null;
  reason: string;
  evidenceRevision: string;
};

export type ArilPilot = {
  id: string;
  revision: number;
  repositoryId: string;
  goal: string;
  taskIds: string[];
  expiresAt: string;
  status: "active" | "paused" | "revoked" | "expired" | "finished" | "needs_you";
  roundLimit: number;
  startLimit: number;
  concurrency: number;
  minIntervalMinutes: number;
  allowedRuns: ArilPilotRun[];
  inference: ArilPilotRun;
  roundsUsed: number;
  startsUsed: number;
  nextWakeAt: string | null;
  waiting: string | null;
  receipts: ArilPilotReceipt[];
  summary: string | null;
};

export type ArilPilotOperation = "read" | "activate" | "pause" | "revoke";

export type ArilPilotActivation = {
  repositoryId: string;
  goal: string;
  taskIds: string[];
  durationHours: number;
  roundLimit: number;
  startLimit: number;
  concurrency: number;
  minIntervalMinutes: number;
  allowedRuns: ArilPilotRun[];
  inference: ArilPilotRun;
};

export type ArilPilotPayload = { repositoryId: string } | ArilPilotActivation;

export type ArilPilotResult =
  | { ok: true; pilot: ArilPilot | null; history?: ArilPilot[] }
  | { ok: false; error: "invalid" | "conflict" | "limit" | "unavailable" | "desktop_only" };
