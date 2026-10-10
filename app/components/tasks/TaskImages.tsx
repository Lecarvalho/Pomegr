"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { TASK_BOUNDS, TASK_IMAGE_ID_PATTERN, taskImageMarker, taskTextParts } from "../../../shared/task-contract";
import { TASK_IMAGE_ACCEPT } from "./task-images-desktop";

// The Task field as rich text, for a form that can hold images. The text is typed as plain text and an image sits in
// it where it was pasted, dropped or attached, drawn inline. The value is still one string: an image is the marker
// `[image:<image ID>]` at its place in the text, so the task text alone says where each image belongs. Backspace and
// Delete remove an image like a character. The editor only reports the text and hands over files: each form decides
// when an image is stored.

/** What a form hands the Task field so it can hold images. */
export type TaskFieldImages = {
  /** The object URL of each image the form knows, by image ID; null while an image is still being read. */
  urls: ReadonlyMap<string, string | null>;
  disabled?: boolean;
  error?: string | null;
  /** Takes the files of one paste, drop or pick, given how many images the text holds, and answers the ID of each one it took, in order. */
  onAttach(files: File[], held: number): string[];
};

// Drawn until an image has its URL: a blank pixel, so no broken-image glyph shows.
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const imageNodes = (host: HTMLElement) => [...host.querySelectorAll<HTMLImageElement>("img[data-image-id]")];

function imageNode(imageId: string): HTMLImageElement {
  const node = document.createElement("img");
  node.dataset.imageId = imageId;
  node.className = "taskInlineImage isPending";
  node.src = BLANK;
  node.draggable = false;
  return node;
}

/** The editor's content as task text: text as typed, a line break as a newline, an image as its marker. */
export function richTextValue(node: Node): string {
  let value = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) value += child.nodeValue ?? "";
    else if (!(child instanceof HTMLElement)) continue;
    else if (child instanceof HTMLImageElement) value += TASK_IMAGE_ID_PATTERN.test(child.dataset.imageId ?? "") ? taskImageMarker(child.dataset.imageId!) : "";
    else if (child instanceof HTMLBRElement) value += "\n";
    else {
      // A browser that wraps a line in a block: the block starts a new line.
      if (value !== "" && !value.endsWith("\n")) value += "\n";
      value += richTextValue(child);
    }
  }
  return value;
}

/** A field left with only the line break a browser keeps in an emptied editor holds nothing. */
const settled = (value: string) => (value === "\n" ? "" : value);

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
  // The text the DOM holds now. A `value` that differs came from outside and redraws the content.
  const drawn = useRef<string | null>(null);
  const { urls } = images;

  // Gives each image its picture and its number, in text order.
  const decorate = () => {
    if (!host.current) return;
    imageNodes(host.current).forEach((node, index) => {
      const url = urls.get(node.dataset.imageId ?? "") ?? null;
      const src = url ?? BLANK;
      if (node.getAttribute("src") !== src) node.src = src;
      node.classList.toggle("isPending", url === null);
      node.alt = `Image ${index + 1}`;
    });
  };

  useLayoutEffect(() => {
    if (!host.current || drawn.current === value) return;
    host.current.replaceChildren(...taskTextParts(value).map((part) => ("imageId" in part ? imageNode(part.imageId) : document.createTextNode(part.text))));
    drawn.current = value;
  }, [value]);
  // After every render: a redraw, an edit and a new URL all leave images to number or fill.
  useEffect(decorate);

  const report = () => {
    if (!host.current) return;
    const next = settled(richTextValue(host.current));
    if (next === "" && host.current.childNodes.length > 0) host.current.replaceChildren();
    drawn.current = next;
    decorate();
    onChange(next);
  };

  // Puts the images the form took at the caret, or at the end when the caret is elsewhere.
  const attach = (files: File[]) => {
    const element = host.current;
    if (!element || readOnly || images.disabled || files.length === 0) return;
    const ids = images.onAttach(files, imageNodes(element).length);
    if (ids.length === 0) return;
    const selection = window.getSelection();
    let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !element.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    range.deleteContents();
    for (const id of ids) {
      const node = imageNode(id);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
    report();
  };

  useImperativeHandle(ref, () => ({ focus: (options) => host.current?.focus(options), attach }));

  const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
  return <div ref={host} className="taskRichText" role="textbox" aria-multiline="true" aria-labelledby={labelledBy} aria-describedby={describedBy}
    aria-readonly={readOnly || undefined} data-placeholder={placeholder} tabIndex={0}
    // Plain text only: a paste or a drop of formatted text keeps its words, never its markup.
    contentEditable={readOnly ? false : "plaintext-only"} suppressContentEditableWarning
    onInput={report} onBlur={onBlur}
    onPaste={(event) => {
      const files = imageFiles(event.clipboardData?.files);
      if (files.length === 0) return;
      // The paste is the image: it types nothing.
      event.preventDefault();
      attach(files);
    }}
    onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); }}
    onDrop={(event) => {
      const files = imageFiles(event.dataTransfer.files);
      if (event.dataTransfer.files.length === 0) return;
      // A dropped file is never opened or typed as its path; only an image is taken.
      event.preventDefault();
      attach(files);
    }} />;
}

/** Attach image, at the foot of the Task field's frame: it opens the file picker and hands the files to the editor. */
export function TaskImageAttach({ held, disabled, describedBy, onAttach }: { held: number; disabled?: boolean; describedBy?: string; onAttach(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="taskImagesHead">
    <button type="button" className="commandQuietAction" disabled={disabled || held >= TASK_BOUNDS.imagesPerTask} aria-describedby={describedBy}
      // The editor keeps its caret: the image goes where the user was typing.
      onMouseDown={(event) => event.preventDefault()} onClick={() => input.current?.click()}>Attach image</button>
    <input ref={input} type="file" className="taskImageInput" accept={TASK_IMAGE_ACCEPT} multiple hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        // The same file can be picked again after it was removed.
        event.currentTarget.value = "";
        if (files.length > 0) onAttach(files);
      }} />
  </div>;
}
