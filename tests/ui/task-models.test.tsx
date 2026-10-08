import { describe, expect, it } from "vitest";
import { latestModels, modelsByProvider, runSelectOptions } from "../../app/components/tasks/task-fields";

describe("task model options", () => {
  it("keeps only the newest model of each family", () => {
    expect(latestModels([
      "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-opus-5-5",
      "claude-sonnet-4-20250514", "claude-sonnet-4-5-20250929", "claude-3-5-sonnet-20241022",
      "claude-haiku-4-5-20251001",
    ])).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-4-5-20250929"]);
  });

  it("compares versions by number and uses the date only as a tie-break", () => {
    expect(latestModels(["gpt-5.1-codex", "gpt-5.10-codex", "gpt-5.2-codex"])).toEqual(["gpt-5.10-codex"]);
    expect(latestModels(["claude-sonnet-4-20250514", "claude-sonnet-4-20250301"])).toEqual(["claude-sonnet-4-20250514"]);
    expect(latestModels(["claude-opus-4-1", "claude-opus-4"])).toEqual(["claude-opus-4-1"]);
  });

  it("treats a variant as its own family", () => {
    expect(latestModels(["gpt-5", "gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "claude-opus-4-7[1m]", "claude-opus-4-7"]))
      .toEqual(["claude-opus-4-7", "claude-opus-4-7[1m]", "gpt-5", "gpt-5.1-codex", "gpt-5.1-codex-mini"]);
  });

  it("lists Claude's newest observed models and Codex's committed catalog in catalog order", () => {
    const models = modelsByProvider([
      { source: "Claude Code", model: "claude-opus-4-1" },
      { source: "Claude Code", model: "claude-opus-5-5" },
      { source: "Codex", model: "codex-auto-review" },
      { source: "Codex", model: "gpt-5.1-codex" },
      { source: "Other", model: "claude-opus-9" },
      { source: "Claude Code", model: null },
    ], [{ id: "gpt-6.1-sol" }, { id: "gpt-5.1-codex" }, { id: "not a model" }, { id: "gpt-6.1-sol" }]);
    expect(models).toEqual({ claude: ["claude-opus-5-5"], codex: ["gpt-6.1-sol", "gpt-5.1-codex"] });
  });

  it("offers only the Default model for Codex until a catalog is committed", () => {
    const models = modelsByProvider([{ source: "Codex", model: "codex-auto-review" }]);
    expect(models.codex).toEqual([]);
    const labels = runSelectOptions(models, { provider: null, model: null, effort: null }).filter((option) => option.group === "Codex").map((option) => option.label);
    expect(labels).toEqual(["Default model"]);
  });

  it("keeps a task's stored older model selectable", () => {
    const models = { claude: ["claude-opus-5-5"], codex: [] };
    const labels = runSelectOptions(models, { provider: "claude", model: "claude-opus-4-1", effort: null }).map((option) => option.label);
    expect(labels).toContain("claude-opus-4-1");
    expect(labels).toContain("claude-opus-5-5");
  });

  it("keeps a stored Codex model outside the catalog selectable and lists catalog models", () => {
    const models = modelsByProvider([], [{ id: "gpt-6.1-sol" }]);
    const labels = runSelectOptions(models, { provider: "codex", model: "gpt-5-old", effort: null }).filter((option) => option.group === "Codex").map((option) => option.label);
    expect(labels).toEqual(["gpt-6.1-sol", "gpt-5-old", "Default model"]);
  });
});
