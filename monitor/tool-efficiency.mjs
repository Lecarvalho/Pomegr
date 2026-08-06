import crypto from "node:crypto";
import path from "node:path";

export const CONCURRENT_MUTATION_WINDOW_MS = 30_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function normalizedTarget(input = {}) {
  const target = input.file_path || input.path;
  return typeof target === "string" ? path.normalize(target).toLowerCase() : "";
}

// Exact inputs stay monitor-side and are represented only by a digest. This keeps
// separate file regions and search windows distinct without exposing their content.
export function repetitionSignature(tool, input = {}) {
  return `${String(tool).toLowerCase()}:${digest(JSON.stringify(stableValue(input)))}`;
}

export function mutationScopes(tool, input = {}) {
  const normalizedTool = String(tool).toLowerCase();
  const target = normalizedTarget(input);
  if (!target) return [];

  if (normalizedTool === "edit") {
    return typeof input.old_string === "string"
      ? [`${target}:anchor:${digest(input.old_string)}`]
      : [];
  }
  if (normalizedTool === "multiedit" && Array.isArray(input.edits)) {
    return input.edits.flatMap((edit) => typeof edit?.old_string === "string"
      ? [`${target}:anchor:${digest(edit.old_string)}`]
      : []);
  }
  if (normalizedTool === "write") return [`${target}:whole-file`];
  if (normalizedTool === "notebookedit") {
    const cell = input.cell_id ?? input.cell_number;
    return cell === undefined ? [] : [`${target}:cell:${digest(cell)}`];
  }
  return [];
}

export function concurrentMutationOverlaps(events, windowMs = CONCURRENT_MUTATION_WINDOW_MS) {
  const byScope = new Map();
  for (const event of events) {
    for (const scope of event.scopes || []) {
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push(event);
    }
  }

  const overlapsByTarget = new Map();
  for (const scopedEvents of byScope.values()) {
    const sorted = scopedEvents.toSorted((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const colliding = new Set();
    for (let left = 0; left < sorted.length; left += 1) {
      for (let right = left + 1; right < sorted.length; right += 1) {
        const delta = new Date(sorted[right].timestamp) - new Date(sorted[left].timestamp);
        if (delta > windowMs) break;
        if (sorted[left].actorId !== sorted[right].actorId) {
          colliding.add(sorted[left]);
          colliding.add(sorted[right]);
        }
      }
    }
    if (!colliding.size) continue;
    const calls = [...colliding];
    const display = calls[0].display;
    if (!overlapsByTarget.has(display)) overlapsByTarget.set(display, { display, actors: new Set(), events: new Set() });
    const overlap = overlapsByTarget.get(display);
    for (const event of calls) {
      overlap.actors.add(event.actorId);
      overlap.events.add(event);
    }
  }
  return [...overlapsByTarget.values()].map(({ display, actors, events }) => ({ display, actors, calls: events.size }));
}
