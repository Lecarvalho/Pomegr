import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePomegrDataRoot } from "./pomegr-paths.mjs";
import {
  AGENT_QUERY_AUTH_HEADER,
  requireDesktopToken,
  tokensMatch,
} from "./local-auth.mjs";

export { AGENT_QUERY_AUTH_HEADER };

export const AGENT_QUERY_DESCRIPTOR_VERSION = 1;
export const AGENT_QUERY_DESCRIPTOR_FILENAME = "agent-query-runtime.json";
export const AGENT_QUERY_DEFAULT_ORIGIN = "http://127.0.0.1:4317";
export const AGENT_QUERY_TIMEOUT_MS = 2_000;
export const AGENT_QUERY_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_DESCRIPTOR_BYTES = 4 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loopbackOrigin(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash
    || !["127.0.0.1", "[::1]"].includes(parsed.hostname)
    || !parsed.port) return null;
  return parsed.origin;
}

export function createAgentQueryCapability(randomBytesFn = randomBytes) {
  const bytes = randomBytesFn(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error("AGENT_QUERY_CAPABILITY_INVALID");
  return requireDesktopToken(bytes.toString("base64url"), "AGENT_QUERY_CAPABILITY_INVALID");
}

export function resolveAgentQueryDescriptorPath(dataRoot = resolvePomegrDataRoot()) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw new Error("AGENT_QUERY_DATA_ROOT_INVALID");
  return path.join(path.resolve(dataRoot), AGENT_QUERY_DESCRIPTOR_FILENAME);
}

export function normalizeAgentQueryDescriptor(value) {
  if (!isRecord(value) || value.version !== AGENT_QUERY_DESCRIPTOR_VERSION) return null;
  const origin = loopbackOrigin(value.origin);
  if (!origin) return null;
  let token;
  try { token = requireDesktopToken(value.token, "AGENT_QUERY_DESCRIPTOR_INVALID"); } catch { return null; }
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "origin", "token"].includes(key))) return null;
  return Object.freeze({ version: AGENT_QUERY_DESCRIPTOR_VERSION, origin, token });
}

export async function inspectAgentQueryDescriptor({
  dataRoot,
  descriptorPath,
  readFileFn = readFile,
  statFn = stat,
  maxBytes = MAX_DESCRIPTOR_BYTES,
} = {}) {
  const target = descriptorPath || resolveAgentQueryDescriptorPath(dataRoot);
  try {
    const info = await statFn(target);
    if (!info?.isFile?.() || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > maxBytes) {
      return { descriptor: null, status: "invalid" };
    }
    const body = await readFileFn(target, "utf8");
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > maxBytes) return { descriptor: null, status: "invalid" };
    const descriptor = normalizeAgentQueryDescriptor(JSON.parse(body));
    return descriptor ? { descriptor, status: "valid" } : { descriptor: null, status: "invalid" };
  } catch (error) {
    return { descriptor: null, status: error?.code === "ENOENT" ? "missing" : "unavailable" };
  }
}

export async function readAgentQueryDescriptor(options = {}) {
  return (await inspectAgentQueryDescriptor(options)).descriptor;
}

export async function publishAgentQueryDescriptor({
  dataRoot,
  descriptorPath,
  origin,
  token,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
  renameFn = rename,
  randomUUIDFn = randomUUID,
} = {}) {
  const target = descriptorPath || resolveAgentQueryDescriptorPath(dataRoot);
  const descriptor = normalizeAgentQueryDescriptor({ version: AGENT_QUERY_DESCRIPTOR_VERSION, origin, token });
  if (!descriptor) throw new Error("AGENT_QUERY_DESCRIPTOR_INVALID");
  const body = `${JSON.stringify(descriptor)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_DESCRIPTOR_BYTES) throw new Error("AGENT_QUERY_DESCRIPTOR_TOO_LARGE");
  await mkdirFn(path.dirname(target), { recursive: true });
  const temporary = `${target}.${String(randomUUIDFn())}.tmp`;
  try {
    await writeFileFn(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await renameFn(temporary, target);
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return descriptor;
}

export async function removeAgentQueryDescriptorIfTokenMatches({
  dataRoot,
  descriptorPath,
  token,
  readDescriptorFn = readAgentQueryDescriptor,
  unlinkFn = rm,
} = {}) {
  let expected;
  try { expected = requireDesktopToken(token, "AGENT_QUERY_CAPABILITY_INVALID"); } catch { return false; }
  const target = descriptorPath || resolveAgentQueryDescriptorPath(dataRoot);
  const descriptor = await readDescriptorFn({ descriptorPath: target });
  if (!descriptor || !tokensMatch(descriptor.token, expected)) return false;
  try {
    await unlinkFn(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function responseBufferLimit(response, maxBytes) {
  const length = Number(response.headers?.get?.("content-length"));
  return Number.isSafeInteger(length) && length >= 0 && length > maxBytes;
}

async function readResponseText(response, maxBytes) {
  if (responseBufferLimit(response, maxBytes)) throw new Error("AGENT_QUERY_RESPONSE_TOO_LARGE");
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("AGENT_QUERY_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value?.byteLength || 0;
      if (size > maxBytes) throw new Error("AGENT_QUERY_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* body cleanup is best effort */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Fetch one read-only agent query using the packaged descriptor when present.
 * Development falls back to the fixed unauthenticated loopback monitor.
 */
export async function fetchAgentQuery(pathname, {
  dataRoot,
  descriptorPath,
  fetchFn = fetch,
  readFileFn,
  statFn,
  timeoutMs = AGENT_QUERY_TIMEOUT_MS,
  maxBytes = AGENT_QUERY_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof pathname !== "string" || !pathname.startsWith("/api/agent/v1/")) {
    throw new Error("AGENT_QUERY_PATH_INVALID");
  }
  const descriptorState = await inspectAgentQueryDescriptor({ dataRoot, descriptorPath, readFileFn, statFn });
  if (descriptorState.status === "invalid" || descriptorState.status === "unavailable") {
    return { response: null, body: null, text: "", error: "monitor_unavailable" };
  }
  const descriptor = descriptorState.descriptor;
  const origin = descriptor?.origin || AGENT_QUERY_DEFAULT_ORIGIN;
  const headers = descriptor?.token ? { [AGENT_QUERY_AUTH_HEADER]: descriptor.token } : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchFn(`${origin}${pathname}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readResponseText(response, maxBytes);
    let body = null;
    try { body = JSON.parse(text); } catch { /* caller receives bounded malformed result */ }
    return { response, body, text };
  } catch {
    return { response: null, body: null, text: "", error: "monitor_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Adapter shape consumed by the MCP tool registry: (path, query params) => JSON body. */
export function createAgentQueryReader(options = {}) {
  return async (pathname, params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
    const suffix = query.toString();
    const result = await fetchAgentQuery(`${pathname}${suffix ? `?${suffix}` : ""}`, options);
    if (result.error || !result.response?.ok) throw new Error("AGENT_QUERY_UNAVAILABLE");
    return result.body;
  };
}

export function defaultAgentQueryDataRoot(environment = process.env) {
  return resolvePomegrDataRoot({ environment, homeDir: os.homedir() });
}
