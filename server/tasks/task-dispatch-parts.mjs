import crypto from "node:crypto";

export const TASK_START_PROVIDERS = Object.freeze(["claude", "codex"]);
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
export const digestOf = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");
export const CHECK_LABELS = Object.freeze({
  pr_open: "Pull request open", tree_clean: "Working tree clean", commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged", ci_passed: "CI passed", user_validated: "Validated with the user",
});

// The feature's title and ID only: the session reads the rest with `get_feature` when it needs it.
export function featureLine(feature) {
  if (typeof feature?.id !== "string" || typeof feature.title !== "string") return [];
  return [`This task is part of the feature "${feature.title}" (${feature.id}). When you need the feature's description or app version, call the Pomegr MCP tool get_feature.`];
}

