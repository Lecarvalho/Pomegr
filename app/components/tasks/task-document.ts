import { taskTextParts } from "../../../shared/task-contract";
import { splitTaskTitle } from "./task-tags";

/**
 * A stored task text as the read view of a started task draws it: the tags of its first line, the title line, and the rest as a
 * document of paragraphs and lists. A display heuristic, not Markdown: the text is never parsed for anything else, and it only
 * becomes React text, code spans, data-font spans and the images the text names.
 */

export type TaskDocInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  /** A UUID or an ISO date or time: drawn in the data font. */
  | { kind: "data"; text: string }
  | { kind: "image"; imageId: string };

/** `joined` is set for a block that follows the one before it with no blank line between them. */
export type TaskDocBlock =
  | { kind: "paragraph"; inlines: TaskDocInline[]; joined: boolean }
  | { kind: "ordered"; start: number; items: TaskDocInline[][]; joined: boolean }
  | { kind: "bullets"; items: TaskDocInline[][]; joined: boolean };

export type TaskDocument = { tags: string[]; title: TaskDocInline[]; blocks: TaskDocBlock[] };

const CODE = /`([^`\n]+)`/gu;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// A date, then optionally a time (or a time range), a zone, and the word UTC.
const MOMENT = "\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:\\s?[\\u2013-]\\s?\\d{2}:\\d{2}(?::\\d{2})?)?(?:Z|[+-]\\d{2}:\\d{2})?)?(?: UTC)?";
const DATA = new RegExp(`(?<![\\w-])(?:${UUID}|${MOMENT})(?![\\w-])`, "giu");
const ORDERED = /^\s{0,3}(\d{1,3})[.)][ \t]+(\S.*)$/u;
const BULLET = /^\s{0,3}[-*]\s+(\S.*)$/u;
const CONTINUATION = /^\s{2,}\S/u;

function pushData(out: TaskDocInline[], text: string) {
  let at = 0;
  for (const match of text.matchAll(DATA)) {
    if (match.index > at) out.push({ kind: "text", text: text.slice(at, match.index) });
    out.push({ kind: "data", text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
}

/** One line or run of text as inline parts: images, backtick code, and UUIDs and ISO dates in the data font. */
export function taskInlines(text: string): TaskDocInline[] {
  const out: TaskDocInline[] = [];
  for (const part of taskTextParts(text)) {
    if ("imageId" in part) {
      out.push({ kind: "image", imageId: part.imageId });
      continue;
    }
    let at = 0;
    for (const match of part.text.matchAll(CODE)) {
      pushData(out, part.text.slice(at, match.index));
      out.push({ kind: "code", text: match[1] });
      at = match.index + match[0].length;
    }
    pushData(out, part.text.slice(at));
  }
  return out;
}

type Draft =
  | { kind: "paragraph"; lines: string[]; joined: boolean }
  | { kind: "ordered"; start: number; items: string[]; joined: boolean }
  | { kind: "bullets"; items: string[]; joined: boolean };

function finish(draft: Draft): TaskDocBlock {
  if (draft.kind === "paragraph") return { kind: "paragraph", inlines: taskInlines(draft.lines.join("\n")), joined: draft.joined };
  if (draft.kind === "ordered") return { kind: "ordered", start: draft.start, items: draft.items.map(taskInlines), joined: draft.joined };
  return { kind: "bullets", items: draft.items.map(taskInlines), joined: draft.joined };
}

/** The rest of a text as blocks: paragraphs split on blank lines, numbered and bulleted lists, and single line breaks and indentation kept. */
export function taskBlocks(rest: string): TaskDocBlock[] {
  const blocks: TaskDocBlock[] = [];
  const open: { draft: Draft | null } = { draft: null };
  let blank = true;
  const flush = () => {
    if (open.draft) blocks.push(finish(open.draft));
    open.draft = null;
  };
  for (const line of rest.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trim() === "") {
      flush();
      blank = true;
      continue;
    }
    const draft = open.draft;
    const joined = !blank && (blocks.length > 0 || draft !== null);
    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered) {
      if (draft?.kind === "ordered") draft.items.push(ordered[2]);
      else { flush(); open.draft = { kind: "ordered", start: Number(ordered[1]), items: [ordered[2]], joined }; }
    } else if (bullet) {
      if (draft?.kind === "bullets") draft.items.push(bullet[1]);
      else { flush(); open.draft = { kind: "bullets", items: [bullet[1]], joined }; }
    } else if (draft && draft.kind !== "paragraph" && CONTINUATION.test(line)) {
      // An indented line goes on with the list item above it.
      draft.items[draft.items.length - 1] += `\n${line.trim()}`;
    } else if (draft?.kind === "paragraph") {
      draft.lines.push(line.trimEnd());
    } else {
      flush();
      open.draft = { kind: "paragraph", lines: [line.trimEnd()], joined };
    }
    blank = false;
  }
  flush();
  return blocks;
}

/** A stored text for the read view. The title is the shared rule's (`splitTaskTitle`), the one a card shows: the first non-empty line without its tags. */
export function taskDocument(text: string): TaskDocument {
  const { tags, title, rest } = splitTaskTitle(text);
  return { tags, title: taskInlines(title), blocks: taskBlocks(rest) };
}
