import { TASK_BOUNDS, type TaskActionError } from "../../../shared/task-contract";
import type { FeatureDetails, FeaturePatch } from "./task-desktop";

// The Feature modal's draft, its bounds, and its fixed words.

export type FeatureFormDraft = { name: string; description: string; appVersion: string };

export const EMPTY_FEATURE_DRAFT: FeatureFormDraft = { name: "", description: "", appVersion: "" };

export const FEATURE_DUPLICATE_MESSAGE = "Another feature already has this title.";
export const FEATURE_SAVE_FAILURE_MESSAGE = "The feature could not be saved.";
export const FEATURE_LIMIT_MESSAGE = `This board already holds ${TASK_BOUNDS.featuresPerRepository} features. Delete one first.`;
export const FEATURE_READ_FAILURE_MESSAGE = "The description and app version could not be read.";

/** Which fixed line a failed create or update shows: the duplicate title sits under the Title field, the others under the fields. */
export type FeatureFailure = "duplicate" | "limit" | "failed";

export function featureFailure(error: TaskActionError | "unavailable"): FeatureFailure {
  return error === "conflict" ? "duplicate" : error === "limit" ? "limit" : "failed";
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export const featureCount = (length: number, bound: number) => `${COUNT_FORMAT.format(length)} / ${COUNT_FORMAT.format(bound)}`;

export const featureDescriptionOver = (draft: FeatureFormDraft) => draft.description.length > TASK_BOUNDS.featureDescriptionLength;

/** A stored detail is nothing or text; a draft one is its trimmed text, and blank is nothing. */
const detail = (value: string) => value.trim();

/** What an edit changed in the title, the description and the app version. Empty when the draft equals the stored feature. */
export function featurePatch(stored: FeatureFormDraft, draft: FeatureFormDraft, details: FeatureDetails | null): FeaturePatch {
  const patch: FeaturePatch = {};
  if (draft.name.trim() !== stored.name) patch.name = draft.name.trim();
  // Until the read answers the two fields are disabled, so nothing in them can differ.
  if (details !== null) {
    if (detail(draft.description) !== (details.description ?? "")) patch.description = detail(draft.description) === "" ? null : detail(draft.description);
    if (detail(draft.appVersion) !== (details.appVersion ?? "")) patch.appVersion = detail(draft.appVersion) === "" ? null : detail(draft.appVersion);
  }
  return patch;
}

/** What a create sends beyond the title: only a detail that holds text. */
export function featureCreateDetails(draft: FeatureFormDraft): { description?: string; appVersion?: string } {
  return { ...(detail(draft.description) !== "" && { description: detail(draft.description) }), ...(detail(draft.appVersion) !== "" && { appVersion: detail(draft.appVersion) }) };
}
