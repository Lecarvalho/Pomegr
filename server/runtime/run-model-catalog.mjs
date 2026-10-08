// The last committed Codex client catalog, kept in memory for the task panel's Run on list.
// It taps the observations the release scheduler already reads for model notifications; it never reads
// a catalog itself, so serving it acquires nothing. Labels come with the committed rows.

/** `accept` receives the scheduler's model observations; `codex()` returns `{ id, label }` rows or []. */
export function createRunModelCatalog() {
  let codex = [];
  return Object.freeze({
    accept(values) {
      if (!Array.isArray(values)) return;
      for (const value of values) {
        if (value?.provider !== "codex" || !Array.isArray(value.models)) continue;
        codex = value.status === "ready" && value.complete === true
          ? value.models.map((model) => ({ id: model?.id, label: model?.label ?? null }))
          : [];
      }
    },
    codex: () => codex,
  });
}
