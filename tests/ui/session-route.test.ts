import { describe, expect, it } from "vitest";
import { decodeSessionRoute, encodeSessionRoute } from "../../shared/session-route.mjs";

describe("session route segments", () => {
  it.each([
    ["codex:thread-with-hyphen.one_2", "codex-thread-with-hyphen.one_2"],
    ["claude:task-with-hyphen.one_2", "claude-task-with-hyphen.one_2"],
    ["cursor:future-provider", "cursor-future-provider"],
  ])("encodes %s as %s", (internal, segment) => {
    expect(encodeSessionRoute(internal)).toBe(segment);
    expect(decodeSessionRoute(segment)).toBe(internal);
  });

  it("preserves opaque hyphens, dots, and underscores", () => {
    const segment = encodeSessionRoute("codex:a-b.c_d-42");
    expect(segment).toBe("codex-a-b.c_d-42");
    expect(decodeSessionRoute(segment)).toBe("codex:a-b.c_d-42");
  });

  it.each([
    "codex",
    "codex-",
    "claude-",
    "codex%3Athread",
    `codex-${"x".repeat(129)}`,
    "codex-thread/extra",
  ])("rejects malformed route segment %s", (segment) => {
    expect(decodeSessionRoute(segment)).toBeNull();
  });

  it("decodes syntactically valid unknown providers for registry validation", () => {
    expect(decodeSessionRoute("openai-thread")).toBe("openai:thread");
  });

  it("rejects malformed internal IDs before encoding", () => {
    expect(() => encodeSessionRoute("codex:thread/extra")).toThrow("Invalid session ID");
    expect(() => encodeSessionRoute("codex:" + "x".repeat(129))).toThrow("Invalid session ID");
    expect(() => encodeSessionRoute("open-ai:thread")).toThrow("Invalid session ID");
  });
});
