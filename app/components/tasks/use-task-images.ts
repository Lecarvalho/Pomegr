"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { taskImageIds, taskImageMarker, taskTextParts, type Task } from "../../../shared/task-contract";
import {
  TASK_IMAGE_CREATE_FAILURE_MESSAGE, TASK_IMAGE_REMOVE_FAILURE_MESSAGE, acceptImageFiles, addDesktopTaskImage, imageAddFailureMessage, newTaskImageId,
  readDesktopTaskImage, removeDesktopTaskImage, takeImageCreateFailure,
} from "./task-images-desktop";

// The images behind the Task field of each form. The task text says which images a task has: each is a marker at its
// place in the text. These hooks hold the pictures: the files the user just put in, which are not stored yet, and the
// object URLs the field draws. An image is stored when the text that names it is saved, and never before.

type Pending = { file: File; url: string };

export type TaskImagesDraft = {
  /** The object URL of each image by ID; null while a stored image is being read. */
  urls: ReadonlyMap<string, string | null>;
  error: string | null;
  /** Takes the image files of one paste, drop or pick, `held` being how many images the text holds, and answers their new IDs. */
  attach(files: File[], held: number): string[];
  /**
   * Stores the images `text` names that are not stored yet, on `taskId`. Answers null, or the one fixed line of the
   * first that failed; an image that failed stays pending, so a retry stores it.
   */
  store(taskId: string, text: string): Promise<string | null>;
};

/** The files the user put in and their object URLs, revoked when the form closes. */
function usePendingImages(repositoryId: string, firstError: () => string | null = () => null) {
  const pending = useRef(new Map<string, Pending>());
  // The pending images that are stored by now: their pictures stay for the field to draw, but they are not sent again.
  const stored = useRef(new Set<string>());
  const [added, setAdded] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(firstError);
  useEffect(() => {
    const held = pending.current;
    return () => { for (const image of held.values()) URL.revokeObjectURL(image.url); };
  }, []);
  const attach = useCallback((files: File[], held: number) => {
    const { accepted, message } = acceptImageFiles(files, held);
    setError(message);
    const ids = accepted.map((file) => {
      const id = newTaskImageId();
      pending.current.set(id, { file, url: URL.createObjectURL(file) });
      return id;
    });
    if (ids.length > 0) setAdded(new Map([...pending.current].map(([id, image]) => [id, image.url])));
    return ids;
  }, []);
  const store = useCallback(async (taskId: string, text: string) => {
    for (const id of taskImageIds(text)) {
      const image = pending.current.get(id);
      if (!image || stored.current.has(id)) continue;
      const result = await addDesktopTaskImage(repositoryId, taskId, id, new Uint8Array(await image.file.arrayBuffer()));
      // `conflict` is this image stored by an earlier try whose answer was lost.
      if (!result.ok && result.error !== "conflict") return imageAddFailureMessage(result.error);
      stored.current.add(id);
    }
    return null;
  }, [repositoryId]);
  return { added, error, attach, store };
}

/** The images of a task that does not exist yet (the New task form): they wait here until the task is created. */
export function useDraftImages(repositoryId: string): TaskImagesDraft {
  const { added, error, attach, store } = usePendingImages(repositoryId);
  return { urls: added, error, attach, store };
}

/**
 * The task text as the Task form shows it: a marker that names no image of the task is dropped, and an image of the
 * task the text does not name is put at its end, so every image the task holds can be seen and removed.
 */
export function shownTaskText(text: string, images: Task["images"]): string {
  const ids = new Set((images ?? []).map((image) => image.id));
  const kept = taskTextParts(text).map((part) => ("imageId" in part ? (ids.has(part.imageId) ? taskImageMarker(part.imageId) : "") : part.text)).join("");
  const named = new Set(taskImageIds(kept));
  const unnamed = [...ids].filter((id) => !named.has(id)).map(taskImageMarker);
  return unnamed.length === 0 ? kept : `${kept}${kept === "" ? "" : "\n"}${unnamed.join(" ")}`;
}

/**
 * The images of a stored task (the Task form). Each stored image is read once into an object URL. Images are part of
 * the draft like the text that names them: `store` sends the new ones before the text is saved, and `prune` removes
 * the stored ones the saved text no longer names. Close discards both.
 */
export function useStoredImages(repositoryId: string, task: Pick<Task, "id" | "images">): TaskImagesDraft & { prune(text: string): Promise<string | null> } {
  const { added, error, attach, store } = usePendingImages(repositoryId, () => (takeImageCreateFailure(repositoryId, task.id) ? TASK_IMAGE_CREATE_FAILURE_MESSAGE : null));
  const [read, setRead] = useState<ReadonlyMap<string, string>>(new Map());
  const loaded = useRef(new Map<string, string>());
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const ids = (task.images ?? []).map((image) => image.id).join(" ");

  useEffect(() => {
    mounted.current = true;
    const held = loaded.current;
    return () => {
      mounted.current = false;
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  useEffect(() => {
    for (const id of ids === "" ? [] : ids.split(" ")) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      void readDesktopTaskImage(repositoryId, task.id, id).then((result) => {
        if (!result.ok || !mounted.current) return;
        loaded.current.set(id, URL.createObjectURL(result.blob));
        setRead(new Map(loaded.current));
      });
    }
  }, [ids, repositoryId, task.id]);

  const urls = useMemo(() => {
    const all = new Map<string, string | null>();
    for (const id of ids === "" ? [] : ids.split(" ")) all.set(id, read.get(id) ?? null);
    // A picture the user just put in is drawn from its own file, also once it is stored.
    for (const [id, url] of added) all.set(id, url);
    return all;
  }, [added, ids, read]);

  const prune = useCallback(async (text: string) => {
    const named = new Set(taskImageIds(text));
    let failure: string | null = null;
    for (const id of ids === "" ? [] : ids.split(" ")) {
      if (named.has(id)) continue;
      const result = await removeDesktopTaskImage(repositoryId, task.id, id);
      // An image that is already gone needs no message.
      if (!result.ok && result.error !== "not_found") failure = TASK_IMAGE_REMOVE_FAILURE_MESSAGE;
    }
    return failure;
  }, [ids, repositoryId, task.id]);

  return { urls, error, attach, store, prune };
}
