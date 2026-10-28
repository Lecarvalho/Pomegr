import { describe, expect, it } from "vitest";
import { agentCaption } from "../../app/components/agent-chat/agent-chat-presentation";
import { CHAT_DEFAULT_EFFORT, CHAT_EFFORT_OPTIONS, chatModelFromValue, chatModelOptions, chatModelValue, initialChatRun, resolveChatRun } from "../../app/components/agent-chat/agent-chat-run";
import { NO_MODELS } from "../../app/components/tasks/task-fields";
import { newestModel } from "../../shared/task-run-models.mjs";

describe("the newest model of a list", () => {
  it("compares across families by version, then by date, and keeps the first listed on a tie", () => {
    expect(newestModel(["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"])).toBe("claude-haiku-4-5-20251001");
    expect(newestModel(["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-3-5"])).toBe("claude-sonnet-4-5");
    expect(newestModel(["claude-sonnet-4-20250301", "claude-opus-4-20250514"])).toBe("claude-opus-4-20250514");
    expect(newestModel(["gpt-5.1-codex", "gpt-6.1-sol", "gpt-5.10-codex"])).toBe("gpt-6.1-sol");
    expect(newestModel(["gpt-5.2", "gpt-5.10"])).toBe("gpt-5.10");
    expect(newestModel(["model-large", "model-small"])).toBe("model-large");
  });

  it("answers null for no model and skips what is not a model identifier", () => {
    expect(newestModel([])).toBeNull();
    expect(newestModel(["not a model", "-x", ""])).toBeNull();
    expect(newestModel(["not a model", "claude-opus-4-1"])).toBe("claude-opus-4-1");
  });
});

describe("the run a chat starts on", () => {
  const models = { claude: ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929"], codex: ["gpt-6.1-sol", "gpt-5.1-codex"] };

  it("is the newest Claude model and Medium for a new conversation", () => {
    expect(initialChatRun(models, null)).toEqual({ provider: "claude", model: "claude-sonnet-4-5-20250929", effort: "medium" });
    expect(CHAT_DEFAULT_EFFORT).toBe("medium");
  });

  it("is the newest Codex model when no Claude model is known", () => {
    expect(initialChatRun({ claude: [], codex: models.codex }, null)).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "medium" });
  });

  it("is the provider with no model only when no model is known at all", () => {
    expect(initialChatRun(NO_MODELS, null)).toEqual({ provider: "claude", model: null, effort: "medium" });
  });

  it("keeps an open conversation's provider, model, and effort", () => {
    expect(initialChatRun(models, { provider: "codex", model: "gpt-5.1-codex", effort: "high" })).toEqual({ provider: "codex", model: "gpt-5.1-codex", effort: "high" });
    // A model the known list no longer holds is still the conversation's.
    expect(initialChatRun(models, { provider: "claude", model: "claude-retired", effort: "low" }).model).toBe("claude-retired");
  });

  it("gives a stored conversation with no model the newest known model of its provider, and no effort reads Medium", () => {
    expect(initialChatRun(models, { provider: "claude", model: null })).toEqual({ provider: "claude", model: "claude-sonnet-4-5-20250929", effort: "medium" });
    expect(initialChatRun(models, { provider: "codex", model: null, effort: null })).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "medium" });
    expect(initialChatRun(NO_MODELS, { provider: "codex", model: null })).toEqual({ provider: "codex", model: null, effort: "medium" });
  });

  it("takes a model for a null one as soon as the provider has a known model", () => {
    expect(resolveChatRun(models, { provider: "claude", model: null, effort: "high" })).toEqual({ provider: "claude", model: "claude-sonnet-4-5-20250929", effort: "high" });
    expect(resolveChatRun(NO_MODELS, { provider: "claude", model: null, effort: "high" }).model).toBeNull();
    expect(resolveChatRun(models, { provider: "claude", model: "claude-opus-4-1-20250805", effort: "high" }).model).toBe("claude-opus-4-1-20250805");
  });
});

describe("the model and effort options", () => {
  it("list the named models of each provider under the provider, Claude's sorted and Codex's in catalog order, and never a default", () => {
    const options = chatModelOptions({ claude: ["b-model", "a-model"], codex: ["z-model", "m-model"] }, { provider: "claude", model: "a-model" });
    expect(options.map((option) => [option.group, option.label])).toEqual([["Claude Code", "a-model"], ["Claude Code", "b-model"], ["Codex", "z-model"], ["Codex", "m-model"]]);
    expect(options.map((option) => option.value)).toEqual(["claude:model:a-model", "claude:model:b-model", "codex:model:z-model", "codex:model:m-model"]);
    expect(JSON.stringify(options)).not.toMatch(/default model/i);
  });

  it("give a provider with no known model one row with the provider's name and no group", () => {
    expect(chatModelOptions(NO_MODELS, { provider: "claude", model: null })).toEqual([
      { value: "claude:default", label: "Claude Code" }, { value: "codex:default", label: "Codex" },
    ]);
    expect(chatModelOptions({ claude: ["m-1"], codex: [] }, { provider: "claude", model: "m-1" })).toEqual([
      { value: "claude:model:m-1", label: "m-1", group: "Claude Code" }, { value: "codex:default", label: "Codex" },
    ]);
  });

  it("add the run's own model when the known list lacks it", () => {
    expect(chatModelOptions({ claude: ["m-1"], codex: [] }, { provider: "claude", model: "m-0" }).map((option) => option.label)).toEqual(["m-0", "m-1", "Codex"]);
  });

  it("read a select value back to a provider and a model, and refuse anything else", () => {
    expect(chatModelFromValue("codex:model:gpt-6.1-sol")).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(chatModelFromValue("claude:model:name:with:colons")).toEqual({ provider: "claude", model: "name:with:colons" });
    expect(chatModelFromValue("claude:default")).toEqual({ provider: "claude", model: null });
    for (const bad of ["", "claude", "claude:model", "claude:default:x", "gemini:model:x", "claude:other:x"]) expect(chatModelFromValue(bad), bad).toBeNull();
    expect(chatModelValue({ provider: "codex", model: "m" })).toBe("codex:model:m");
    expect(chatModelValue({ provider: "claude", model: null })).toBe("claude:default");
  });

  it("offer the four effort levels, labelled as the task forms label them", () => {
    expect(CHAT_EFFORT_OPTIONS.map((option) => [option.value, option.label])).toEqual([["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Xhigh"]]);
  });
});

describe("the caption of an answer", () => {
  it("names the provider, the model, and the effort when one is stored", () => {
    expect(agentCaption({ provider: "claude", model: "claude-opus-4-1", effort: "high" })).toBe("Claude Code · claude-opus-4-1 · High");
    expect(agentCaption({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" })).toBe("Codex · gpt-6.1-sol · Xhigh");
  });

  it("leaves an older answer's caption as it was, and reads a missing model as the default model", () => {
    expect(agentCaption({ provider: "claude", model: "claude-opus-4-1" })).toBe("Claude Code · claude-opus-4-1");
    expect(agentCaption({ provider: "claude", model: null, effort: null })).toBe("Claude Code · default model");
  });
});
