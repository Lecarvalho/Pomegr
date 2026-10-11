"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { TASK_BOUNDS, TASK_IMAGE_ID_PATTERN, taskImageMarker, taskTextParts } from "../../../shared/task-contract";
import { TASK_IMAGE_ACCEPT } from "./task-images-desktop";

export type TaskFieldImages = {
  urls: ReadonlyMap<string, string | null>;
  disabled?: boolean;
  error?: string | null;
  onAttach(files: File[], held: number): string[];
};

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

export function richTextValue(node: Node): string {
  let value = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) value += child.nodeValue ?? "";
    else if (!(child instanceof HTMLElement)) continue;
    else if (child instanceof HTMLImageElement) value += TASK_IMAGE_ID_PATTERN.test(child.dataset.imageId ?? "") ? taskImageMarker(child.dataset.imageId!) : "";
    else if (child instanceof HTMLBRElement) value += "\n";
    else {
      if (value !== "" && !value.endsWith("\n")) value += "\n";
      value += richTextValue(child);
    }
  }
  return value;
}

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
  const drawn = useRef<string | null>(null);
  const { urls } = images;

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
  useEffect(decorate);

  const report = () => {
    if (!host.current) return;
    const next = settled(richTextValue(host.current));
    if (next === "" && host.current.childNodes.length > 0) host.current.replaceChildren();
    drawn.current = next;
    decorate();
    onChange(next);
  };

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
    // Plain text only.
    contentEditable={readOnly ? false : "plaintext-only"} suppressContentEditableWarning
    onInput={report} onBlur={onBlur}
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
    }} />;
}

export function TaskImageAttach({ held, disabled, describedBy, onAttach }: { held: number; disabled?: boolean; describedBy?: string; onAttach(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="taskImagesHead">
    <button type="button" className="commandQuietAction" disabled={disabled || held >= TASK_BOUNDS.imagesPerTask} aria-describedby={describedBy}
      onMouseDown={(event) => event.preventDefault()} onClick={() => input.current?.click()}>Attach image</button>
    <input ref={input} type="file" className="taskImageInput" accept={TASK_IMAGE_ACCEPT} multiple hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length > 0) onAttach(files);
      }} />
  </div>;
}
