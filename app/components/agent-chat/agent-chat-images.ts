"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_CHAT_BOUNDS, type AgentChatImage, type AgentChatImageAddResult, type AgentChatImageOperationName } from "../../../shared/agent-chat-contract";
import { TASK_IMAGE_TYPES, type TaskImageType } from "../../../shared/task-contract";
import { parseAgentChatImage } from "../../agent-chat-client";

// The images the owner sends to Aril. The desktop app keeps them: this module only hands it the bytes of a new image
// and asks for the bytes of a stored one, through the desktop bridge or the paired-device routes. A drawn image is an
// object URL of this page, held in memory and revoked when the panel leaves.

type Bridge = { agentChatImage(operation: AgentChatImageOperationName, payload: Record<string, unknown>): Promise<unknown> };

const MEDIA_TYPES: Record<TaskImageType, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const PAIRED_ADD_PATH = "/api/agent-chat/image-add";
const PAIRED_READ_PATH = "/api/agent-chat/image-read";
const ADD_ERRORS = ["invalid", "not_found", "unavailable"] as const;
const UNAVAILABLE = { ok: false, error: "unavailable" } as const;

export const AGENT_CHAT_IMAGE_ACCEPT = TASK_IMAGE_TYPES.map((type) => MEDIA_TYPES[type]).join(",");

function bridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof candidate?.agentChatImage === "function" ? candidate as Bridge : undefined;
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);

/** Hands the desktop one image for a message that is not sent yet. It answers the image's ID, type, and size. */
export async function addAgentChatImage(repositoryId: string, bytes: Uint8Array): Promise<AgentChatImageAddResult> {
  try {
    const desktop = bridge();
    let answer: Record<string, unknown> | null;
    if (desktop) answer = record(await desktop.agentChatImage("add", { repositoryId, bytes }));
    else {
      const response = await fetch(`${PAIRED_ADD_PATH}?${new URLSearchParams({ repositoryId })}`, {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([new Uint8Array(bytes)]),
      });
      answer = response.ok ? record(await response.json().catch(() => null)) : null;
    }
    const image = answer?.ok === true ? parseAgentChatImage(answer.image) : null;
    if (image) return { ok: true, image };
    const error = ADD_ERRORS.find((candidate) => answer?.ok === false && candidate === answer.error);
    return error ? { ok: false, error } : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** The bytes of one image that a message of the conversation names, or null. */
export async function readAgentChatImage(repositoryId: string, conversationId: string, imageId: string): Promise<Blob | null> {
  try {
    const desktop = bridge();
    if (desktop) {
      const answer = record(await desktop.agentChatImage("read", { repositoryId, conversationId, imageId }));
      const type = TASK_IMAGE_TYPES.find((candidate) => candidate === answer?.type);
      const bytes = answer?.bytes;
      if (answer?.ok !== true || !type || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > AGENT_CHAT_BOUNDS.imageBytes) return null;
      return new Blob([new Uint8Array(bytes)], { type: MEDIA_TYPES[type] });
    }
    const response = await fetch(`${PAIRED_READ_PATH}?${new URLSearchParams({ repositoryId, conversationId, imageId })}`, { cache: "no-store" });
    const mediaType = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !Object.values(MEDIA_TYPES).includes(mediaType)) return null;
    const blob = await response.blob();
    return blob.size > 0 && blob.size <= AGENT_CHAT_BOUNDS.imageBytes ? new Blob([blob], { type: mediaType }) : null;
  } catch {
    return null;
  }
}

const MEGABYTES = AGENT_CHAT_BOUNDS.imageBytes / (1024 * 1024);
export const IMAGE_TYPE_MESSAGE = "Only PNG, JPEG, GIF and WebP images can be attached.";
export const IMAGE_SIZE_MESSAGE = `An image can be at most ${MEGABYTES} MB.`;
export const IMAGE_LIMIT_MESSAGE = `A message holds at most ${AGENT_CHAT_BOUNDS.imagesPerMessage} images.`;
export const IMAGE_ADD_FAILURE_MESSAGE = "The image could not be attached.";

/** The files a message can still take, and one fixed line for the first one it cannot. */
export function acceptChatImageFiles(files: readonly File[], held: number): { accepted: File[]; message: string | null } {
  const accepted: File[] = [];
  let message: string | null = null;
  for (const file of files) {
    const reason = !AGENT_CHAT_IMAGE_ACCEPT.split(",").includes(file.type) ? IMAGE_TYPE_MESSAGE
      : file.size === 0 || file.size > AGENT_CHAT_BOUNDS.imageBytes ? IMAGE_SIZE_MESSAGE
        : held + accepted.length >= AGENT_CHAT_BOUNDS.imagesPerMessage ? IMAGE_LIMIT_MESSAGE : null;
    if (reason === null) accepted.push(file);
    else message ??= reason;
  }
  return { accepted, message };
}

export type AgentChatImageUrls = ReadonlyMap<string, string>;

/** An image the thread draws, with the conversation whose message holds it: the desktop serves an image only through that message. */
export type AgentChatImageSource = { conversationId: string; imageId: string };

/**
 * The object URL of each image the panel draws. An image the owner just added is drawn from its own file (`remember`);
 * a stored one is read from the desktop once. Every URL is revoked when the panel leaves.
 */
export function useAgentChatImageUrls(repositoryId: string, sources: readonly AgentChatImageSource[]): { urls: AgentChatImageUrls; remember(imageId: string, blob: Blob): void } {
  const [urls, setUrls] = useState<AgentChatImageUrls>(() => new Map());
  const made = useRef(new Map<string, string>());
  const asked = useRef(new Set<string>());
  const live = useRef(true);

  const keep = useCallback((imageId: string, blob: Blob) => {
    if (!live.current || made.current.has(imageId)) return;
    made.current.set(imageId, URL.createObjectURL(blob));
    setUrls(new Map(made.current));
  }, []);

  useEffect(() => {
    live.current = true;
    const owned = made.current;
    return () => {
      live.current = false;
      for (const url of owned.values()) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  const wanted = sources.map(({ conversationId, imageId }) => `${conversationId}/${imageId}`).join(",");
  useEffect(() => {
    if (wanted === "") return;
    for (const source of wanted.split(",")) {
      const [conversationId, imageId] = source.split("/");
      if (made.current.has(imageId) || asked.current.has(imageId)) continue;
      asked.current.add(imageId);
      void readAgentChatImage(repositoryId, conversationId, imageId).then((blob) => { if (blob) keep(imageId, blob); });
    }
  }, [repositoryId, wanted, keep]);

  return { urls, remember: keep };
}

/** Every image the owner sent in the messages of the thread, with the conversation of its message. */
export function threadImageSources(messages: readonly { role: string; conversationId: string; images?: readonly AgentChatImage[] }[]): AgentChatImageSource[] {
  return messages.flatMap((message) => (message.role === "user" ? (message.images ?? []).map((image) => ({ conversationId: message.conversationId, imageId: image.id })) : []));
}
