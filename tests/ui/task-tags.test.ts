import { describe, expect, it } from "vitest";
import { spaceGluedTokens, splitTaskTags, splitTaskTitle, TASK_TAG_LIMIT } from "../../app/components/tasks/task-tags";

describe("splitTaskTags", () => {
  it("takes the leading run of bracket tokens off the start of the text", () => {
    expect(splitTaskTags("[ backend ] [ recce ] [bug] Coverage opens a shot.\n\nMore text.")).toEqual({
      tags: ["backend", "recce", "bug"], text: "Coverage opens a shot.\n\nMore text.", runLength: 28,
    });
  });

  it("takes a first line that holds only tags with the run, so the next line leads", () => {
    expect(splitTaskTags("[ frontend ] [ tech-debt ]\nMake plan-intent atomic\nProblem: two tabs")).toEqual({
      tags: ["frontend", "tech-debt"], text: "Make plan-intent atomic\nProblem: two tabs", runLength: 27,
    });
  });

  it("joins every leading line that holds only tags into the run, separated by any whitespace", () => {
    expect(splitTaskTags("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic")).toEqual({
      tags: ["frontend", "tech-debt", "ui"], text: "Make plan-intent consume atomic", runLength: 34,
    });
    expect(splitTaskTags("[a]\r\n[b]\t\n  [c]\nTitle")).toEqual({ tags: ["a", "b", "c"], text: "Title", runLength: 16 });
    expect(splitTaskTags("[a] [b]\n").tags).toEqual(["a", "b"]);
    expect(splitTaskTags("[a]\n\n\nTitle").text).toBe("Title");
  });

  it("joins the tokens at the start of the title line into the run, however many blank lines separate them from the tags", () => {
    expect(splitTaskTags("[ frontend ] [ tech-debt ]\n\n[ test ] Make plan-intent")).toEqual({
      tags: ["frontend", "tech-debt", "test"], text: "Make plan-intent", runLength: 37,
    });
    for (const gap of ["\n\n", "\r\n\r\n", "\n \n", "\n  \t\n", "\n\n\n"]) {
      expect(splitTaskTags(`[ frontend ] [ tech-debt ]${gap}[ test ] Make plan-intent`).tags, JSON.stringify(gap)).toEqual(["frontend", "tech-debt", "test"]);
    }
    // A body paragraph that starts with a bracket is the title line, so its leading tokens are tags.
    expect(splitTaskTags("[ui]\n\n[TODO] write tests")).toEqual({ tags: ["ui", "TODO"], text: "write tests", runLength: 13 });
    expect(splitTaskTags("[ui]\n\n[x] one\n[x] two")).toEqual({ tags: ["ui", "x"], text: "one\n[x] two", runLength: 10 });
    expect(splitTaskTags("[ui]\n\n")).toEqual({ tags: ["ui"], text: "", runLength: 6 });
  });

  it("stops a run that spans lines at the first line that is not a token, and at a token that touches text", () => {
    expect(splitTaskTags("[a]\n[b] Title\n[c] more")).toEqual({ tags: ["a", "b"], text: "Title\n[c] more", runLength: 8 });
    expect(splitTaskTags("[a]\n[b]c\nTitle")).toEqual({ tags: ["a"], text: "[b]c\nTitle", runLength: 4 });
    expect(splitTaskTags("[a]\n[image]\nTitle")).toEqual({ tags: ["a"], text: "[image]\nTitle", runLength: 4 });
    expect(splitTaskTags("[a]\n[needs design]\nTitle").tags).toEqual(["a"]);
  });

  it("counts the limit and the repeats across lines", () => {
    const lines = Array.from({ length: TASK_TAG_LIMIT + 1 }, (_, index) => `[t${index}]`).join("\n");
    expect(splitTaskTags(`${lines}\nTitle`)).toMatchObject({ tags: expect.any(Array), text: "[t8]\nTitle" });
    expect(splitTaskTags("[Bug]\n[bug]\n[ui]\nTitle").tags).toEqual(["Bug", "ui"]);
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

describe("spaceGluedTokens", () => {
  it("puts one space after a token of the run that touches the text after it, for the tokens that end in the range", () => {
    expect(spaceGluedTokens("[ui]Fix the cart", 3, 4)).toEqual({ text: "[ui] Fix the cart", added: 1 });
    expect(spaceGluedTokens("[ui]Fix", 4, 4)).toEqual({ text: "[ui] Fix", added: 1 });
    expect(spaceGluedTokens("  [ui]Fix", 6, 6)).toEqual({ text: "  [ui] Fix", added: 1 });
    expect(spaceGluedTokens("[a] [b]Title", 7, 7)).toEqual({ text: "[a] [b] Title", added: 1 });
  });

  it("spaces every glued token of a paste, one after the other", () => {
    expect(spaceGluedTokens("[a][b]Title", 0, 11)).toEqual({ text: "[a] [b] Title", added: 2 });
    expect(spaceGluedTokens("[a][b][c]", 0, 9)).toEqual({ text: "[a] [b] [c]", added: 2 });
    expect(spaceGluedTokens("[a]\n[b][c] x", 0, 12)).toEqual({ text: "[a]\n[b] [c] x", added: 1 });
  });

  it("leaves a token alone that is outside the range, outside the run, after a blank line, or the image word", () => {
    expect(spaceGluedTokens("[ui]Fix", 5, 7)).toBeNull();
    expect(spaceGluedTokens("Fix [ui]x", 0, 9)).toBeNull();
    expect(spaceGluedTokens("[image]x", 0, 8)).toBeNull();
    expect(spaceGluedTokens("\n[ui]x", 0, 6)).toBeNull();
    expect(spaceGluedTokens("[ui] Fix", 0, 8)).toBeNull();
    expect(spaceGluedTokens("[ui", 0, 3)).toBeNull();
  });

  it("spaces a glued token below blank lines, which are part of the run", () => {
    expect(spaceGluedTokens("[ui]\n\n[x]y", 0, 10)).toEqual({ text: "[ui]\n\n[x] y", added: 1 });
    expect(spaceGluedTokens("[ui]\r\n\r\n[x]y", 0, 12)).toEqual({ text: "[ui]\r\n\r\n[x] y", added: 1 });
  });

  it("stops at the limit, and does not space a token the run cannot take", () => {
    const words = Array.from({ length: TASK_TAG_LIMIT + 1 }, (_, index) => `[t${index}]`).join("");
    const result = spaceGluedTokens(words, 0, words.length)!;
    expect(splitTaskTags(result.text).tags).toHaveLength(TASK_TAG_LIMIT);
    expect(result.added).toBe(TASK_TAG_LIMIT);
  });
});

describe("splitTaskTitle", () => {
  it("takes the title from the first text after a run that spans lines", () => {
    expect(splitTaskTitle("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic\nProblem: two tabs")).toEqual({
      tags: ["frontend", "tech-debt", "ui"], title: "Make plan-intent consume atomic", rest: "Problem: two tabs",
    });
    expect(splitTaskTitle("[a]\n[b]\n\nTitle")).toEqual({ tags: ["a", "b"], title: "Title", rest: "" });
    expect(splitTaskTitle("[a]\n[b]")).toEqual({ tags: [], title: "[a] [b]", rest: "" });
    // The leading tokens of the title line are tags, also below a blank line.
    expect(splitTaskTitle("[ui]\n\n[TODO] write tests\nmore")).toEqual({ tags: ["ui", "TODO"], title: "write tests", rest: "more" });
    expect(splitTaskTitle("[ui]\n\n[x] one\n[x] two")).toEqual({ tags: ["ui", "x"], title: "one", rest: "[x] two" });
    expect(splitTaskTitle("[ frontend ] [ tech-debt ]\n[ ui ]\n")).toEqual({ tags: [], title: "[ frontend ] [ tech-debt ] [ ui ]", rest: "" });
    expect(splitTaskTitle("[ frontend ] [ tech-debt ]\n\n[ ui ]\n")).toEqual({ tags: [], title: "[ frontend ] [ tech-debt ] [ ui ]", rest: "" });
  });

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
