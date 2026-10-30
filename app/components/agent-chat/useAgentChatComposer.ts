"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_CHAT_BOUNDS, type AgentChatImage, type AgentChatProvider } from "../../../shared/agent-chat-contract";
import type { TaskEffort } from "../../../shared/task-contract";
import { useTasks } from "../../tasks-store";
import { useTaskModelOptions } from "../tasks/task-panel-hooks";
import {
  IMAGE_ADD_FAILURE_MESSAGE, IMAGE_TYPE_MESSAGE, acceptChatImageFiles, addAgentChatImage, useAgentChatImageUrls,
  type AgentChatImageSource,
} from "./agent-chat-images";
import { chatModelFromValue, chatModelOptions, chatModelValue, initialChatRun, resolveChatRun, type ChatRunSource } from "./agent-chat-run";

// What the owner chose over the run the thread would start on.
type ChosenRun = { pick?: { provider: AgentChatProvider; model: string | null }; effort?: TaskEffort };

const NO_SOURCES: readonly AgentChatImageSource[] = [];

/**
 * The state of one composer: the message being written, the run it will ask for, and the images it will carry. The panel and
 * Home both draw the same composer from it. The run starts from what the thread last ran with, else the newest known model and
 * Medium; it is never a default. When the repository changes, the images and the owner's choice of run are dropped and the
 * draft is kept, because an image is held for one repository and a model list belongs to its board.
 */
export function useAgentChatComposer(repositoryId: string, threadRun: ChatRunSource | null, threadImages: readonly AgentChatImageSource[] = NO_SOURCES) {
  const { board, refresh } = useTasks(repositoryId);
  const models = useTaskModelOptions(board.runModels);
  const [draft, setDraft] = useState("");
  const [chosen, setChosen] = useState<ChosenRun>({});
  // The images of the message being written: the desktop app holds their bytes, this holds what it answered.
  const [attached, setAttached] = useState<readonly AgentChatImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const { urls: imageUrls, remember } = useAgentChatImageUrls(repositoryId, threadImages);
  const [scope, setScope] = useState(repositoryId);
  if (scope !== repositoryId) {
    setScope(repositoryId);
    setChosen({});
    setAttached([]);
    setImageError(null);
  }
  // An image that finishes uploading after the repository changed belongs to the old one and is dropped.
  const current = useRef(repositoryId);
  useEffect(() => { current.current = repositoryId; }, [repositoryId]);

  const base = initialChatRun(models, threadRun);
  const run = resolveChatRun(models, { ...base, ...chosen.pick, effort: chosen.effort ?? base.effort });
  const modelOptions = chatModelOptions(models, run);

  const chooseModel = useCallback((value: string) => {
    const pick = chatModelFromValue(value);
    if (pick) setChosen((previous) => ({ ...previous, pick }));
  }, []);
  const chooseEffort = useCallback((effort: TaskEffort) => setChosen((previous) => ({ ...previous, effort })), []);

  const attach = async (files: File[]) => {
    const { accepted, message } = acceptChatImageFiles(files, attached.length + uploading);
    setImageError(message);
    for (const file of accepted) {
      setUploading((count) => count + 1);
      const answer = await addAgentChatImage(repositoryId, new Uint8Array(await file.arrayBuffer()));
      setUploading((count) => count - 1);
      if (current.current !== repositoryId) continue;
      if (!answer.ok) { setImageError(answer.error === "invalid" ? IMAGE_TYPE_MESSAGE : IMAGE_ADD_FAILURE_MESSAGE); continue; }
      remember(answer.image.id, file);
      setAttached((held) => (held.length < AGENT_CHAT_BOUNDS.imagesPerMessage ? [...held, answer.image] : held));
    }
  };
  const removeImage = (imageId: string) => { setImageError(null); setAttached((held) => held.filter((image) => image.id !== imageId)); };

  return {
    board, refresh, run, modelOptions, modelValue: chatModelValue(run), chooseModel, chooseEffort,
    draft, setDraft, attached, setAttached, uploading: uploading > 0, imageError, setImageError, imageUrls, attach, removeImage,
  };
}
