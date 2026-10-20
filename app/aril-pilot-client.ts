import type { ArilPilot, ArilPilotActivation, ArilPilotOperation, ArilPilotPayload, ArilPilotResult } from "../shared/aril-pilot-contract";
import { clientAccessMode } from "./hooks/ClientAccessContext";

export type ArilPilotDesktopBridge = {
  arilPilot(operation: ArilPilotOperation, payload: ArilPilotPayload): Promise<unknown>;
};

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const PILOT_STATES = new Set(["active", "paused", "revoked", "expired", "finished", "needs_you"]);

export function arilPilotBridge(): ArilPilotDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: Partial<ArilPilotDesktopBridge> }).pomegrDesktop;
  return typeof bridge?.arilPilot === "function" ? bridge as ArilPilotDesktopBridge : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRun(value: unknown): boolean {
  return isRecord(value) && (value.provider === "claude" || value.provider === "codex")
    && (value.model === null || (typeof value.model === "string" && value.model.length <= 120));
}

function isPilot(value: unknown): value is ArilPilot {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && Number.isInteger(value.revision)
    && typeof value.repositoryId === "string" && REPOSITORY_ID.test(value.repositoryId)
    && typeof value.goal === "string" && value.goal.length <= 2000 && Array.isArray(value.taskIds) && value.taskIds.length <= 32 && value.taskIds.every((id) => typeof id === "string" && TASK_ID.test(id))
    && typeof value.expiresAt === "string" && typeof value.status === "string" && PILOT_STATES.has(value.status)
    && Number.isInteger(value.roundLimit) && Number(value.roundLimit) >= 1 && Number(value.roundLimit) <= 100
    && Number.isInteger(value.startLimit) && Number(value.startLimit) >= 1 && Number(value.startLimit) <= 32
    && Number.isInteger(value.concurrency) && Number(value.concurrency) >= 1 && Number(value.concurrency) <= Math.min(4, Number(value.startLimit))
    && Number.isInteger(value.minIntervalMinutes) && Number(value.minIntervalMinutes) >= 5 && Number(value.minIntervalMinutes) <= 1440
    && Array.isArray(value.allowedRuns) && value.allowedRuns.length >= 1 && value.allowedRuns.length <= 32 && value.allowedRuns.every(isRun)
    && isRun(value.inference) && Number.isInteger(value.roundsUsed) && Number.isInteger(value.startsUsed)
    && (value.nextWakeAt === null || typeof value.nextWakeAt === "string")
    && (value.waiting === null || typeof value.waiting === "string")
    && Array.isArray(value.receipts) && value.receipts.every((receipt) => isRecord(receipt)
      && typeof receipt.at === "string" && (receipt.taskId === null || (typeof receipt.taskId === "string" && TASK_ID.test(receipt.taskId)))
      && typeof receipt.action === "string" && typeof receipt.status === "string"
      && (receipt.provider === null || typeof receipt.provider === "string")
      && (receipt.model === null || typeof receipt.model === "string") && typeof receipt.reason === "string"
      && typeof receipt.evidenceRevision === "string")
    && (value.summary === null || typeof value.summary === "string");
}

function validateResult(value: unknown): ArilPilotResult {
  if (!isRecord(value)) return { ok: false, error: "unavailable" };
  if (value.ok === true && (value.pilot === null || isPilot(value.pilot))
    && (value.history === undefined || (Array.isArray(value.history) && value.history.every(isPilot)))) return value as ArilPilotResult;
  if (value.ok === false && ["invalid", "conflict", "limit", "unavailable", "desktop_only"].includes(String(value.error))) {
    return value as ArilPilotResult;
  }
  return { ok: false, error: "unavailable" };
}

export async function callArilPilot(operation: ArilPilotOperation, payload: ArilPilotPayload): Promise<ArilPilotResult> {
  const bridge = arilPilotBridge();
  if (!bridge && (typeof window === "undefined" || clientAccessMode() !== "lan")) return { ok: false, error: "desktop_only" };
  if (!isRecord(payload) || typeof payload.repositoryId !== "string" || !REPOSITORY_ID.test(payload.repositoryId)) return { ok: false, error: "invalid" };
  try {
    if (bridge) return validateResult(await bridge.arilPilot(operation, payload));
    const body = JSON.stringify({ operation, payload });
    if (new TextEncoder().encode(body).byteLength > 17 * 1024) return { ok: false, error: "invalid" };
    const response = await fetch("/api/aril-pilot", {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body,
    });
    if (!response.ok) return { ok: false, error: "unavailable" };
    return validateResult(await response.json());
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export function activateArilPilot(payload: ArilPilotActivation): Promise<ArilPilotResult> {
  return callArilPilot("activate", payload);
}
