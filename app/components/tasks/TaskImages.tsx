"use client";

import { useId, useRef, type ClipboardEvent } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { TASK_IMAGE_ACCEPT, TASK_IMAGE_HELPER } from "./task-images-desktop";
import type { TaskImageItem } from "./use-task-images";

// The images of a task, under the Task field of the New task and Task modal forms. An image arrives by a paste into the
// Task field or by Attach image; each is drawn as a thumbnail with its own Remove. The field only reports what the
// user did: each form decides when an image is stored.

/** The image files of a paste. With at least one, the paste is the image and puts no text in the field. */
export function pastedImageFiles(event: ClipboardEvent<HTMLElement>): File[] {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) event.preventDefault();
  return files;
}

export function TaskImageField({ items, busy, disabled, error, onAttach, onRemove }: {
  items: readonly TaskImageItem[];
  /** An attach or a remove is on its way: both controls wait for it. */
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onAttach(files: File[]): void;
  onRemove(key: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const helperId = useId();
  const full = items.length >= TASK_BOUNDS.imagesPerTask;
  const waiting = busy === true || disabled === true;
  return <div className="newTaskField taskImages">
    <div className="taskImagesHead">
      <button type="button" className="commandQuietAction" disabled={waiting || full} aria-describedby={helperId} onClick={() => input.current?.click()}>
        {busy ? "Attaching…" : "Attach image"}
      </button>
      <input ref={input} type="file" className="taskImageInput" accept={TASK_IMAGE_ACCEPT} multiple hidden tabIndex={-1} aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // The same file can be picked again after it was removed.
          event.currentTarget.value = "";
          if (files.length > 0) onAttach(files);
        }} />
    </div>
    {items.length > 0 && <ul className="taskImageList" aria-label="Attached images">
      {items.map((item) => <li key={item.key} className="taskImageItem">
        {item.url
          // An object URL of this page: next/image cannot optimize it and must not send it anywhere.
          // eslint-disable-next-line @next/next/no-img-element
          ? <img className="taskImageThumb" src={item.url} alt={item.label} />
          : <span className="taskImageThumb taskImagePending" role="img" aria-label={`${item.label}, loading`} />}
        <button type="button" className="commandIconAction taskImageRemove" disabled={waiting} aria-label={`Remove ${item.label}`} title={`Remove ${item.label}`}
          onClick={() => onRemove(item.key)}><CommandIcon name="close" /></button>
      </li>)}
    </ul>}
    <p id={helperId} className="newTaskHelper">{TASK_IMAGE_HELPER}</p>
    {error && <p className="newTaskError" role="alert">{error}</p>}
  </div>;
}
