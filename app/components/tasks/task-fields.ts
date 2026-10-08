import type { CommandSelectOption } from "../command-center/CommandSelect";
import type { FeatureInput } from "./task-features";
import type { ProviderSource } from "../../../shared/monitor-contract";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, TASK_PROVIDERS, type Task, type TaskCheck, type TaskEffort, type TaskProvider, type TaskRun } from "../../../shared/task-contract";

// Pure helpers behind the Run on, Effort and Done when fields shared by the New task and Task panels.

export const PROVIDER_LABELS: Record<TaskProvider, ProviderSource> = { claude: "Claude Code", codex: "Codex" };
export const EFFORT_LABELS: Record<TaskEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Xhigh" };
export const CHECK_LABELS: Record<TaskCheck, string> = {
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
};

export const EMPTY_RUN: TaskRun = { provider: null, model: null, effort: null };

/** Models the app has observed per provider. A provider with none offers only its Default model. */
export type TaskModelOptions = Record<TaskProvider, readonly string[]>;
export const NO_MODELS: TaskModelOptions = { claude: [], codex: [] };

const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+[\]-]*$/u;
const UNSET = "";

/** Distinct, valid model identifiers seen in agent runs, per provider. Nothing is invented. */
export function modelsByProvider(runs: ReadonlyArray<{ source: string; model: string | null }>): TaskModelOptions {
  const found: Record<TaskProvider, Set<string>> = { claude: new Set(), codex: new Set() };
  for (const run of runs) {
    const provider = run.source === "Claude Code" ? "claude" : run.source === "Codex" ? "codex" : null;
    if (provider && run.model && run.model.length <= TASK_BOUNDS.modelIdentifierLength && MODEL_IDENTIFIER.test(run.model)) found[provider].add(run.model);
  }
  return { claude: [...found.claude].sort(), codex: [...found.codex].sort() };
}

/** `provider:default` is the provider's default model; `provider:model:<id>` a named model. A model needs a provider. */
export function runSelectValue(run: TaskRun): string {
  if (!run.provider) return UNSET;
  return run.model === null ? `${run.provider}:default` : `${run.provider}:model:${run.model}`;
}

export function runFromSelectValue(value: string, effort: TaskEffort | null): TaskRun {
  const [provider, kind, ...rest] = value.split(":");
  if (!TASK_PROVIDERS.includes(provider as TaskProvider)) return { ...EMPTY_RUN, effort };
  return { provider: provider as TaskProvider, model: kind === "model" ? rest.join(":") : null, effort };
}

/**
 * "Not set", then one group per provider holding its models and its Default model.
 * A stored model that is no longer observed stays selectable so the closed control still names it.
 */
export function runSelectOptions(models: TaskModelOptions, run: TaskRun): CommandSelectOption[] {
  const options: CommandSelectOption[] = [{ value: UNSET, label: "Not set" }];
  for (const provider of TASK_PROVIDERS) {
    const names = new Set(models[provider]);
    if (run.provider === provider && run.model) names.add(run.model);
    for (const model of [...names].sort()) options.push({ value: `${provider}:model:${model}`, label: model, group: PROVIDER_LABELS[provider] });
    options.push({ value: `${provider}:default`, label: "Default model", group: PROVIDER_LABELS[provider] });
  }
  return options;
}

export function isRunSet(run: TaskRun): boolean {
  return run.provider !== null || run.model !== null || run.effort !== null;
}

export function isEffort(value: string): value is TaskEffort {
  return (TASK_EFFORTS as readonly string[]).includes(value);
}

/** Editable form of `doneWhen`: the own condition keeps its text while its checkbox is off. */
export type DoneWhenDraft = { checks: readonly TaskCheck[]; ownEnabled: boolean; ownText: string };
export type DoneWhenValue = { checks: TaskCheck[]; own: string | null };

/** A new task starts with Pull request open and Working tree clean checked. */
export const DEFAULT_DONE_WHEN: DoneWhenDraft = { checks: ["pr_open", "tree_clean"], ownEnabled: false, ownText: "" };

export function doneWhenFromTask(doneWhen: Task["doneWhen"]): DoneWhenDraft {
  return { checks: [...doneWhen.checks], ownEnabled: doneWhen.own !== null, ownText: doneWhen.own ?? "" };
}

/** Checks in catalog order; the own condition is sent only while its checkbox is on and its text is not blank. */
export function toDoneWhen(draft: DoneWhenDraft): DoneWhenValue {
  const own = draft.ownText.trim().slice(0, TASK_BOUNDS.ownConditionLength);
  return { checks: TASK_CHECKS.filter((check) => draft.checks.includes(check)), own: draft.ownEnabled && own ? own : null };
}

export function withCheck(draft: DoneWhenDraft, check: TaskCheck, on: boolean): DoneWhenDraft {
  return { ...draft, checks: on ? [...draft.checks.filter((existing) => existing !== check), check] : draft.checks.filter((existing) => existing !== check) };
}

/** Create payload: `run`, `doneWhen` and the feature keys are omitted when nothing is set. */
export function createPayload(text: string, run: TaskRun, draft: DoneWhenDraft, feature?: FeatureInput) {
  const doneWhen = toDoneWhen(draft);
  return { text, ...(isRunSet(run) && { run }), ...((doneWhen.checks.length > 0 || doneWhen.own) && { doneWhen }), ...feature };
}

/** Card line: what is checked, ending with the agent's report. Null when no condition is set. */
export function doneWhenSummary(doneWhen: Task["doneWhen"]): string | null {
  const parts = [
    doneWhen.checks.length > 0 && `${doneWhen.checks.length} ${doneWhen.checks.length === 1 ? "check" : "checks"}`,
    doneWhen.own !== null && "own condition",
  ].filter(Boolean);
  return parts.length === 0 ? null : `Done when: ${[...parts, "agent report"].join(" + ")}`;
}

/** True only when a model is planned and the latest recorded request used another one. */
export function observedModelDiffers(planned: string | null, observed: string | null | undefined): boolean {
  return planned !== null && Boolean(observed) && observed !== planned;
}
