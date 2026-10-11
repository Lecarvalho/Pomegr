import type { CommandSelectOption } from "../command-center/CommandSelect";
import type { FeatureInput } from "./task-features";
import type { ProviderSource } from "../../../shared/monitor-contract";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, TASK_PROVIDERS, type Task, type TaskCheck, type TaskEffort, type TaskProvider, type TaskRun } from "../../../shared/task-contract";

export const PROVIDER_LABELS: Record<TaskProvider, ProviderSource> = { claude: "Claude Code", codex: "Codex" };
export const EFFORT_LABELS: Record<TaskEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Xhigh" };
export const CHECK_LABELS: Record<TaskCheck, string> = {
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
};
export const CHECK_SHORT_LABELS: Record<TaskCheck, string> = {
  pr_open: "PR open",
  tree_clean: "Tree clean",
  commit_on_branch: "Commit on branch",
  pr_merged: "PR merged",
  ci_passed: "CI passed",
};

export const REMOTE_CONTROL_LABEL = "Remote Control";

export function plannedRunText(run: TaskRun) {
  return [run.model, run.effort && EFFORT_LABELS[run.effort].toLowerCase(), run.remoteControl === true && REMOTE_CONTROL_LABEL].filter(Boolean).join(" · ");
}

export function canRemoteControl(run: TaskRun): boolean {
  return run.provider !== "codex";
}

export function withRemoteControl(run: TaskRun, on: boolean): TaskRun {
  const { provider, model, effort } = run;
  const kept = run.keepWorktree === true ? { keepWorktree: true } : {};
  return on && canRemoteControl(run) ? { provider, model, effort, remoteControl: true, ...kept } : { provider, model, effort, ...kept };
}

export const REMOVE_WORKTREE_LABEL = "Remove worktree and branch when done";

/** Removal is the default, so the run carries the choice only when the worktree is kept. */
export function withKeepWorktree(run: TaskRun, keep: boolean): TaskRun {
  const { provider, model, effort } = run;
  return { provider, model, effort, ...(run.remoteControl === true ? { remoteControl: true } : {}), ...(keep ? { keepWorktree: true } : {}) };
}

export const EMPTY_RUN: TaskRun = { provider: null, model: null, effort: null };

export type TaskModelOptions = Record<TaskProvider, readonly string[]>;
export const NO_MODELS: TaskModelOptions = { claude: [], codex: [] };

const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+[\]-]*$/u;
const UNSET = "";

function modelVersion(model: string): { family: string; version: number[]; date: number } {
  const words: string[] = [];
  const version: number[] = [];
  let date = 0;
  for (const part of model.toLowerCase().split("-")) {
    if (/^\d{8}$/u.test(part)) date = Number(part);
    else if (/^\d+(?:\.\d+)*$/u.test(part)) version.push(...part.split(".").map(Number));
    else words.push(part);
  }
  return { family: words.join("-"), version, date };
}

function isNewerModel(candidate: ReturnType<typeof modelVersion>, current: ReturnType<typeof modelVersion>): boolean {
  for (let index = 0; index < Math.max(candidate.version.length, current.version.length); index += 1) {
    const difference = (candidate.version[index] ?? 0) - (current.version[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return candidate.date > current.date;
}

export function latestModels(models: Iterable<string>): string[] {
  const newest = new Map<string, { model: string; parsed: ReturnType<typeof modelVersion> }>();
  for (const model of models) {
    const parsed = modelVersion(model);
    const current = newest.get(parsed.family);
    if (!current || isNewerModel(parsed, current.parsed)) newest.set(parsed.family, { model, parsed });
  }
  return [...newest.values()].map((entry) => entry.model).sort();
}

/** Run on models per provider. */
export function modelsByProvider(
  runs: ReadonlyArray<{ source: string; model: string | null }>,
  codexCatalog: ReadonlyArray<{ id: string }> = [],
): TaskModelOptions {
  const claude = new Set<string>();
  for (const run of runs) {
    if (run.source === "Claude Code" && run.model && run.model.length <= TASK_BOUNDS.modelIdentifierLength && MODEL_IDENTIFIER.test(run.model)) claude.add(run.model);
  }
  const codex = codexCatalog.map((model) => model.id).filter((id) => id.length <= TASK_BOUNDS.modelIdentifierLength && MODEL_IDENTIFIER.test(id));
  return { claude: latestModels(claude), codex: [...new Set(codex)] };
}

export function runSelectValue(run: TaskRun): string {
  if (!run.provider) return UNSET;
  return run.model === null ? `${run.provider}:default` : `${run.provider}:model:${run.model}`;
}

export function runFromSelectValue(value: string, effort: TaskEffort | null): TaskRun {
  const [provider, kind, ...rest] = value.split(":");
  if (!TASK_PROVIDERS.includes(provider as TaskProvider)) return { ...EMPTY_RUN, effort };
  return { provider: provider as TaskProvider, model: kind === "model" ? rest.join(":") : null, effort };
}

export function runSelectOptions(models: TaskModelOptions, run: TaskRun): CommandSelectOption[] {
  const options: CommandSelectOption[] = [{ value: UNSET, label: "Not set" }];
  for (const provider of TASK_PROVIDERS) {
    const names = new Set(models[provider]);
    if (run.provider === provider && run.model) names.add(run.model);
    const ordered = provider === "codex" ? [...names] : [...names].sort();
    for (const model of ordered) options.push({ value: `${provider}:model:${model}`, label: model, group: PROVIDER_LABELS[provider] });
    options.push({ value: `${provider}:default`, label: "Default model", group: PROVIDER_LABELS[provider] });
  }
  return options;
}

export function isRunSet(run: TaskRun): boolean {
  return run.provider !== null || run.model !== null || run.effort !== null || run.remoteControl === true || run.keepWorktree === true;
}

export function isEffort(value: string): value is TaskEffort {
  return (TASK_EFFORTS as readonly string[]).includes(value);
}

export type CompleteWhenDraft = { checks: readonly TaskCheck[]; ownText: string };
export type CompleteWhenValue = { checks: TaskCheck[]; own: string | null };

export const DEFAULT_COMPLETE_WHEN: CompleteWhenDraft = { checks: ["pr_open", "tree_clean"], ownText: "" };

export function completeWhenFromTask(completeWhen: Task["completeWhen"]): CompleteWhenDraft {
  return { checks: [...completeWhen.checks], ownText: completeWhen.own ?? "" };
}

/** A new task starts from the Run on and Complete when of the newest task on the board. Removing its worktree when done is always on. */
export function newTaskDefaults(tasks: ReadonlyArray<Pick<Task, "id" | "run" | "completeWhen">>): { run: TaskRun; completeWhen: CompleteWhenDraft } {
  const number = (task: Pick<Task, "id">) => Number(task.id.slice(2));
  const newest = tasks.reduce<Pick<Task, "id" | "run" | "completeWhen"> | null>((latest, task) => (latest === null || number(task) > number(latest) ? task : latest), null);
  return newest === null ? { run: EMPTY_RUN, completeWhen: DEFAULT_COMPLETE_WHEN } : { run: withKeepWorktree(newest.run, false), completeWhen: completeWhenFromTask(newest.completeWhen) };
}

export function toCompleteWhen(draft: CompleteWhenDraft): CompleteWhenValue {
  const own = draft.ownText.trim().slice(0, TASK_BOUNDS.ownConditionLength);
  return { checks: TASK_CHECKS.filter((check) => draft.checks.includes(check)), own: own || null };
}

export function withCheck(draft: CompleteWhenDraft, check: TaskCheck, on: boolean): CompleteWhenDraft {
  return { ...draft, checks: on ? [...draft.checks.filter((existing) => existing !== check), check] : draft.checks.filter((existing) => existing !== check) };
}

export function createPayload(text: string, run: TaskRun, draft: CompleteWhenDraft, feature?: FeatureInput) {
  const completeWhen = toCompleteWhen(draft);
  return { text, ...(isRunSet(run) && { run }), ...((completeWhen.checks.length > 0 || completeWhen.own) && { completeWhen }), ...feature };
}

export function completeWhenSummary(completeWhen: Task["completeWhen"]): string | null {
  const parts = [
    completeWhen.checks.length > 0 && `${completeWhen.checks.length} ${completeWhen.checks.length === 1 ? "check" : "checks"}`,
    completeWhen.own !== null && "own condition",
  ].filter(Boolean);
  return parts.length === 0 ? null : `Complete when: ${[...parts, "agent report"].join(" + ")}`;
}

export function observedModelDiffers(planned: string | null, observed: string | null | undefined): boolean {
  if (!planned || !observed) return false;
  const left = planned.toLowerCase();
  const right = observed.toLowerCase();
  return !left.includes(right) && !right.includes(left);
}
