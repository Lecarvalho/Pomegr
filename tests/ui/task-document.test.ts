import { describe, expect, it } from "vitest";
import { taskBlocks, taskDocument, taskInlines } from "../../app/components/tasks/task-document";

// The read view of a started task draws its text as a document. The split is a display heuristic: it never judges the task.

const text = (value: string) => ({ kind: "text", text: value });
const data = (value: string) => ({ kind: "data", text: value });
const code = (value: string) => ({ kind: "code", text: value });

describe("taskDocument", () => {
  it("takes the tags of the first line, the rest of that line as the title, and the rest as blocks", () => {
    const document = taskDocument("[ backend ] [bug] Fix the retry\nIt retries too often.");
    expect(document.tags).toEqual(["backend", "bug"]);
    expect(document.title).toEqual([text("Fix the retry")]);
    expect(document.blocks).toEqual([{ kind: "paragraph", inlines: [text("It retries too often.")], joined: false }]);
  });

  it("lets the next line lead when the first line holds only tags", () => {
    const document = taskDocument("[a] [b]\nThe title\nThe body.");
    expect(document.tags).toEqual(["a", "b"]);
    expect(document.title).toEqual([text("The title")]);
    expect(document.blocks).toHaveLength(1);
  });

  it("keeps a text that holds nothing but tags as its title, with no chips", () => {
    expect(taskDocument("[a] [b]")).toEqual({ tags: [], title: [text("[a] [b]")], blocks: [] });
  });

  it("keeps brackets that do not start the first line, and a repeated word shows once", () => {
    expect(taskDocument("Fix [bug] now").tags).toEqual([]);
    expect(taskDocument("[bug] [Bug] Fix it").tags).toEqual(["bug"]);
  });

  it("reads a Windows line break like a line break", () => {
    const document = taskDocument("Title\r\nOne\r\nTwo");
    expect(document.title).toEqual([text("Title")]);
    expect(document.blocks).toEqual([{ kind: "paragraph", inlines: [text("One\nTwo")], joined: false }]);
  });

  it("skips blank lines before the title, with or without tags, and in a Windows text", () => {
    expect(taskDocument("[ui]\n\nFix the login\nmore")).toEqual({
      tags: ["ui"], title: [text("Fix the login")], blocks: [{ kind: "paragraph", inlines: [text("more")], joined: false }],
    });
    expect(taskDocument("[ui] [x]\r\n  \r\nFix\r\nmore").title).toEqual([text("Fix")]);
    expect(taskDocument("\n\n  Fix the login\nmore").title).toEqual([text("Fix the login")]);
  });

  it("leaves a heading mark out of the title, as a card does", () => {
    expect(taskDocument("# Title here\nbody").title).toEqual([text("Title here")]);
    expect(taskDocument("[ui] ## Title here\nbody").title).toEqual([text("Title here")]);
  });

  it("takes every leading line of only tags as the tags, with the title below them", () => {
    expect(taskDocument("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent atomic\nProblem: two tabs")).toEqual({
      tags: ["frontend", "tech-debt", "ui"], title: [text("Make plan-intent atomic")], blocks: [{ kind: "paragraph", inlines: [text("Problem: two tabs")], joined: false }],
    });
    expect(taskDocument("[a]\n[b]")).toEqual({ tags: [], title: [text("[a] [b]")], blocks: [] });
  });

  it("keeps a text of only tags as the title when blank lines follow it", () => {
    expect(taskDocument("[a] [b]\n\n  \n")).toEqual({ tags: [], title: [text("[a] [b]")], blocks: [] });
  });
});

describe("taskBlocks", () => {
  it("splits paragraphs on blank lines and keeps a single line break inside one", () => {
    expect(taskBlocks("One\nstill one\n\nTwo")).toEqual([
      { kind: "paragraph", inlines: [text("One\nstill one")], joined: false },
      { kind: "paragraph", inlines: [text("Two")], joined: false },
    ]);
  });

  it("reads numbered lines as an ordered list that starts at its first number", () => {
    expect(taskBlocks("3. Three\n4. Four")).toEqual([
      { kind: "ordered", start: 3, items: [[text("Three")], [text("Four")]], joined: false },
    ]);
  });

  it("reads lines that start with a dash or a star as a bulleted list", () => {
    expect(taskBlocks("- One\n* Two")).toEqual([{ kind: "bullets", items: [[text("One")], [text("Two")]], joined: false }]);
  });

  it("marks a list that follows a line with no blank line between, and not one that follows a blank line", () => {
    expect(taskBlocks("Fix:\n1. One")).toEqual([
      { kind: "paragraph", inlines: [text("Fix:")], joined: false },
      { kind: "ordered", start: 1, items: [[text("One")]], joined: true },
    ]);
    expect(taskBlocks("Fix:\n\n1. One")[1]).toMatchObject({ kind: "ordered", joined: false });
  });

  it("ends a list at the first plain line, and goes on with an indented line", () => {
    expect(taskBlocks("- One\n  more\nAfter")).toEqual([
      { kind: "bullets", items: [[text("One\nmore")]], joined: false },
      { kind: "paragraph", inlines: [text("After")], joined: true },
    ]);
  });

  it("keeps the indentation of a body line", () => {
    expect(taskBlocks("Run:\n    npm run build\n  --watch")).toEqual([
      { kind: "paragraph", inlines: [text("Run:\n    npm run build\n  --watch")], joined: false },
    ]);
    expect(taskBlocks("    indented first\nplain")).toEqual([{ kind: "paragraph", inlines: [text("    indented first\nplain")], joined: false }]);
  });

  it("reads a number of one to three digits, then a period or a parenthesis and a space, as a list item", () => {
    expect(taskBlocks("1) One\n2. Two\n100. Hundred")).toEqual([
      { kind: "ordered", start: 1, items: [[text("One")], [text("Two")], [text("Hundred")]], joined: false },
    ]);
    expect(taskBlocks("  7) Seven")).toEqual([{ kind: "ordered", start: 7, items: [[text("Seven")]], joined: false }]);
  });

  it("does not take a year or another long number for a list start", () => {
    expect(taskBlocks("We shipped in\n2026. Then more")).toEqual([{ kind: "paragraph", inlines: [text("We shipped in\n2026. Then more")], joined: false }]);
    expect(taskBlocks("1000) not a list")).toEqual([{ kind: "paragraph", inlines: [text("1000) not a list")], joined: false }]);
  });

  it("does not take a number inside a line, a number with no space, or a dash with no space for a list", () => {
    expect(taskBlocks("Version 1. Done\n1.5 is next\n-x")).toEqual([{ kind: "paragraph", inlines: [text("Version 1. Done\n1.5 is next\n-x")], joined: false }]);
  });

  it("draws nothing for no text", () => {
    expect(taskBlocks("")).toEqual([]);
    expect(taskBlocks("\n\n  \n")).toEqual([]);
  });
});

describe("taskInlines", () => {
  it("draws a backtick span as code, and an unclosed one as text", () => {
    expect(taskInlines("Call `retry_upload` now")).toEqual([text("Call "), code("retry_upload"), text(" now")]);
    expect(taskInlines("A `lone tick")).toEqual([text("A `lone tick")]);
  });

  it("draws a UUID and an ISO date or time, with an optional UTC, as data", () => {
    expect(taskInlines("Run b44302e6-ca10-494a-9bde-b5ccbe190dcb at 2026-10-20 20:59–21:01 UTC.")).toEqual([
      text("Run "), data("b44302e6-ca10-494a-9bde-b5ccbe190dcb"), text(" at "), data("2026-10-20 20:59–21:01 UTC"), text("."),
    ]);
    expect(taskInlines("On 2026-10-20, then 2026-10-21T08:30:00Z.")).toEqual([text("On "), data("2026-10-20"), text(", then "), data("2026-10-21T08:30:00Z"), text(".")]);
  });

  it("leaves a date inside a longer word, and anything inside a code span, as it was", () => {
    expect(taskInlines("v2026-10-20x")).toEqual([text("v2026-10-20x")]);
    expect(taskInlines("`2026-10-20`")).toEqual([code("2026-10-20")]);
  });

  it("draws an image marker as the image it names, wherever it stands", () => {
    expect(taskInlines("See [image:img-0123456789ab] here")).toEqual([text("See "), { kind: "image", imageId: "img-0123456789ab" }, text(" here")]);
  });

  it("keeps markup, a Markdown link and a tag as the characters written", () => {
    const written = "<b>bold</b> [a link](javascript:alert(1)) <img src=x onerror=alert(1)>";
    expect(taskInlines(written)).toEqual([text(written)]);
  });
});
