import { TASK_EFFORTS, TASK_PROVIDERS, type TaskEffort } from "../../../shared/task-contract";
import { newestModel } from "../../../shared/task-run-models.mjs";
import type { AgentChatProvider } from "../../../shared/agent-chat-contract";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { EFFORT_LABELS, PROVIDER_LABELS, type TaskModelOptions } from "../tasks/task-fields";

// The run a chat message asks for: the provider, a model, and an effort. The chat never offers "default": a model is
// always a named one, and the label shows the provider's own name only for a provider with no known model at all.

export const CHAT_DEFAULT_EFFORT: TaskEffort = "medium";

export type ChatRun = { provider: AgentChatProvider; model: string | null; effort: TaskEffort };

/** A conversation as far as the run is concerned: what its last message ran with. A missing effort reads as none. */
export type ChatRunSource = { provider: AgentChatProvider; model: string | null; effort?: TaskEffort | null };

/**
 * The run a chat starts on. An open conversation keeps its provider, model, and effort; a stored conversation with no
 * model takes the newest known model of its provider. Otherwise the newest Claude model, else the newest Codex model.
 * Only when no model is known at all does the model stay null, and the provider's name is its label.
 */
export function initialChatRun(models: TaskModelOptions, stored: ChatRunSource | null): ChatRun {
  const effort = stored?.effort ?? CHAT_DEFAULT_EFFORT;
  if (stored) return { provider: stored.provider, model: stored.model ?? newestModel(models[stored.provider]), effort };
  const claude = newestModel(models.claude);
  if (claude !== null) return { provider: "claude", model: claude, effort };
  const codex = newestModel(models.codex);
  return codex !== null ? { provider: "codex", model: codex, effort } : { provider: "claude", model: null, effort };
}

/** The same run, with a model chosen for a null one when the provider has a known model: a null model is only for a provider with none. */
export function resolveChatRun(models: TaskModelOptions, run: ChatRun): ChatRun {
  return run.model === null ? { ...run, model: newestModel(models[run.provider]) } : run;
}

const modelValue = (provider: AgentChatProvider, model: string | null) => (model === null ? `${provider}:default` : `${provider}:model:${model}`);

/** The select value of a run's provider and model. */
export const chatModelValue = (run: Pick<ChatRun, "provider" | "model">) => modelValue(run.provider, run.model);

/** The provider and model a select value names, or null for a value that is neither. */
export function chatModelFromValue(value: string): Pick<ChatRun, "provider" | "model"> | null {
  const [provider, kind, ...rest] = value.split(":");
  if (!(TASK_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (kind === "model" && rest.length > 0) return { provider: provider as AgentChatProvider, model: rest.join(":") };
  return kind === "default" && rest.length === 0 ? { provider: provider as AgentChatProvider, model: null } : null;
}

/**
 * Every known model of each provider, grouped by provider, and never a "Default model". A provider with no known model
 * has one row, labelled with its own name, so a provider can still be chosen. The model a run already has is listed
 * even when the known models no longer include it.
 */
export function chatModelOptions(models: TaskModelOptions, run: Pick<ChatRun, "provider" | "model">): CommandSelectOption[] {
  const options: CommandSelectOption[] = [];
  for (const provider of TASK_PROVIDERS) {
    const names = new Set(models[provider]);
    if (run.provider === provider && run.model) names.add(run.model);
    const ordered = provider === "codex" ? [...names] : [...names].sort();
    if (ordered.length === 0) options.push({ value: modelValue(provider, null), label: PROVIDER_LABELS[provider] });
    for (const model of ordered) options.push({ value: modelValue(provider, model), label: model, group: PROVIDER_LABELS[provider] });
  }
  return options;
}

/** The four effort levels, labelled as the task forms label them. */
export const CHAT_EFFORT_OPTIONS: ReadonlyArray<CommandSelectOption> = TASK_EFFORTS.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }));

export const isChatEffort = (value: string): value is TaskEffort => (TASK_EFFORTS as readonly string[]).includes(value);
