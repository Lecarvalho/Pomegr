"use client";

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode, type Ref } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import { ImageGlyph } from "./TaskGlyphs";
import { TASK_IMAGE_ACCEPT, TASK_IMAGE_HINT } from "./task-images-desktop";
import { spaceGluedTokens } from "./task-tags";
import { RichHistory, type RichCaret, type RichEditKind, type RichStep } from "./task-rich-history";
import {
  BLANK_IMAGE, chipLabels, chordLetter, clampAfterTags, drawRichText, chipsLength, hasOwnTitleLine, imageNode, imageNodes, layoutMatches, markRest, offsetOf, reconcileRichText, removeChips,
  renewCaret, restoreSelection, richLayout, richTextValue, selectEverything, selectionCoversChips, selectionOffsets, selectionText, titleNode,
  withoutPlaceholder,
} from "./task-rich-text";

export type TaskFieldImages = {
  urls: ReadonlyMap<string, string | null>;
  disabled?: boolean;
  error?: string | null;
  onAttach(files: File[], held: number): string[];
};

const settled = (value: string) => (value === "\n" ? "" : value);

/** The edits whose runs the history joins into one step. */
const EDIT_KINDS: Record<string, RichEditKind> = { insertText: "type", deleteContentBackward: "backspace", deleteContentForward: "delete" };

export type TaskRichTextHandle = { focus(options?: FocusOptions): void; attach(files: File[]): void };

export function TaskRichText({ labelledBy, describedBy, value, onChange, onBlur, readOnly, images, placeholder, ref }: {
  labelledBy: string;
  describedBy: string;
  value: string;
  onChange(value: string): void;
  onBlur?(): void;
  readOnly?: boolean;
  images: TaskFieldImages;
  placeholder: string;
  ref?: Ref<TaskRichTextHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tagsLine = useRef<HTMLSpanElement>(null);
  const tagsId = useId();
  const drawn = useRef<string | null>(null);
  // The field's own undo history. `began` is the caret where the edit that is about to be reported began.
  const [history] = useState(() => new RichHistory());
  const began = useRef<RichCaret | null>(null);
  // The field added a space after a token, so the space the person types next at the start of the title is that space. Anything else clears it.
  const spaced = useRef(false);
  const { urls } = images;

  // The chips sit inside the textbox, where a screen reader does not look for a group: the tags are also named beside it, and the textbox is described by them.
  const nameTags = () => {
    const labels = host.current ? chipLabels(host.current) : [];
    if (tagsLine.current) tagsLine.current.textContent = labels.length > 0 ? `Tags: ${labels.join(", ")}` : "";
  };

  const decorate = () => {
    if (!host.current) return;
    imageNodes(host.current).forEach((node, index) => {
      const url = urls.get(node.dataset.imageId ?? "") ?? null;
      const src = url ?? BLANK_IMAGE;
      if (node.getAttribute("src") !== src) node.src = src;
      node.classList.toggle("isPending", url === null);
      node.alt = `Image ${index + 1}`;
    });
  };

  useLayoutEffect(() => {
    if (!host.current || drawn.current === value) return;
    drawRichText(host.current, richLayout(value));
    drawn.current = value;
    // A text set from outside starts a new history: undo never goes back across it.
    history.reset({ value, caret: { start: value.length, end: value.length }, ownTitleLine: false });
    nameTags();
  }, [value, history]);
  useEffect(decorate);

  /**
   * Draws the value the way the field shows it: a leading tag run as chips, the first line as the title line, then the rest. Typing
   * leaves the nodes alone while they already match. When they do not (a closing bracket that ends a tag token, an Enter in the title, a paste),
   * the nodes the browser made are moved and split into place, and a new chip is drawn from new nodes. The selection is put back by
   * its character offset in the value, so the caret never jumps. `shift` is the characters the field added before the caret.
   * An insertion lets a line break after the chips belong to the chips; only a deletion keeps an emptied title line.
   */
  const settle = (element: HTMLElement, next: string, inserting: boolean, shift: number) => {
    const layout = richLayout(next, { ownTitleLine: !inserting && hasOwnTitleLine(element) });
    if (shift === 0 && layoutMatches(element, layout)) {
      markRest(element, layout);
      return;
    }
    const caret = selectionOffsets(element);
    const titled = titleNode(element) !== null;
    const moved = reconcileRichText(element, layout);
    if (!moved) drawRichText(element, layout);
    // Moving a node takes the selection off it, but splitting one does not: the selection is put back only when it moved.
    // A title line that is new gets the caret, because a caret beside the new node would type outside it.
    const now = selectionOffsets(element);
    if (caret && (shift !== 0 || !moved || !titled || now?.start !== caret.start || now?.end !== caret.end)) {
      restoreSelection(element, { start: caret.start + shift, end: caret.end + shift });
    }
  };

  const commit = (next: string) => {
    drawn.current = next;
    decorate();
    nameTags();
    onChange(next);
  };

  const snapshot = (element: HTMLElement, value: string): RichStep => ({
    value, caret: selectionOffsets(element) ?? { start: value.length, end: value.length }, ownTitleLine: hasOwnTitleLine(element),
  });

  // Text composed with an IME is left as the browser has it until the composition ends, and is one step of the history then.
  const report = (composing = false, inputType = "") => {
    const element = host.current;
    if (!element) return;
    const inserting = inputType.startsWith("insert");
    let next = withoutPlaceholder(element, settled(richTextValue(element)), inputType);
    const caret = selectionOffsets(element);
    const collapsed = !composing && inserting && caret !== null && caret.start === caret.end;
    let shift = 0;
    // The space the person types right after the space the field added is not a second space.
    if (collapsed && spaced.current && inputType === "insertText" && caret.start === chipsLength(element) + 1 && next.length === (drawn.current ?? "").length + 1 && next[caret.start - 1] === " ") {
      next = next.slice(0, caret.start - 1) + next.slice(caret.start);
      shift = -1;
    }
    // A token completed against the text after it, text typed against the last chip, and pasted tokens that touch each other or the text, get a
    // space, so each token is a tag, as it is when it is typed one character at a time.
    const separated = collapsed && shift === 0 ? spaceGluedTokens(next, began.current?.start ?? Math.max(0, caret.start - 1), caret.start) : null;
    if (separated !== null) {
      next = separated.text;
      shift = separated.added;
    }
    if (!composing) spaced.current = separated !== null;
    if (next === "" && element.childNodes.length > 0) element.replaceChildren();
    else if (!composing) settle(element, next, inserting, shift);
    commit(next);
    if (!composing) history.record(snapshot(element, next), EDIT_KINDS[inputType] ?? "other", began.current);
    began.current = null;
  };

  // Undo and redo draw the text a step holds, with its chips, and put the caret back.
  const travel = (step: RichStep | null) => {
    const element = host.current;
    if (!element || !step) return;
    spaced.current = false;
    if (step.value === "") element.replaceChildren();
    else drawRichText(element, richLayout(step.value, { ownTitleLine: step.ownTitleLine }));
    restoreSelection(element, step.caret);
    commit(step.value);
  };
  const undo = () => travel(history.undo());
  const redo = () => travel(history.redo());
  const latest = useRef({ undo, redo });
  useLayoutEffect(() => { latest.current = { undo, redo }; });

  // Backspace with the caret at the very start of the title takes the last tag off in one press, like an image.
  const removeLastTag = () => {
    const element = host.current;
    const selection = window.getSelection();
    if (!element || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const layout = richLayout(settled(richTextValue(element)), { ownTitleLine: hasOwnTitleLine(element) });
    const caret = selectionOffsets(element);
    const range = selection.getRangeAt(0);
    if (layout.chips.length === 0 || offsetOf(element, range.startContainer, range.startOffset) !== layout.chips.reduce((total, chip) => total + chip.source.length, 0)) return false;
    spaced.current = false;
    const kept = layout.chips.slice(0, -1).map((chip) => chip.source).join("");
    // A chip that nothing follows was completed a moment ago: Backspace turns it back into its text, minus the closing bracket, so it can be corrected.
    const last = layout.chips.at(-1)!.source;
    const text = /\s$/u.test(last) ? "" : last.slice(0, -1);
    const next = settled(kept + text + layout.title + layout.rest);
    drawRichText(element, richLayout(next));
    restoreSelection(element, { start: kept.length + text.length, end: kept.length + text.length });
    commit(next);
    history.record(snapshot(element, next), "other", caret);
    return true;
  };

  const attach = (files: File[]) => {
    const element = host.current;
    if (!element || readOnly || images.disabled || files.length === 0) return;
    const ids = images.onAttach(files, imageNodes(element).length);
    if (ids.length === 0) return;
    began.current = selectionOffsets(element);
    // An image over a selection that covers the chips takes the chips with it, as typing over it does.
    if (selectionCoversChips(element)) removeChips(element);
    const selection = window.getSelection();
    let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !element.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    clampAfterTags(element, range);
    range.deleteContents();
    for (const id of ids) {
      const node = imageNode(id);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
    // An image is an insertion: against a chip that nothing follows, it gets the space a typed character would.
    report(false, "insertFromPaste");
  };

  useImperativeHandle(ref, () => ({ focus: (options) => host.current?.focus(options), attach }));

  // A deletion or a typed or pasted text over a selection that covers the chips takes the chips with it. The browser would leave them, because they are not editable.
  useEffect(() => {
    const element = host.current;
    if (!element || readOnly) return;
    const onBeforeInput = (event: Event) => {
      const type = (event as InputEvent).inputType ?? "";
      // The browser's own undo steps name nodes the field moves and draws again, so the field's history answers undo and redo, also from a menu.
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault();
        if (type === "historyUndo") latest.current.undo();
        else latest.current.redo();
        return;
      }
      if (!/^(insert|delete)/u.test(type)) return;
      began.current = selectionOffsets(element);
      if (selectionCoversChips(element)) removeChips(element);
    };
    element.addEventListener("beforeinput", onBeforeInput);
    return () => element.removeEventListener("beforeinput", onBeforeInput);
  }, [readOnly]);

  // Copy and cut of a selection that covers the chips carry the chips' text, which the browser would leave out.
  const copySelection = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const element = host.current;
    const selection = window.getSelection();
    if (!element || !selection || selection.rangeCount === 0 || !selectionCoversChips(element)) return;
    const range = selection.getRangeAt(0);
    event.clipboardData.setData("text/plain", selectionText(element, range));
    event.preventDefault();
    if (!cut || readOnly) return;
    began.current = selectionOffsets(element);
    removeChips(element);
    range.deleteContents();
    report();
  };

  const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
  return <>
    <div ref={host} className="taskRichText" role="textbox" aria-multiline="true" aria-labelledby={labelledBy} aria-describedby={[describedBy, tagsId].filter(Boolean).join(" ")}
      aria-readonly={readOnly || undefined} data-placeholder={placeholder} tabIndex={0}
      // Plain text only.
      contentEditable={readOnly ? false : "plaintext-only"} suppressContentEditableWarning
      onInput={(event) => {
        const input = event.nativeEvent as InputEvent;
        report(input.isComposing === true, input.inputType ?? "");
        // A line break typed at the end of the title line leaves the browser's caret on the title: set it again, so the next text goes to the new line.
        if ((input.inputType === "insertParagraph" || input.inputType === "insertLineBreak") && host.current) renewCaret(host.current);
      }}
      onCompositionEnd={() => report(false, "insertCompositionText")}
      onBlur={() => { spaced.current = false; onBlur?.(); }}
      onPointerDown={() => { spaced.current = false; }}
      onCopy={(event) => copySelection(event, false)} onCut={(event) => copySelection(event, true)}
      onKeyDown={(event) => {
        if (readOnly || event.nativeEvent.isComposing) return;
        // A key that moves the caret or does anything but type a character ends the moment in which a typed space is the one the field added.
        if (event.key.length > 1 || event.ctrlKey || event.metaKey || event.altKey) spaced.current = false;
        const chord = (event.ctrlKey || event.metaKey) && !event.altKey;
        const letter = chordLetter(event);
        if (chord && letter === "z") {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
        } else if (chord && letter === "y" && !event.shiftKey) {
          event.preventDefault();
          redo();
        } else if (chord && letter === "a" && !event.shiftKey && host.current) {
          // Select all takes the chips too, because it is the person's intent to take everything. A browser's own select all would stop short of them.
          event.preventDefault();
          selectEverything(host.current);
        } else if (event.key === "Backspace" && !event.ctrlKey && !event.altKey && !event.metaKey && removeLastTag()) event.preventDefault();
      }}
      onPaste={(event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
      }}
      onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        const files = imageFiles(event.dataTransfer.files);
        if (event.dataTransfer.files.length === 0) return;
        // A dropped file is never opened or typed as its path.
        event.preventDefault();
        attach(files);
      }} />
    <span id={tagsId} ref={tagsLine} className="srOnly" />
  </>;
}

/** The foot strip of the Task field: Attach image, the muted hint, and (as `children`) the counter at the end. */
export function TaskImageAttach({ held, disabled, hintId, onAttach, children }: {
  held: number;
  disabled?: boolean;
  hintId: string;
  onAttach(files: File[]): void;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="taskImagesHead">
    <button type="button" className="commandQuietAction" disabled={disabled || held >= TASK_BOUNDS.imagesPerTask} aria-describedby={hintId}
      onMouseDown={(event) => event.preventDefault()} onClick={() => input.current?.click()}><ImageGlyph />Attach image</button>
    <input ref={input} type="file" className="taskImageInput" accept={TASK_IMAGE_ACCEPT} multiple hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length > 0) onAttach(files);
      }} />
    <span id={hintId} className="taskImagesHint">{TASK_IMAGE_HINT}</span>
    {children}
  </div>;
}
