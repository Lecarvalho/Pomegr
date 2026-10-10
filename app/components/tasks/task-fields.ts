import type { CommandSelectOption } from "../command-center/CommandSelect";
import type { FeatureInput } from "./task-features";
import type { ProviderSource } from "../../../shared/monitor-contract";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, TASK_PROVIDERS, type Task, type TaskCheck, type TaskEffort, type TaskProvider, type TaskRun } from "../../../shared/task-contract";

// Pure helpers behind the Run on, Effort and Done when fields shared by the New task and Task modal forms.

export const PROVIDER_LABELS: Record<TaskProvider, ProviderSource> = { claude: "Claude Code", codex: "Codex" };
export const EFFORT_LABELS: Record<TaskEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Xhigh" };
export const CHECK_LABELS: Record<TaskCheck, string> = {
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
};
/** The short check copy of the task modal's Done when row (design contract G148-G149). Cards and the session view keep CHECK_LABELS. */
export const CHECK_SHORT_LABELS: Record<TaskCheck, string> = {
  pr_open: "PR open",
  tree_clean: "Tree clean",
  commit_on_branch: "Commit on branch",
  pr_merged: "PR merged",
  ci_passed: "CI passed",
};

/** Planned model and effort, for example "opus · high"; each only when set. */
export function plannedRunText(run: TaskRun) {
  return [run.model, run.effort && EFFORT_LABELS[run.effort].toLowerCase()].filter(Boolean).join(" · ");
}

export const EMPTY_RUN: TaskRun = { provider: null, model: null, effort: null };

/** Models the app has observed per provider. A provider with none offers only its Default model. */
export type TaskModelOptions = Record<TaskProvider, readonly string[]>;
export const NO_MODELS: TaskModelOptions = { claude: [], codex: [] };

const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+[\]-]*$/u;
const UNSET = "";

/** A model identifier split into its family (the words) and its version (the numbers), for example `claude-opus` and 4.1. */
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

/**
 * The newest observed model of each family, so `claude-opus-4-1` hides `claude-opus-4`. A heuristic on the
 * identifier's numbers: a variant such as `[1m]` or `-mini` is its own family, and nothing is invented.
 */
export function latestModels(models: Iterable<string>): string[] {
  const newest = new Map<string, { model: string; parsed: ReturnType<typeof modelVersion> }>();
  for (const model of models) {
    const parsed = modelVersion(model);
    const current = newest.get(parsed.family);
    if (!current || isNewerModel(parsed, current.parsed)) newest.set(parsed.family, { model, parsed });
  }
  return [...newest.values()].map((entry) => entry.model).sort();
}

/**
 * Run on models per provider. Claude offers the newest valid identifier of each family seen in agent runs.
 * Codex offers only the monitor's committed client catalog, in catalog order (never observed runs, which include
 * internal identifiers, and never account entitlement). Nothing is invented.
 */
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
    const ordered = provider === "codex" ? [...names] : [...names].sort();
    for (const model of ordered) options.push({ value: `${provider}:model:${model}`, label: model, group: PROVIDER_LABELS[provider] });
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

/** Editable form of `doneWhen`: a non-blank own-condition text is the own condition, a blank one is none. */
export type DoneWhenDraft = { checks: readonly TaskCheck[]; ownText: string };
export type DoneWhenValue = { checks: TaskCheck[]; own: string | null };

/** A new task starts with Pull request open and Working tree clean checked. */
export const DEFAULT_DONE_WHEN: DoneWhenDraft = { checks: ["pr_open", "tree_clean"], ownText: "" };

export function doneWhenFromTask(doneWhen: Task["doneWhen"]): DoneWhenDraft {
  return { checks: [...doneWhen.checks], ownText: doneWhen.own ?? "" };
}

/** Checks in catalog order; the own condition is the trimmed text, or null while it is blank. */
export function toDoneWhen(draft: DoneWhenDraft): DoneWhenValue {
  const own = draft.ownText.trim().slice(0, TASK_BOUNDS.ownConditionLength);
  return { checks: TASK_CHECKS.filter((check) => draft.checks.includes(check)), own: own || null };
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

/**
 * True only when a model is planned and the latest recorded request used another one. Equal ignoring case, or one
 * containing the other (a planned family alias such as `opus` against `claude-opus-4-1`), is the same model.
 * With Default model planned (null) there is nothing to compare.
 */
export function observedModelDiffers(planned: string | null, observed: string | null | undefined): boolean {
  if (!planned || !observed) return false;
  const left = planned.toLowerCase();
  const right = observed.toLowerCase();
  return !left.includes(right) && !right.includes(left);
}
