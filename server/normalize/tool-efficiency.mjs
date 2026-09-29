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

function normalizedPath(value) {
  return typeof value === "string" && value.trim()
    ? path.normalize(value.trim()).toLowerCase()
    : "";
}

function patchSections(patch) {
  if (typeof patch !== "string") return [];
  const sections = [];
  let current = null;
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/);
    if (header) {
      current = { kind: header[1].toLowerCase(), path: header[2], movePath: "", lines: [] };
      sections.push(current);
      continue;
    }
    const move = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (current && move) current.movePath = move[1];
    else if (current) current.lines.push(line);
  }
  return sections;
}

function diffScopes(target, diff) {
  if (typeof diff !== "string" || !diff) return [`${target}:whole-file`];
  const hunks = diff.split(/(?=^@@)/m).filter((part) => part.startsWith("@@"));
  return (hunks.length ? hunks : [diff]).map((hunk) => `${target}:anchor:${digest(hunk)}`);
}

// Exact inputs stay monitor-side and are represented only by a digest. This keeps
// separate file regions and search windows distinct without exposing their content.
export function repetitionSignature(tool, input = {}) {
  return `${String(tool).toLowerCase()}:${digest(JSON.stringify(stableValue(input)))}`;
}

export function mutationScopes(tool, input = {}) {
  const normalizedTool = String(tool).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalizedTarget(input);

  if (normalizedTool === "edit") {
    if (!target) return [];
    return typeof input.old_string === "string"
      ? [`${target}:anchor:${digest(input.old_string)}`]
      : [];
  }
  if (normalizedTool === "multiedit" && Array.isArray(input.edits)) {
    if (!target) return [];
    return input.edits.flatMap((edit) => typeof edit?.old_string === "string"
      ? [`${target}:anchor:${digest(edit.old_string)}`]
      : []);
  }
  if (normalizedTool === "write") return target ? [`${target}:whole-file`] : [];
  if (normalizedTool === "notebookedit") {
    if (!target) return [];
    const cell = input.cell_id ?? input.cell_number;
    return cell === undefined ? [] : [`${target}:cell:${digest(cell)}`];
  }
  if (normalizedTool === "applypatch") {
    return patchSections(input.patch ?? input.input).flatMap((section) => {
      const sectionTarget = normalizedPath(section.path);
      if (!sectionTarget) return [];
      const scopes = section.kind === "update"
        ? diffScopes(sectionTarget, section.lines.join("\n"))
        : [`${sectionTarget}:whole-file`];
      const movedTarget = normalizedPath(section.movePath);
      return movedTarget ? [...scopes, `${movedTarget}:whole-file`] : scopes;
    });
  }
  if (normalizedTool === "filechange" && Array.isArray(input.changes)) {
    return input.changes.flatMap((change) => {
      const changeTarget = normalizedPath(change?.path);
      if (!changeTarget) return [];
      const kind = String(change?.kind?.type ?? change?.kind ?? "").toLowerCase();
      const scopes = kind === "update" ? diffScopes(changeTarget, change?.diff) : [`${changeTarget}:whole-file`];
      const movedTarget = normalizedPath(change?.kind?.move_path ?? change?.kind?.movePath);
      return movedTarget ? [...scopes, `${movedTarget}:whole-file`] : scopes;
    });
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
    const sorted = scopedEvents.toSorted((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const colliding = new Set();
    for (let left = 0; left < sorted.length; left += 1) {
      for (let right = left + 1; right < sorted.length; right += 1) {
        const delta = new Date(sorted[right].timestamp).getTime() - new Date(sorted[left].timestamp).getTime();
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
