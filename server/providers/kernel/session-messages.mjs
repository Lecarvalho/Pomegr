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

const WINDOW_BYTES = 256 * 1024;
const reads = new Map();
const missing = () => ({ messages: [], cursor: null, older: null, reset: false, status: "missing" });

// Only completion gates live between requests, never an answer or transcript data.
export async function readSessionMessages(file, request, classify) {
  sessionMessageRequestSchema.parse(request);
  if (!file) return missing();
  const previous = reads.get(file);
  let release = () => {};
  const done = new Promise((resolve) => { release = () => resolve(undefined); });
  reads.set(file, done);
  await previous;
  try { return await readPage(file, request, classify); }
  finally { release(); if (reads.get(file) === done) reads.delete(file); }
}

function sourceDescriptor(file, stat) {
  return incrementalSourceDescriptor(file, false, { stat, suffix: { bytes: 0, digest: "" } });
}

function readBytes(descriptor, offset, length) {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, length, offset));
}

function cursorProof(descriptor, identity, offset) {
  const tail = readBytes(descriptor, Math.max(0, offset - 256), Math.min(offset, 256));
  const digest = crypto.createHash("sha256").update(tail).digest("hex");
  return {
    cursor: { fingerprint: crypto.createHash("sha256").update(`${identity}\0${offset}\0${digest}`).digest("hex"), offset },
    boundary: offset === 0 || tail.at(-1) === 0x0a,
    tail,
  };
}

// Seed only when the fixed-size validation sample contains the entire preceding record.
function seedClassifier(classify, proof) {
  classify.reset?.();
  const tail = proof.tail;
  const start = tail.lastIndexOf(0x0a, tail.length - 2) + 1;
  if (!start && proof.cursor.offset > tail.length) return;
  try {
    const items = classify(JSON.parse(tail.subarray(start).toString("utf8")));
    while (!items.next().done) { /* seed classifier state without retaining messages */ }
  }
  catch { /* no complete preceding record in this sample */ }
}

async function scan(descriptor, source, from, end, classify, visit, shouldStop, window = null) {
  let completeOffset = from;
  const ingestor = createIncrementalJsonlIngestor({
    readChunk(offset, bytes) {
      return window && offset >= window.start && offset + bytes <= window.start + window.bytes.length
        ? window.bytes.subarray(offset - window.start, offset - window.start + bytes)
        : readBytes(descriptor, offset, bytes);
    },
    parseRecord(line, bounds) { completeOffset = bounds.endOffset; return JSON.parse(line.toString("utf8")); },
    initialState: () => null,
    reduce(state, record, bounds) { visit(classify(record), bounds); return state; },
    shouldStop,
  });
  ingestor.restore({ identity: source.identity, completeOffset: from });
  await ingestor.observe({ identity: source.identity, size: end }, () => {});
  return completeOffset;
}

// Locate whole records by walking backward, retaining only bounded page offsets.
async function newestStart(descriptor, source, end, limit, classify) {
  const groups = [];
  let count = 0, scanEnd = end, searchEnd = end, discarded = false;
  while (searchEnd > 0 && count < limit) {
    const start = Math.max(0, searchEnd - WINDOW_BYTES);
    const bytes = readBytes(descriptor, start, searchEnd - start);
    const newline = bytes.indexOf(0x0a);
    const aligned = start === 0 ? 0 : newline < 0 ? searchEnd : start + newline + 1;
    if (aligned < scanEnd) {
      const earlier = [];
      let earlierCount = 0;
      classify.reset?.();
      await scan(descriptor, source, aligned, scanEnd, classify, (items, bounds) => {
        let size = 0;
        for (const item of items) if (item.kind !== "tool-result") size += 1;
        if (!size) return;
        earlier.push({ start: bounds.startOffset, size });
        earlierCount += size;
        while (earlier.length > 1 && earlierCount - earlier[0].size >= limit) { earlierCount -= earlier.shift().size; discarded = true; }
      }, undefined, { start, bytes });
      groups.unshift(...earlier);
      count += earlierCount;
      while (groups.length > 1 && count - groups[0].size >= limit) { count -= groups.shift().size; discarded = true; }
      scanEnd = aligned;
    }
    searchEnd = start;
  }
  // The answer schema remains capped even when the requested limit falls within a record.
  while (groups.length > 1 && count > 200) { count -= groups.shift().size; discarded = true; }
  return scanEnd === 0 && !discarded ? 0 : groups[0]?.start ?? 0;
}

async function readPage(file, { cursor, before, limit }, classify) {
  let descriptor;
  try { descriptor = fs.openSync(file, "r"); } catch (error) {
    if (error.code === "ENOENT") return missing();
    throw new Error("Session history unavailable");
  }
  try {
    const source = sourceDescriptor(file, fs.fstatSync(descriptor));
    if (!source) return missing();
    const position = cursor || before;
    const proof = position && position.offset <= source.size ? cursorProof(descriptor, source.identity, position.offset) : null;
    const reset = Boolean(position && (!proof?.boundary || proof.cursor.fingerprint !== position.fingerprint));
    const forward = Boolean(cursor && !reset);
    const end = before && !reset ? before.offset : source.size;
    const start = forward ? cursor.offset : await newestStart(descriptor, source, end, limit, classify);
    seedClassifier(classify, forward ? proof : cursorProof(descriptor, source.identity, start));
    const page = [];
    let stopped = false, excludedAt = null, oversized = false;
    const completeOffset = await scan(descriptor, source, start, end, classify, (items, bounds) => {
      const record = [];
      for (const item of items) {
        if (item.kind === "tool-result") {
          const call = page.find((entry) => item.id && entry.id === item.id);
          if (call) call.message.outcome = item.outcome;
        } else {
          if (record.length === 200) { oversized = true; stopped = true; return; }
          const { id, ...message } = item;
          record.push({ id, message });
        }
      }
      if (page.length + record.length > 200) { excludedAt = bounds.startOffset; stopped = true; return; }
      page.push(...record);
      if (forward && page.length >= limit) stopped = true;
    }, () => stopped);
    if (oversized) throw new Error("Session history record exceeds page capacity");
    let current;
    try { current = sourceDescriptor(file, fs.statSync(file)); } catch (error) { if (error.code === "ENOENT") return missing(); throw error; }
    if (!current || current.identity !== source.identity || current.size < source.size
      || (current.size === source.size && current.mtimeMs !== source.mtimeMs)) throw new Error("Session history unavailable");
    return sessionMessagePageSchema.parse({
      messages: page.map((entry) => entry.message),
      cursor: cursorProof(descriptor, source.identity, excludedAt ?? completeOffset).cursor,
      older: start > 0 ? cursorProof(descriptor, source.identity, start).cursor : null,
      reset, status: "ok",
    });
  } finally { fs.closeSync(descriptor); }
}

