import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePomegrDataRoot } from "../shared/pomegr-paths.mjs";

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function sessionCostRoot() {
  return process.env.POMEGR_COST_SNAPSHOTS_DIR || path.join(resolvePomegrDataRoot({ homeDir: os.homedir() }), "cost-snapshots");
}

function snapshotPath(sessionId, root = sessionCostRoot()) {
  if (!SAFE_SESSION_ID.test(String(sessionId || ""))) return null;
  return path.join(root, `${sessionId}.json`);
}

export function captureClaudeStatuslineCost(input, options = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const rawAmount = input?.cost?.total_cost_usd;
  const amount = typeof rawAmount === "number" ? rawAmount : Number.NaN;
  const file = snapshotPath(sessionId, options.root);
  if (!file || !Number.isFinite(amount) || amount < 0) return null;

  const snapshot = {
    version: 1,
    sessionId,
    amount,
    currency: "USD",
    type: "estimated",
    observedAt: (options.now || new Date()).toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  return snapshot;
}

export function readSessionCost(sessionId, options = {}) {
  const file = snapshotPath(sessionId, options.root);
  if (!file) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    const amount = Number(snapshot.amount);
    const observedAt = new Date(snapshot.observedAt);
    if (snapshot.sessionId !== sessionId || snapshot.currency !== "USD" || snapshot.type !== "estimated") return null;
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(observedAt.getTime())) return null;
    return { amount, currency: "USD", type: "estimated", observedAt: observedAt.toISOString() };
  } catch {
    return null;
  }
}
