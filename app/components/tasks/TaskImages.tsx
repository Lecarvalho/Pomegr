"use client";

import { useRef, type ClipboardEvent } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { TASK_IMAGE_ACCEPT } from "./task-images-desktop";
import type { TaskImageItem } from "./use-task-images";

// The images of a task, drawn inside the Task field's own frame, under the text: one thumbnail per image with its
// Remove, then Attach image. An image arrives by a paste or a drop into the field, or by Attach image. The tray only
// reports what the user did: each form decides when an image is stored.

/** What a form hands the Task field so it can hold images. */
export type TaskFieldImages = {
  items: readonly TaskImageItem[];
  /** An attach or a remove is on its way: both controls wait for it. */
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onAttach(files: File[]): void;
  onRemove(key: string): void;
};

/** The image files of a paste. With at least one, the paste is the image and puts no text in the field. */
export function pastedImageFiles(event: ClipboardEvent<HTMLElement>): File[] {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) event.preventDefault();
  return files;
}

/** The tray at the foot of the Task field's frame. `describedBy` is the helper line the field draws under the frame. */
export function TaskImageTray({ images, describedBy }: { images: TaskFieldImages; describedBy?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { items, busy, disabled, onAttach, onRemove } = images;
  const full = items.length >= TASK_BOUNDS.imagesPerTask;
  const waiting = busy === true || disabled === true;
  return <div className="taskImages">
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
    <div className="taskImagesHead">
      <button type="button" className="commandQuietAction" disabled={waiting || full} aria-describedby={describedBy} onClick={() => input.current?.click()}>
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
  </div>;
}
