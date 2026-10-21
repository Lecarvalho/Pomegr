import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TaskTextField } from "../../app/components/tasks/TaskFields";
import type { TaskFieldImages } from "../../app/components/tasks/TaskImages";
import { richLayout } from "../../app/components/tasks/task-rich-text";
import { splitTaskTags } from "../../app/components/tasks/task-tags";

const NEW_ID = "img-aaaaaaaaaaaa";

const imagesWith = (ids: string[] = []): TaskFieldImages => ({ urls: new Map(), onAttach: () => ids });

function renderField(initial: string, options: { images?: TaskFieldImages } = {}) {
  const changes: string[] = [];
  function Field() {
    const [value, setValue] = useState(initial);
    return <TaskTextField value={value} images={options.images ?? imagesWith()} onChange={(next) => { changes.push(next); setValue(next); }} />;
  }
  render(<Field />);
  return { changes, last: () => changes.at(-1) };
}

const field = () => screen.getByRole("textbox", { name: "Task" });
const title = () => field().querySelector<HTMLElement>(".taskRichTitle");
const chips = () => [...field().querySelectorAll(".taskRichChip")].map((chip) => chip.textContent);
const caretAt = (node: Node, offset: number) => window.getSelection()!.collapse(node, offset);
const titleText = () => title()!.firstChild as Text;
const beforeInput = (inputType: string) => field().dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
const press = (key: string, init: { ctrlKey?: boolean } = {}) => fireEvent.keyDown(field(), { key, ...init });
const pasteImage = () => fireEvent.paste(field(), { clipboardData: { files: [new File([Uint8Array.from([1, 2, 3])], "shot.png", { type: "image/png" })] } });

/** The browser types text into the node under the caret, then fires `input` with its type. */
function typeInto(text: Text, value: string, caretOffset: number, inputType = "insertText") {
  text.nodeValue = value;
  caretAt(text, caretOffset);
  fireEvent.input(field(), { inputType });
}

/** Types text into an empty field the way a browser does it: the text node, the caret after it, then `input`. */
function typeInEmpty(text: string, inputType = "insertText") {
  window.getSelection()!.selectAllChildren(field());
  window.getSelection()!.collapseToEnd();
  beforeInput(inputType);
  field().append(text);
  window.getSelection()!.selectAllChildren(field());
  window.getSelection()!.collapseToEnd();
  fireEvent.input(field(), { inputType });
}

describe("an image against a chip that nothing follows", () => {
  it("gets the space a typed character would, so the chip stays a tag", () => {
    const { last } = renderField("", { images: imagesWith([NEW_ID]) });
    typeInEmpty("[ui]");
    expect(chips()).toEqual(["ui"]);
    pasteImage();
    expect(last()).toBe(`[ui] [image:${NEW_ID}]`);
    expect(chips()).toEqual(["ui"]);
    expect(field().querySelectorAll("img")).toHaveLength(1);
    expect(title()?.querySelectorAll("img")).toHaveLength(1);
  });

  it("does the same for chips that were loaded, and adds no space where whitespace follows the chip", () => {
    const loaded = renderField("[a] [b]", { images: imagesWith([NEW_ID]) });
    window.getSelection()!.collapse(field(), field().childNodes.length);
    pasteImage();
    expect(loaded.last()).toBe(`[a] [b] [image:${NEW_ID}]`);
    expect(chips()).toEqual(["a", "b"]);
    cleanup();
    const spaced = renderField("[a] Title", { images: imagesWith([NEW_ID]) });
    caretAt(titleText(), 0);
    pasteImage();
    expect(spaced.last()).toBe(`[a] [image:${NEW_ID}]Title`);
    expect(chips()).toEqual(["a"]);
  });
});

describe("tokens at the start of the title line are tags, below a blank line too", () => {
  const TITLE = "Make plan-intent consume atomic across browser tabs";
  const GAPS = ["\n", "\n\n", "\r\n\r\n", "\n \n", "\n\t\n"];

  it("draws the tokens of a body paragraph that starts with a bracket as chips, with the blank line kept in the chip before", () => {
    renderField("[ui]\n\n[TODO] write tests");
    expect(chips()).toEqual(["ui", "TODO"]);
    expect(title()?.textContent).toBe("write tests");
    expect(richLayout("[ui]\n\n[x] one\n[x] two")).toEqual({
      chips: [{ label: "ui", source: "[ui]\n\n" }, { label: "x", source: "[x] " }], title: "one", rest: "\n[x] two",
    });
    expect(richLayout("[ui]\n  \t\n[x] one").chips.map((chip) => chip.label)).toEqual(["ui", "x"]);
  });

  it("converts a token typed at the start of the title line under a blank line, and keeps the blank line", () => {
    for (const gap of GAPS) {
      const { last } = renderField(`[ frontend ] [ tech-debt ]${gap}${TITLE}`);
      expect(chips()).toEqual(["frontend", "tech-debt"]);
      typeInto(titleText(), `[ test ]${TITLE}`, 8);
      expect(chips(), JSON.stringify(gap)).toEqual(["frontend", "tech-debt", "test"]);
      expect(title()?.textContent).toBe(TITLE);
      expect(last()).toBe(`[ frontend ] [ tech-debt ]${gap}[ test ] ${TITLE}`);
      cleanup();
    }
  });

  it("converts a token typed with a space, and a pasted token, the same way", () => {
    for (const gap of GAPS) {
      const typed = renderField(`[ frontend ] [ tech-debt ]${gap}${TITLE}`);
      typeInto(titleText(), `[ test ] ${TITLE}`, 9);
      expect(chips(), JSON.stringify(gap)).toEqual(["frontend", "tech-debt", "test"]);
      expect(typed.last()).toBe(`[ frontend ] [ tech-debt ]${gap}[ test ] ${TITLE}`);
      cleanup();
      const pasted = renderField(`[ frontend ] [ tech-debt ]${gap}${TITLE}`);
      caretAt(titleText(), 0);
      beforeInput("insertFromPaste");
      typeInto(titleText(), `[ test ] ${TITLE}`, 9, "insertFromPaste");
      expect(chips(), JSON.stringify(gap)).toEqual(["frontend", "tech-debt", "test"]);
      expect(pasted.last()).toBe(`[ frontend ] [ tech-debt ]${gap}[ test ] ${TITLE}`);
      cleanup();
    }
  });
});

describe("Backspace right after the closing bracket", () => {
  it("turns the chip back into its text without the bracket, with the caret at its end, so it can be corrected", () => {
    const { last } = renderField("");
    typeInEmpty("[ui]");
    expect(chips()).toEqual(["ui"]);
    expect(press("Backspace")).toBe(false);
    expect(last()).toBe("[ui");
    expect(chips()).toEqual([]);
    expect(title()?.textContent).toBe("[ui");
    expect(window.getSelection()!.anchorNode).toBe(titleText());
    expect(window.getSelection()!.anchorOffset).toBe(3);
    // The bracket typed again makes the chip again.
    typeInto(titleText(), "[ui]", 4);
    expect(chips()).toEqual(["ui"]);
  });

  it("keeps the last chip of several, and removes a chip that whitespace follows as it always did", () => {
    const { last } = renderField("");
    typeInEmpty("[a] [b]");
    expect(chips()).toEqual(["a", "b"]);
    press("Backspace");
    expect(last()).toBe("[a] [b");
    expect(chips()).toEqual(["a"]);
    cleanup();
    const spaced = renderField("[a] [b] Title");
    caretAt(titleText(), 0);
    press("Backspace");
    expect(spaced.last()).toBe("[a] Title");
    expect(chips()).toEqual(["a"]);
  });
});

describe("the stored text does not grow while a title is typed and deleted", () => {
  it("drops the browser's placeholder break after chips that end in a line break", () => {
    const { last } = renderField("[ui]\nab");
    // Two Backspaces: the browser leaves a lone line break in the emptied title line.
    typeInto(titleText(), "a", 1, "deleteContentBackward");
    typeInto(titleText(), "\n", 1, "deleteContentBackward");
    expect(last()).toBe("[ui]\n");
    expect(chips()).toEqual(["ui"]);
    expect(title()?.textContent).toBe("");
    for (const letter of ["c", "d", "e"]) {
      title()!.append(letter);
      caretAt(titleText(), 1);
      fireEvent.input(field(), { inputType: "insertText" });
      expect(last()).toBe(`[ui]\n${letter}`);
      typeInto(titleText(), "\n", 1, "deleteContentBackward");
      expect(last()).toBe("[ui]\n");
    }
  });

  it("drops the second break of an Enter after chips that already end in a line break, and keeps a pasted break", () => {
    const { last } = renderField("[ui]\n");
    title()!.append("\n\n");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertParagraph" });
    expect(last()).toBe("[ui]\n\n");
    cleanup();
    const pasted = renderField("[ui]\n");
    title()!.append("\n");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertFromPaste" });
    expect(pasted.last()).toBe("[ui]\n\n");
  });
});

describe("the space the field adds", () => {
  const glued = () => {
    const field = renderField("Title");
    typeInto(titleText(), "[ui]Title", 4);
    expect(field.last()).toBe("[ui] Title");
    return field;
  };
  const typeSpace = () => {
    titleText().nodeValue = ` ${titleText().nodeValue}`;
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
  };

  it("is the space the person types next, and only that one", () => {
    const { last } = glued();
    typeSpace();
    expect(last()).toBe("[ui] Title");
  });

  it("is forgotten when the caret moves by a key, a pointer, or a blur", () => {
    for (const forget of [() => press("Home"), () => press("ArrowLeft"), () => fireEvent.pointerDown(field()), () => fireEvent.blur(field())]) {
      const { last } = glued();
      forget();
      typeSpace();
      expect(last()).toBe("[ui]  Title");
      cleanup();
    }
  });

  it("is forgotten by undo and by Backspace on a chip", () => {
    const undone = glued();
    press("z", { ctrlKey: true });
    expect(undone.last()).toBe("Title");
    typeSpace();
    expect(undone.last()).toBe(" Title");
    cleanup();
    const removed = glued();
    caretAt(titleText(), 0);
    press("Backspace");
    expect(removed.last()).toBe("Title");
    typeSpace();
    expect(removed.last()).toBe(" Title");
  });

  it("keeps a typed printable key from forgetting it", () => {
    const { last } = glued();
    press(" ");
    typeSpace();
    expect(last()).toBe("[ui] Title");
  });
});

describe("a paste converts tokens the way typing does", () => {
  it("spaces glued tokens of a paste into an empty field, and a token against the text", () => {
    const tokens = renderField("");
    typeInEmpty("[a][b]", "insertFromPaste");
    expect(tokens.last()).toBe("[a] [b]");
    expect(chips()).toEqual(["a", "b"]);
    cleanup();
    const text = renderField("");
    typeInEmpty("[a]Title", "insertFromPaste");
    expect(text.last()).toBe("[a] Title");
    expect(chips()).toEqual(["a"]);
    expect(title()?.textContent).toBe("Title");
  });

  it("spaces a paste at the start of a text, and leaves a paste in the middle of the text alone", () => {
    const start = renderField("Title");
    caretAt(titleText(), 0);
    beforeInput("insertFromPaste");
    typeInto(titleText(), "[a][b]Title", 6, "insertFromPaste");
    expect(start.last()).toBe("[a] [b] Title");
    cleanup();
    const middle = renderField("Title and more");
    caretAt(titleText(), 5);
    beforeInput("insertFromPaste");
    typeInto(titleText(), "Title[a][b]x and more", 11, "insertFromPaste");
    expect(middle.last()).toBe("Title[a][b]x and more");
    expect(chips()).toEqual([]);
  });

  it("wraps text at the start in brackets into a tag, which undo gives back as text", () => {
    const { last } = renderField("foobar");
    caretAt(titleText(), 0);
    beforeInput("insertText");
    typeInto(titleText(), "[foobar", 1);
    expect(chips()).toEqual([]);
    caretAt(titleText(), 4);
    beforeInput("insertText");
    typeInto(titleText(), "[foo]bar", 5);
    expect(last()).toBe("[foo] bar");
    expect(chips()).toEqual(["foo"]);
    press("z", { ctrlKey: true });
    expect(last()).toBe("[foobar");
    expect(chips()).toEqual([]);
  });
});

describe("the editor reads the same tags as the parser", () => {
  const LEADING = ["", " ", "\t", " ", "﻿", " ", " ", "\r", "  \t", "　", " "];
  const BODIES = ["[a] Title", "[a] [b]\nTitle", "[a]\n[b]\n\nBody", "[a]\n\n[b] x", "[a][b] x", "[a]", "Title [a]", "[image] x", "[a]\r\n[b]\r\n\r\n[c]", "[ a ]\t[B]\n[b] x"];

  it("draws a chip for every tag the parser takes, with the text read back whole, also for leading Unicode whitespace", () => {
    for (const lead of LEADING) {
      for (const body of BODIES) {
        const value = `${lead}${body}`;
        const parsed = splitTaskTags(value);
        // A line break before the first token ends the possibility of tags, for both.
        for (const options of [{}, { ownTitleLine: true }]) {
          const layout = richLayout(value, options);
          expect(layout.chips.map((chip) => chip.label), JSON.stringify(value)).toEqual(parsed.tags);
          expect(layout.chips.map((chip) => chip.source).join("") + layout.title + layout.rest, JSON.stringify(value)).toBe(value);
        }
      }
    }
  });

  it("agrees on random texts built from the tokens, whitespace, and text that the rules distinguish", () => {
    const parts = ["[a]", "[b]", "[A]", "[ c ]", "[image]", "[x y]", " ", "\t", "\n", "\r\n", " ", "\n\n", "word", "[", "]", "#"];
    let seed = 20261022;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    for (let round = 0; round < 3000; round += 1) {
      let value = "";
      for (let index = next(10); index > 0; index -= 1) value += parts[next(parts.length)];
      const parsed = splitTaskTags(value);
      const layout = richLayout(value);
      expect(layout.chips.map((chip) => chip.label), JSON.stringify(value)).toEqual(parsed.tags);
      expect(layout.chips.map((chip) => chip.source).join("") + layout.title + layout.rest, JSON.stringify(value)).toBe(value);
    }
  });

  it("draws chips for a text that starts with a no-break space, a byte order mark, or an em space", () => {
    for (const lead of [" ", "﻿", " ", "\r"]) {
      cleanup();
      renderField(`${lead}[a] Title`);
      expect(chips(), JSON.stringify(lead)).toEqual(["a"]);
      expect(title()?.textContent).toBe("Title");
    }
  });
});
