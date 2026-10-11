"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { taskImageIds, taskImageMarker, taskTextParts, type Task } from "../../../shared/task-contract";
import {
  TASK_IMAGE_CREATE_FAILURE_MESSAGE, TASK_IMAGE_REMOVE_FAILURE_MESSAGE, acceptImageFiles, addDesktopTaskImage, imageAddFailureMessage, newTaskImageId,
  readDesktopTaskImage, removeDesktopTaskImage, takeImageCreateFailure,
} from "./task-images-desktop";

// The images behind the Task field of each form.

type Pending = { file: File; url: string };

export type TaskImagesDraft = {
  urls: ReadonlyMap<string, string | null>;
  error: string | null;
  attach(files: File[], held: number): string[];
  store(taskId: string, text: string): Promise<string | null>;
};

function usePendingImages(repositoryId: string, firstError: () => string | null = () => null) {
  const pending = useRef(new Map<string, Pending>());
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
      if (!result.ok && result.error !== "conflict") return imageAddFailureMessage(result.error);
      stored.current.add(id);
    }
    return null;
  }, [repositoryId]);
  return { added, error, attach, store };
}

export function useDraftImages(repositoryId: string): TaskImagesDraft {
  const { added, error, attach, store } = usePendingImages(repositoryId);
  return { urls: added, error, attach, store };
}

export function shownTaskText(text: string, images: Task["images"]): string {
  const ids = new Set((images ?? []).map((image) => image.id));
  const kept = taskTextParts(text).map((part) => ("imageId" in part ? (ids.has(part.imageId) ? taskImageMarker(part.imageId) : "") : part.text)).join("");
  const named = new Set(taskImageIds(kept));
  const unnamed = [...ids].filter((id) => !named.has(id)).map(taskImageMarker);
  return unnamed.length === 0 ? kept : `${kept}${kept === "" ? "" : "\n"}${unnamed.join(" ")}`;
}

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
    for (const [id, url] of added) all.set(id, url);
    return all;
  }, [added, ids, read]);

  const prune = useCallback(async (text: string) => {
    const named = new Set(taskImageIds(text));
    let failure: string | null = null;
    for (const id of ids === "" ? [] : ids.split(" ")) {
      if (named.has(id)) continue;
      const result = await removeDesktopTaskImage(repositoryId, task.id, id);
      if (!result.ok && result.error !== "not_found") failure = TASK_IMAGE_REMOVE_FAILURE_MESSAGE;
    }
    return failure;
  }, [ids, repositoryId, task.id]);

  return { urls, error, attach, store, prune };
}
