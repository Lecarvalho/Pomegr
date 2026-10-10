"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import {
  TASK_IMAGE_CREATE_FAILURE_MESSAGE, TASK_IMAGE_REMOVE_FAILURE_MESSAGE, acceptImageFiles, addDesktopTaskImage, imageAddFailureMessage,
  readDesktopTaskImage, removeDesktopTaskImage, takeImageCreateFailure,
} from "./task-images-desktop";

/** One image as the field draws it. `url` is an object URL of this page, or null while the image is being read. */
export type TaskImageItem = { key: string; url: string | null; label: string };

export type TaskImagesState = {
  items: TaskImageItem[];
  busy: boolean;
  error: string | null;
  /** Takes the image files of one paste or pick; a file that cannot be attached is named by `error`. */
  add(files: readonly File[]): void;
  remove(key: string): void;
};

const labelOf = (index: number) => `Image ${index + 1}`;

type DraftImage = { key: string; file: File; url: string };

/**
 * The images of a task that does not exist yet (the New task form). They stay in this component's memory until the
 * task is created; `files` is then what the form attaches, in order. Every object URL is revoked when its image
 * leaves or the form closes.
 */
export function useDraftImages(): TaskImagesState & { files: File[] } {
  const [drafts, setDrafts] = useState<DraftImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const held = useRef<DraftImage[]>([]);
  const serial = useRef(0);
  useEffect(() => () => { for (const draft of held.current) URL.revokeObjectURL(draft.url); }, []);
  const add = useCallback((files: readonly File[]) => {
    const { accepted, message } = acceptImageFiles(files, held.current.length);
    setError(message);
    if (accepted.length === 0) return;
    const added = accepted.map((file) => ({ key: `draft-${serial.current += 1}`, file, url: URL.createObjectURL(file) }));
    held.current = [...held.current, ...added];
    setDrafts(held.current);
  }, []);
  const remove = useCallback((key: string) => {
    const gone = held.current.find((draft) => draft.key === key);
    if (!gone) return;
    URL.revokeObjectURL(gone.url);
    held.current = held.current.filter((draft) => draft.key !== key);
    setDrafts(held.current);
    setError(null);
  }, []);
  return {
    items: drafts.map((draft, index) => ({ key: draft.key, url: draft.url, label: labelOf(index) })),
    files: drafts.map((draft) => draft.file), busy: false, error, add, remove,
  };
}

/**
 * The images of a stored task (the Task modal). Attach and remove act at once through the desktop bridge, like Start
 * at, and are not part of the Save draft; `onChanged` then has the board read again, which is what lists the images.
 * Each listed image is read once into an object URL that is revoked when the image leaves or the modal closes.
 */
export function useStoredImages(repositoryId: string, task: Pick<Task, "id" | "images">, onChanged: () => void): TaskImagesState {
  const images = task.images ?? [];
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (takeImageCreateFailure(repositoryId, task.id) ? TASK_IMAGE_CREATE_FAILURE_MESSAGE : null));
  const loaded = useRef(new Map<string, string>());
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const working = useRef(false);
  const ids = images.map((image) => image.id).join(" ");

  useEffect(() => {
    mounted.current = true;
    const urlsHeld = loaded.current;
    return () => {
      mounted.current = false;
      for (const url of urlsHeld.values()) URL.revokeObjectURL(url);
      urlsHeld.clear();
    };
  }, []);

  useEffect(() => {
    const listed = new Set(ids === "" ? [] : ids.split(" "));
    let dropped = false;
    for (const [id, url] of loaded.current) {
      if (listed.has(id)) continue;
      URL.revokeObjectURL(url);
      loaded.current.delete(id);
      dropped = true;
    }
    if (dropped) setUrls(new Map(loaded.current));
    for (const id of listed) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      void readDesktopTaskImage(repositoryId, task.id, id).then((result) => {
        if (!result.ok || !mounted.current) return;
        loaded.current.set(id, URL.createObjectURL(result.blob));
        setUrls(new Map(loaded.current));
      });
    }
  }, [ids, repositoryId, task.id]);

  const add = useCallback((files: readonly File[]) => {
    if (working.current) return;
    const { accepted, message } = acceptImageFiles(files, images.length);
    setError(message);
    if (accepted.length === 0) return;
    working.current = true;
    setBusy(true);
    void (async () => {
      let failure: string | null = message;
      for (const file of accepted) {
        const result = await addDesktopTaskImage(repositoryId, task.id, new Uint8Array(await file.arrayBuffer()));
        if (!result.ok) { failure = imageAddFailureMessage(result.error); break; }
      }
      working.current = false;
      onChanged();
      if (!mounted.current) return;
      setBusy(false);
      setError(failure);
    })();
  }, [images.length, onChanged, repositoryId, task.id]);

  const remove = useCallback((key: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    void removeDesktopTaskImage(repositoryId, task.id, key).then((result) => {
      working.current = false;
      onChanged();
      if (!mounted.current) return;
      setBusy(false);
      // An image that is already gone needs no message: the board read drops it.
      if (!result.ok && result.error !== "not_found") setError(TASK_IMAGE_REMOVE_FAILURE_MESSAGE);
    });
  }, [onChanged, repositoryId, task.id]);

  return { items: images.map((image, index) => ({ key: image.id, url: urls.get(image.id) ?? null, label: labelOf(index) })), busy, error, add, remove };
}
