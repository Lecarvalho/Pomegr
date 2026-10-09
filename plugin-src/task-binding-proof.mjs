import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Proof that the Pomegr PreToolUse hook, and not the model, set a task tool's `session_ref`.
 * The hook signs the tool name, the session reference, and the issue time with the local
 * agent-query capability token; the Claude MCP server verifies it with the same token read
 * from the descriptor at call time. The token is only ever an HMAC key here: it is never
 * returned, logged, or put in a message. Both sides import this one module.
 */
const PREFIX = "pomegr-task-binding/v1";
/** A proof older than this, or issued more than FUTURE_SKEW_MS ahead of the verifier, is refused. */
export const TASK_BINDING_PROOF_WINDOW_MS = 60_000;
export const TASK_BINDING_PROOF_FUTURE_SKEW_MS = 5_000;
const TOOL = /^[a-z][a-z_]{0,31}$/u;
const SESSION_REF = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;
const PROOF = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/u;

function mac(token, tool, sessionRef, issuedAt) {
  return createHmac("sha256", token).update(`${PREFIX}\n${tool}\n${sessionRef}\n${issuedAt}`, "utf8").digest("base64url");
}

function usable(token, tool, sessionRef) {
  return typeof token === "string" && token.length > 0 && typeof tool === "string" && TOOL.test(tool)
    && typeof sessionRef === "string" && SESSION_REF.test(sessionRef);
}

/** `<issuedAtMs>.<base64url HMAC-SHA256>`, or null when an input is unusable. */
export function createTaskBindingProof(input) {
  const { token, tool, sessionRef, now = Date.now() } = input ?? {};
  if (!usable(token, tool, sessionRef) || !Number.isSafeInteger(now) || now < 1e9 || now > 1e16) return null;
  return `${now}.${mac(token, tool, sessionRef, now)}`;
}

/** True only for a well-formed, fresh proof made with this token for this tool and session. Never throws. */
export function verifyTaskBindingProof(input) {
  try {
    const { token, tool, sessionRef, proof, now = Date.now() } = input ?? {};
    if (!usable(token, tool, sessionRef) || typeof proof !== "string" || proof.length > 64 || !Number.isFinite(now)) return false;
    const match = PROOF.exec(proof);
    if (!match) return false;
    const issuedAt = Number(match[1]);
    if (!Number.isSafeInteger(issuedAt)) return false;
    const age = now - issuedAt;
    if (age > TASK_BINDING_PROOF_WINDOW_MS || age < -TASK_BINDING_PROOF_FUTURE_SKEW_MS) return false;
    const given = Buffer.from(match[2], "utf8");
    const expected = Buffer.from(mac(token, tool, sessionRef, match[1]), "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}
