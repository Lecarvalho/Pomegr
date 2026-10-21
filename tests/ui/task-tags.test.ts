import { describe, expect, it } from "vitest";
import { splitTaskTags, splitTaskTitle, TASK_TAG_LIMIT } from "../../app/components/tasks/task-tags";

describe("splitTaskTags", () => {
  it("takes the leading run of bracket tokens off the first line", () => {
    expect(splitTaskTags("[ backend ] [ recce ] [bug] Coverage opens a shot.\n\nMore text.")).toEqual({
      tags: ["backend", "recce", "bug"], text: "Coverage opens a shot.\n\nMore text.", runLength: 28,
    });
  });

  it("removes a first line that holds only tags, so the next line leads", () => {
    expect(splitTaskTags("[ frontend ] [ tech-debt ]\nMake plan-intent atomic\nProblem: two tabs")).toEqual({
      tags: ["frontend", "tech-debt"], text: "Make plan-intent atomic\nProblem: two tabs", runLength: 26,
    });
  });

  it("leaves brackets that are not at the start of the first line", () => {
    expect(splitTaskTags("Fix [ bug ] in the cart")).toEqual({ tags: [], text: "Fix [ bug ] in the cart", runLength: 0 });
    expect(splitTaskTags("\n[ bug ] second line")).toEqual({ tags: [], text: "\n[ bug ] second line", runLength: 0 });
  });

  it("stops at a token that is glued to text or holds spaces or other characters", () => {
    expect(splitTaskTags("[bug]fix it").tags).toEqual([]);
    expect(splitTaskTags("[ needs design ] later").tags).toEqual([]);
    expect(splitTaskTags("[ ok ] [a/b] rest")).toEqual({ tags: ["ok"], text: "[a/b] rest", runLength: 7 });
    expect(splitTaskTags("[-x] rest").tags).toEqual([]);
  });

  it("never takes the image word or an image marker", () => {
    expect(splitTaskTags("[image] Screenshot of the bug").tags).toEqual([]);
    expect(splitTaskTags("[image:img-0123456789ab] Screenshot").tags).toEqual([]);
    expect(splitTaskTags("[ ui ] [image] Screenshot")).toEqual({ tags: ["ui"], text: "[image] Screenshot", runLength: 7 });
  });

  it("drops a repeated word and keeps the first spelling", () => {
    expect(splitTaskTags("[Bug] [bug] [ui] Title").tags).toEqual(["Bug", "ui"]);
  });

  it("takes at most the limit and leaves the rest as text", () => {
    const words = Array.from({ length: TASK_TAG_LIMIT + 2 }, (_, index) => `[t${index}]`).join(" ");
    const result = splitTaskTags(`${words} Title`);
    expect(result.tags).toHaveLength(TASK_TAG_LIMIT);
    expect(result.text).toBe("[t8] [t9] Title");
  });

  it("accepts a word of 24 characters and refuses 25", () => {
    expect(splitTaskTags(`[${"a".repeat(24)}] x`).tags).toHaveLength(1);
    expect(splitTaskTags(`[${"a".repeat(25)}] x`).tags).toEqual([]);
  });

  it("keeps a text with no run unchanged", () => {
    expect(splitTaskTags("Plain title")).toEqual({ tags: [], text: "Plain title", runLength: 0 });
    expect(splitTaskTags("")).toEqual({ tags: [], text: "", runLength: 0 });
  });

  it("takes a word with combining marks, typed decomposed or in a script that needs them", () => {
    expect(splitTaskTags("[cafe\u0301] [हिन्दी] [日本語] rest").tags).toEqual(["cafe\u0301", "हिन्दी", "日本語"]);
    expect(splitTaskTags("[\u0301cafe] rest").tags).toEqual([]);
  });
});

describe("splitTaskTitle", () => {
  it("takes the tags, then the rest of the first line as the title, then the rest", () => {
    expect(splitTaskTitle("[ backend ] [bug] Fix the retry\nIt retries too often.\n\nMore.")).toEqual({
      tags: ["backend", "bug"], title: "Fix the retry", rest: "It retries too often.\n\nMore.",
    });
    expect(splitTaskTitle("Plain title")).toEqual({ tags: [], title: "Plain title", rest: "" });
  });

  it("lets the next non-empty line lead after a first line of only tags, skipping blank lines of any kind", () => {
    expect(splitTaskTitle("[ui]\n\nFix the login\nmore")).toEqual({ tags: ["ui"], title: "Fix the login", rest: "more" });
    expect(splitTaskTitle("[ui]\n   \n\t\nFix\nmore").title).toBe("Fix");
    expect(splitTaskTitle("[ui] [x]\r\n\r\nFix\r\nmore")).toEqual({ tags: ["ui", "x"], title: "Fix", rest: "more" });
  });

  it("skips blank lines before the title when the text has no tags", () => {
    expect(splitTaskTitle("\n\n  Fix the login  \nmore")).toEqual({ tags: [], title: "Fix the login", rest: "more" });
  });

  it("leaves a leading heading mark out of the title, and keeps a mark that is not one", () => {
    expect(splitTaskTitle("## Fix the parser\nIt drops rows.")).toEqual({ tags: [], title: "Fix the parser", rest: "It drops rows." });
    expect(splitTaskTitle("[ui] # Fix").title).toBe("Fix");
    expect(splitTaskTitle("#hashtag first").title).toBe("#hashtag first");
    expect(splitTaskTitle("####### seven marks").title).toBe("####### seven marks");
    expect(splitTaskTitle("#").title).toBe("#");
  });

  it("makes a text of only tags its own bare title, with no tags", () => {
    expect(splitTaskTitle("[wip] [ui]")).toEqual({ tags: [], title: "[wip] [ui]", rest: "" });
    expect(splitTaskTitle("  [wip] [ui]  \n\n  \n")).toEqual({ tags: [], title: "[wip] [ui]", rest: "" });
    expect(splitTaskTitle("[wip]\r\n")).toEqual({ tags: [], title: "[wip]", rest: "" });
  });

  it("returns nothing for a text with no characters", () => {
    expect(splitTaskTitle("")).toEqual({ tags: [], title: "", rest: "" });
    expect(splitTaskTitle(" \n \r\n")).toEqual({ tags: [], title: "", rest: "" });
  });
});
