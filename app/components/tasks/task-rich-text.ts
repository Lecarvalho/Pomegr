import { TASK_IMAGE_ID_PATTERN, taskImageMarker, taskTextParts } from "../../../shared/task-contract";
import { splitTaskTags } from "./task-tags";

/**
 * The DOM and text rules of the rich Task field. The field's value is always one string; this module splits that string into the
 * parts the editor draws (tag chips, title line, rest) and reads the string back from the drawn nodes.
 */

const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const TAGS = "data-rich-tags";
const TITLE = "data-rich-title";

/** One tag chip: the word as typed, and the exact text it stands for (its token, and the whitespace after it up to the next token or the text, line breaks included). */
export type RichChip = { label: string; source: string };

/** The value in drawing order. `chips`, `title` and `rest` joined are the value. */
export type RichLayout = { chips: RichChip[]; title: string; rest: string };

// The leading whitespace is the parser's (`splitTaskTags` skips whatever `trimStart` does), so every text it reads tags from gets chips.
const TOKEN = /\s*\[[^\]]*\]\s*/gu;

export type RichLayoutOptions = {
  /** The field already draws chips with a title line of their own, so a line break that text follows stays between that line and the rest. */
  ownTitleLine?: boolean;
};

/**
 * Splits a task text for the editor. The leading tag run is the parser's (`splitTaskTags`), and every token of it is a chip as soon as its
 * closing bracket is there, also at the very end of the text and also when the text holds nothing but tags. A chip stands for its token and
 * the whitespace after it, line breaks included, so the title is the first text after the run. The title line ends at its line break.
 * With `ownTitleLine`, the line break after the last token belongs to the text that follows: the person emptied a title line that the field draws.
 */
export function richLayout(value: string, options: RichLayoutOptions = {}): RichLayout {
  const { tags, runLength } = splitTaskTags(value);
  let pieces: string[] = [];
  if (tags.length > 0) {
    pieces = value.slice(0, runLength).match(TOKEN) ?? [];
    if (pieces.join("") !== value.slice(0, runLength)) pieces = [];
    // The line break that the last chip takes is looked for after its closing bracket, not in the whitespace before the token.
    const last = pieces.at(-1);
    const close = last === undefined ? -1 : last.indexOf("]");
    const cut = last === undefined ? -1 : last.slice(close + 1).search(/[\r\n]/u);
    if (options.ownTitleLine && cut >= 0 && value.length > runLength) pieces[pieces.length - 1] = last!.slice(0, close + 1 + cut);
  }
  const chips: RichChip[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const label = piece.trim().slice(1, -1).trim();
    const key = label.toLowerCase();
    // A repeated word is no second chip, but its text stays in the chip it repeats, so the value reads back whole.
    if (seen.has(key) && chips.length > 0) chips[chips.length - 1].source += piece;
    else chips.push({ label, source: piece });
    seen.add(key);
  }
  const taken = chips.reduce((total, chip) => total + chip.source.length, 0);
  const text = value.slice(taken);
  const lineEnd = text.indexOf("\n");
  const title = lineEnd < 0 ? text : text.slice(0, lineEnd);
  return { chips, title, rest: text.slice(title.length) };
}

/** A pending inline image, drawn from the ID the text names. */
export function imageNode(imageId: string): HTMLImageElement {
  const node = document.createElement("img");
  node.dataset.imageId = imageId;
  node.className = "taskInlineImage isPending";
  node.src = BLANK;
  node.draggable = false;
  return node;
}

export const BLANK_IMAGE = BLANK;
export const imageNodes = (host: HTMLElement) => [...host.querySelectorAll<HTMLImageElement>("img[data-image-id]")];

const textNodes = (text: string): Node[] => taskTextParts(text).map((part) => ("imageId" in part ? imageNode(part.imageId) : document.createTextNode(part.text)));
const sourcesOf = (block: Element) => [...block.children].map((chip) => (chip as HTMLElement).dataset.source ?? "");

/** The value a node holds: text as it is, an image as its marker, a chip as the text it stands for. */
export function richTextValue(node: Node): string {
  let value = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) value += child.nodeValue ?? "";
    else if (!(child instanceof HTMLElement)) continue;
    else if (child instanceof HTMLImageElement) value += TASK_IMAGE_ID_PATTERN.test(child.dataset.imageId ?? "") ? taskImageMarker(child.dataset.imageId!) : "";
    else if (child instanceof HTMLBRElement) value += "\n";
    else if (child.hasAttribute(TAGS)) value += sourcesOf(child).join("");
    else if (child.hasAttribute(TITLE)) value += richTextValue(child);
    else {
      if (value !== "" && !value.endsWith("\n")) value += "\n";
      value += richTextValue(child);
    }
  }
  return value;
}

function titleElement(): HTMLElement {
  const node = document.createElement("span");
  node.className = "taskRichTitle";
  node.setAttribute(TITLE, "");
  return node;
}

function tagsNode(chips: readonly RichChip[]): HTMLElement {
  const block = document.createElement("div");
  block.className = "taskRichTags";
  block.setAttribute(TAGS, "");
  block.setAttribute("contenteditable", "false");
  block.setAttribute("role", "group");
  block.setAttribute("aria-label", `Tags: ${chips.map((chip) => chip.label).join(", ")}`);
  for (const chip of chips) {
    const node = document.createElement("span");
    node.className = "commandChip taskRichChip";
    node.dataset.source = chip.source;
    node.textContent = chip.label;
    block.append(node);
  }
  return block;
}

const wantsTitle = (layout: RichLayout) => layout.chips.length > 0 || layout.title !== "";

/** Replaces what the field shows with the layout. */
export function drawRichText(host: HTMLElement, layout: RichLayout) {
  const nodes: Node[] = [];
  if (layout.chips.length > 0) nodes.push(tagsNode(layout.chips));
  if (wantsTitle(layout)) {
    const title = titleElement();
    title.append(...textNodes(layout.title));
    nodes.push(title);
  }
  nodes.push(...textNodes(layout.rest));
  host.replaceChildren(...nodes);
  markRest(host, layout);
}

/** The title keeps a gap below it only while a line follows it, not for a line break that ends the text. */
export function markRest(host: HTMLElement, layout: RichLayout) {
  host.querySelector(`[${TITLE}]`)?.classList.toggle("hasRest", layout.rest.length > 1);
}

/** Whether the nodes already are the layout, so typing never has to redraw them. */
export function layoutMatches(host: HTMLElement, layout: RichLayout): boolean {
  const children = [...host.childNodes];
  let index = 0;
  const first = children[0];
  const hasTags = first instanceof HTMLElement && first.hasAttribute(TAGS);
  if (hasTags !== layout.chips.length > 0) return false;
  if (hasTags) {
    const sources = sourcesOf(first);
    if (sources.length !== layout.chips.length || sources.some((source, at) => source !== layout.chips[at].source)) return false;
    index = 1;
  }
  const next = children[index];
  const hasTitle = next instanceof HTMLElement && next.hasAttribute(TITLE);
  if (hasTitle !== wantsTitle(layout)) return false;
  if (hasTitle && richTextValue(next) !== layout.title) return false;
  return host.querySelectorAll(`[${TAGS}]`).length === (hasTags ? 1 : 0) && host.querySelectorAll(`[${TITLE}]`).length === (hasTitle ? 1 : 0);
}

/** Whether the field draws chips with a title line of its own: the last chip does not hold the line break after it. A browser may drop an emptied title node, so the node is not asked for. */
export function hasOwnTitleLine(host: HTMLElement): boolean {
  const first = host.firstChild;
  return first instanceof HTMLElement && first.hasAttribute(TAGS) && !(sourcesOf(first).at(-1) ?? "\n").endsWith("\n");
}

/**
 * A browser leaves a lone line break behind when the last text of a line is deleted, and a second one when Enter is pressed at the end of the text.
 * After chips, also chips that end in a line break, the lone break of a deletion is dropped, so a deleted title leaves the chips and an empty title
 * line, and the stored text does not grow with each delete. The second break of an Enter is dropped, so Enter leaves one line break after the chips.
 * Any other insertion keeps its text.
 */
export function withoutPlaceholder(host: HTMLElement, value: string, inputType = ""): string {
  const chips = host.firstChild instanceof HTMLElement && host.firstChild.hasAttribute(TAGS) ? sourcesOf(host.firstChild).join("") : "";
  if (chips === "") return value;
  if (inputType === "insertParagraph" || inputType === "insertLineBreak") return value === `${chips}\n\n` ? `${chips}\n` : value;
  return !inputType.startsWith("insert") && value === `${chips}\n` ? chips : value;
}

/** The characters of the value that the chips stand for. */
export function chipsLength(host: HTMLElement): number {
  const first = host.firstChild;
  return first instanceof HTMLElement && first.hasAttribute(TAGS) ? sourcesOf(first).join("").length : 0;
}

/** The title line node, or null while the field draws none. */
export const titleNode = (host: HTMLElement) => host.querySelector<HTMLElement>(`[${TITLE}]`);

/** The labels of the chips the field draws, in order. */
export const chipLabels = (host: HTMLElement) => [...host.querySelectorAll(`[${TAGS}] > *`)].map((chip) => chip.textContent ?? "");

const isLeaf = (node: Node) => node.nodeType === Node.TEXT_NODE || node instanceof HTMLImageElement;
const leafLength = (node: Node) => (node instanceof HTMLImageElement ? taskImageMarker(node.dataset.imageId ?? "").length : (node.nodeValue ?? "").length);

/** Makes `parent` hold exactly `nodes`, in order, moving only the nodes that are not in their place. */
function place(parent: Node, nodes: Node[]) {
  for (const child of [...parent.childNodes]) if (!nodes.includes(child)) child.remove();
  nodes.forEach((node, index) => {
    if (parent.childNodes[index] !== node) parent.insertBefore(node, parent.childNodes[index] ?? null);
  });
}

/**
 * Makes the nodes the layout without drawing them again: the text and image nodes the browser made are moved into the title line
 * and the rest, and split where the title line ends. A native undo step still finds its node, so a plain edit does not end the undo
 * history. Returns false, and leaves the field alone, when the chips change or the nodes are not simple enough; the caller then draws it again.
 */
export function reconcileRichText(host: HTMLElement, layout: RichLayout): boolean {
  let tags: HTMLElement | null = null;
  let title: HTMLElement | null = null;
  const leaves: Node[] = [];
  for (const child of host.childNodes) {
    if (child instanceof HTMLElement && child.hasAttribute(TAGS) && tags === null) tags = child;
    else if (child instanceof HTMLElement && child.hasAttribute(TITLE) && title === null && [...child.childNodes].every(isLeaf)) {
      title = child;
      leaves.push(...child.childNodes);
    } else if (isLeaf(child)) leaves.push(child);
    else return false;
  }
  const drawn = tags ? sourcesOf(tags).join("") : "";
  const wanted = layout.chips.map((chip) => chip.source).join("");
  // A conversion to a chip takes the token's text out of a node the browser made, and the browser's undo step would delete that many
  // characters from the front of the node again. The field is drawn again from new nodes then: the old undo steps find nothing.
  if (wanted !== drawn) return false;
  if (leaves.map((leaf) => (leaf instanceof HTMLImageElement ? taskImageMarker(leaf.dataset.imageId ?? "") : leaf.nodeValue ?? "")).join("") !== layout.title + layout.rest) return false;
  const kept = leaves;
  const inTitle: Node[] = [];
  const inRest: Node[] = [];
  let seen = 0;
  for (const leaf of kept) {
    const length = leafLength(leaf);
    if (seen >= layout.title.length) inRest.push(leaf);
    else if (seen + length <= layout.title.length) inTitle.push(leaf);
    else {
      // Text that runs past the end of the title line: its first part stays, the line break and what follows move on.
      inTitle.push(leaf);
      if (leaf instanceof Text) inRest.push(leaf.splitText(layout.title.length - seen));
    }
    seen += length;
  }
  const titleNode = wantsTitle(layout) ? title ?? titleElement() : null;
  const same = tags !== null && sourcesOf(tags).length === layout.chips.length && sourcesOf(tags).every((source, at) => source === layout.chips[at].source);
  const chipsNode = layout.chips.length === 0 ? null : same ? tags : tagsNode(layout.chips);
  if (titleNode) place(titleNode, inTitle);
  place(host, [...(chipsNode ? [chipsNode] : []), ...(titleNode ? [titleNode] : []), ...inRest]);
  markRest(host, layout);
  return true;
}

/**
 * Sets a collapsed caret again where it is. After a line break typed at the end of the title line, the browser's own caret
 * there sends the next typed text to the end of the title; a caret that is set from outside goes to the new line.
 */
export function renewCaret(host: HTMLElement) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (selection && selection.isCollapsed && node && host.contains(node)) selection.collapse(node, selection.anchorOffset);
}

/** The letter of a keyboard shortcut: the Latin letter the key types, else the letter of the physical key, so Ctrl+Я on a Russian layout is Ctrl+Z. */
export function chordLetter(event: { key: string; code: string }): string {
  if (/^[a-z]$/iu.test(event.key)) return event.key.toLowerCase();
  const physical = /^Key([A-Z])$/u.exec(event.code);
  return /^\p{L}$/u.test(event.key) && physical ? physical[1].toLowerCase() : event.key.toLowerCase();
}

/** Whether the selection takes the chips with it: it starts before them. A selection of the whole title line starts after them and keeps them. */
export function selectionCoversChips(host: HTMLElement): boolean {
  if (!host.querySelector(`[${TAGS}]`) || window.getSelection()?.isCollapsed !== false) return false;
  const offsets = selectionOffsets(host);
  return offsets !== null && offsets.start === 0 && offsets.end > 0;
}

/** Selects the whole field, chips included: a browser's select all stops at the start of the title line, because the chips are not editable. */
export function selectEverything(host: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(host);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Takes the chips off the field, as a deletion of the selection that covers them does. */
export const removeChips = (host: HTMLElement) => host.querySelector(`[${TAGS}]`)?.remove();

/** The selection as plain text for the clipboard: the chips as their text when it covers them, and no image marker. */
export function selectionText(host: HTMLElement, range: Range): string {
  return taskTextParts(richTextValue(range.cloneContents())).map((part) => ("imageId" in part ? "" : part.text)).join("");
}

/** The value text before a point of the field, so a caret survives a redraw. Null when the point is outside the field. */
export function offsetOf(host: HTMLElement, node: Node, offset: number): number | null {
  if (!host.contains(node)) return null;
  const range = document.createRange();
  range.setStart(host, 0);
  range.setEnd(node, offset);
  return richTextValue(range.cloneContents()).length;
}

/** The point of the field that stands after `target` characters of its value. A caret never lands inside a chip: it goes to the start of the title. */
export function pointAtOffset(host: HTMLElement, target: number): [Node, number] {
  let seen = 0;
  let last: [Node, number] = [host, host.childNodes.length];
  const visit = (parent: Node): [Node, number] | null => {
    const children = [...parent.childNodes];
    for (const [index, child] of children.entries()) {
      const local = Math.max(0, target - seen);
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue ?? "";
        if (text === "") continue;
        // At the end of a line the caret stays on that line, and only after a line break does it move on to the next node.
        if (local < text.length || (local === text.length && !text.endsWith("\n"))) return [child, Math.min(local, text.length)];
        seen += text.length;
        last = [child, text.length];
      } else if (child instanceof HTMLImageElement) {
        const length = taskImageMarker(child.dataset.imageId ?? "").length;
        if (local < length) return [parent, index];
        seen += length;
        last = [parent, index + 1];
      } else if (child instanceof HTMLBRElement) {
        if (local === 0) return [parent, index];
        seen += 1;
        last = [parent, index + 1];
      } else if (child instanceof HTMLElement && child.hasAttribute(TAGS)) {
        seen += sourcesOf(child).join("").length;
        last = [parent, index + 1];
      } else if (child instanceof HTMLElement) {
        if (child.childNodes.length === 0 && local === 0) return [child, 0];
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(host) ?? last;
}

/** Moves the start of a range that lies before the chips to the start of the title, because nothing is typed or put before the chips. */
export function clampAfterTags(host: HTMLElement, range: Range) {
  const tags = host.querySelector(`[${TAGS}]`);
  if (!tags) return;
  const anchor = document.createRange();
  anchor.setStartAfter(tags);
  if (range.compareBoundaryPoints(Range.START_TO_START, anchor) < 0) range.setStart(anchor.startContainer, anchor.startOffset);
}

/** The selection as value offsets, when it lies in the field. */
export function selectionOffsets(host: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = offsetOf(host, range.startContainer, range.startOffset);
  const end = offsetOf(host, range.endContainer, range.endOffset);
  return start === null || end === null ? null : { start, end };
}

export function restoreSelection(host: HTMLElement, caret: { start: number; end: number }) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const [startNode, startOffset] = pointAtOffset(host, caret.start);
  range.setStart(startNode, startOffset);
  if (caret.end === caret.start) range.collapse(true);
  else {
    const [endNode, endOffset] = pointAtOffset(host, caret.end);
    range.setEnd(endNode, endOffset);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}
