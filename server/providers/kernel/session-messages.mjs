import crypto from "node:crypto";
import fs from "node:fs";
import { sessionMessageRequestSchema, sessionMessagePageSchema } from "../provider-contract.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";

export function messageText(text) {
  const marker = "\n[truncated]";
  return text.length <= 32000 ? text : text.slice(0, 32000 - marker.length) + marker;
}

export function messageTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

// Ordinal offsets also address multiple visible blocks in a single JSONL record.
// Fingerprints bind source identity and all bytes previously read, including gaps.
function sourceHash(identity) { return crypto.createHash("sha256").update(`${identity}\0`); }
async function prefixFingerprint(descriptor, source, size) {
  const hash = sourceHash(source.identity);
  const buffer = Buffer.alloc(64 * 1024);
  for (let offset = 0; offset < size;) {
    const bytes = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytes) throw new Error("Session history unavailable");
    hash.update(buffer.subarray(0, bytes));
    offset += bytes;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return `${size}:${hash.digest("hex")}`;
}

// One request owns this reader and its page; no observation cache or publisher sees text.
export async function readSessionMessages(file, request, classify) {
  const { cursor, before, limit } = sessionMessageRequestSchema.parse(request);
  const missing = { messages: [], cursor: null, older: null, reset: false, status: "missing" };
  const source = incrementalSourceDescriptor(file);
  if (!source) return missing;
  let descriptor;
  try { descriptor = fs.openSync(file, "r"); } catch (error) {
    if (error.code === "ENOENT") return missing;
    throw new Error("Session history unavailable");
  }
  try {
    const position = cursor || before;
    const previousSize = Number(position?.fingerprint.split(":")[0]);
    const reset = Boolean(position && (!Number.isSafeInteger(previousSize) || previousSize < 0 || previousSize > source.size
      || await prefixFingerprint(descriptor, source, previousSize) !== position.fingerprint));
    const after = !reset && cursor ? cursor.offset : null;
    const end = !reset && before ? before.offset : Infinity;
    const page = [];
    let count = 0;
    const hash = sourceHash(source.identity);
    const ingestor = createIncrementalJsonlIngestor({
      readChunk(offset, bytes) {
        const buffer = Buffer.alloc(bytes);
        const read = fs.readSync(descriptor, buffer, 0, bytes, offset);
        hash.update(buffer.subarray(0, read));
        return buffer.subarray(0, read);
      },
      parseRecord: (line) => JSON.parse(line.toString("utf8")),
      initialState: () => null,
      reduce(state, record) {
        for (const item of classify(record)) {
          if (item.kind === "tool-result") {
            const call = page.find((entry) => item.id && entry.id === item.id);
            if (call) call.message.outcome = item.outcome;
            continue;
          }
          const offset = count++;
          if (offset >= end || (after !== null && (offset < after || page.length >= limit))) continue;
          if (page.length === limit) page.shift();
          const { id, ...message } = item;
          page.push({ id, offset, message });
        }
        return state;
      },
    });
    await ingestor.observe(source, () => {});
    const current = incrementalSourceDescriptor(file);
    if (!current) return missing;
    if (current.identity !== source.identity || current.size < source.size
      || (current.size === source.size && current.mtimeMs !== source.mtimeMs)) throw new Error("Session history unavailable");
    const fingerprint = `${source.size}:${hash.digest("hex")}`;
    return sessionMessagePageSchema.parse({
      messages: page.map((entry) => entry.message),
      cursor: { fingerprint, offset: page.length ? page.at(-1).offset + 1 : Math.min(count, after ?? end) },
      older: page[0]?.offset > 0 ? { fingerprint, offset: page[0].offset } : null,
      reset, status: "ok",
    });
  } finally { fs.closeSync(descriptor); }
}
