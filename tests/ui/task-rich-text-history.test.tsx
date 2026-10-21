import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TaskTextField } from "../../app/components/tasks/TaskFields";
import type { TaskFieldImages } from "../../app/components/tasks/TaskImages";
import { chordLetter } from "../../app/components/tasks/task-rich-text";

const NEW_ID = "img-aaaaaaaaaaaa";

const imagesWith = (ids: string[] = []): TaskFieldImages => ({ urls: new Map(), onAttach: () => ids });

/** The Task field as a form holds it. `set` puts a text in from outside, as a form does when it loads or resets. */
function renderField(initial: string, options: { readOnly?: boolean; images?: TaskFieldImages } = {}) {
  const changes: string[] = [];
  let set: (value: string) => void = () => undefined;
  function Field() {
    const [value, setValue] = useState(initial);
    set = setValue;
    return <TaskTextField value={value} readOnly={options.readOnly} images={options.images ?? imagesWith()}
      onChange={(next) => { changes.push(next); setValue(next); }} />;
  }
  render(<Field />);
  return { changes, last: () => changes.at(-1), set: (value: string) => set(value) };
}

const field = () => screen.getByRole("textbox", { name: "Task" });
const title = () => field().querySelector<HTMLElement>(".taskRichTitle");
const chips = () => [...field().querySelectorAll(".taskRichChip")].map((chip) => chip.textContent);
const tagsLine = () => document.querySelector(".srOnly")?.textContent;
const caretAt = (node: Node, offset: number) => window.getSelection()!.collapse(node, offset);
const titleText = () => title()!.firstChild as Text;

/** The browser puts typed text in the node under the caret, then fires `input` with its type. */
function typeInto(text: Text, value: string, caretOffset: number, inputType = "insertText") {
  text.nodeValue = value;
  caretAt(text, caretOffset);
  fireEvent.input(field(), { inputType });
}
const press = (key: string, init: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => fireEvent.keyDown(field(), { key, ...init });
const undo = () => press("z", { ctrlKey: true });
const redo = () => press("y", { ctrlKey: true });
const selectAcross = (start: [Node, number], end: [Node, number]) => window.getSelection()!.setBaseAndExtent(start[0], start[1], end[0], end[1]);
const beforeInput = (inputType: string) => field().dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));

describe("undo and redo of the rich Task field", () => {
  it("undoes and redoes a run of typing as one step, with Ctrl, Command, and Shift", () => {
    const { last } = renderField("Title");
    let text = titleText();
    typeInto(text, "Titlex", 6);
    typeInto(text, "Titlexy", 7);
    typeInto(text, "Titlexyz", 8);
    expect(undo()).toBe(false);
    expect(last()).toBe("Title");
    expect(title()?.textContent).toBe("Title");
    expect(redo()).toBe(false);
    expect(last()).toBe("Titlexyz");
    expect(press("z", { metaKey: true })).toBe(false);
    expect(last()).toBe("Title");
    expect(press("z", { metaKey: true, shiftKey: true })).toBe(false);
    expect(last()).toBe("Titlexyz");
    expect(press("z", { ctrlKey: true })).toBe(false);
    expect(press("Z", { ctrlKey: true, shiftKey: true })).toBe(false);
    expect(last()).toBe("Titlexyz");
    text = titleText();
    expect(text.nodeValue).toBe("Titlexyz");
  });

  it("does nothing, and still takes the browser's own undo away, when there is nothing to undo or redo", () => {
    const { changes } = renderField("Title");
    expect(undo()).toBe(false);
    expect(redo()).toBe(false);
    expect(changes).toEqual([]);
    expect(title()?.textContent).toBe("Title");
  });

  it("joins a run of Backspace into one step and puts the caret back", () => {
    const { last } = renderField("Hello world");
    const text = titleText();
    caretAt(text, 11);
    beforeInput("deleteContentBackward");
    typeInto(text, "Hello worl", 10, "deleteContentBackward");
    typeInto(text, "Hello wor", 9, "deleteContentBackward");
    typeInto(text, "Hello wo", 8, "deleteContentBackward");
    undo();
    expect(last()).toBe("Hello world");
    expect(window.getSelection()!.anchorOffset).toBe(11);
    redo();
    expect(last()).toBe("Hello wo");
  });

  it("makes a step of an Enter, a paste, and typing after them", () => {
    const { last } = renderField("");
    field().append("abc");
    caretAt(field().firstChild!, 3);
    fireEvent.input(field(), { inputType: "insertText" });
    typeInto(titleText(), "abc\n", 4, "insertParagraph");
    const rest = field().lastChild as Text;
    typeInto(rest, "\ndef", 4, "insertText");
    expect(last()).toBe("abc\ndef");
    undo();
    expect(last()).toBe("abc\n");
    undo();
    expect(last()).toBe("abc");
    undo();
    expect(last()).toBe("");
    expect(field()).toBeEmptyDOMElement();
    redo();
    redo();
    redo();
    expect(last()).toBe("abc\ndef");
  });

  it("drops what a redo would give back when a new edit is made after an undo", () => {
    const { last } = renderField("A");
    typeInto(titleText(), "AB", 2, "insertFromPaste");
    typeInto(titleText(), "ABC", 3, "insertFromPaste");
    undo();
    expect(last()).toBe("AB");
    typeInto(titleText(), "ABQ", 3, "insertFromPaste");
    redo();
    expect(last()).toBe("ABQ");
  });

  it("answers the browser's undo and redo from a menu or a command, and takes them from the browser", () => {
    const { last } = renderField("Title");
    typeInto(titleText(), "Title!", 6);
    expect(beforeInput("historyUndo")).toBe(false);
    expect(last()).toBe("Title");
    expect(beforeInput("historyRedo")).toBe(false);
    expect(last()).toBe("Title!");
  });

  it("starts a new history when a text is set from outside, so undo never goes back across it", () => {
    const { last, set } = renderField("one");
    typeInto(titleText(), "one two", 7);
    act(() => set("loaded"));
    expect(title()?.textContent).toBe("loaded");
    undo();
    expect(title()?.textContent).toBe("loaded");
    expect(last()).toBe("one two");
    typeInto(titleText(), "loaded!", 7);
    undo();
    expect(last()).toBe("loaded");
  });

  it("is not changed in a read-only field", () => {
    const { changes } = renderField("Title", { readOnly: true });
    expect(undo()).toBe(true);
    expect(press("a", { ctrlKey: true })).toBe(true);
    expect(changes).toEqual([]);
  });

  it("makes one step of a composition when it ends, and none while it is open", () => {
    const { last } = renderField("Title");
    const text = titleText();
    text.nodeValue = "Titleに";
    caretAt(text, 6);
    fireEvent.input(field(), { inputType: "insertCompositionText", isComposing: true });
    text.nodeValue = "Title日本";
    caretAt(text, 7);
    fireEvent.input(field(), { inputType: "insertCompositionText", isComposing: true });
    fireEvent.compositionEnd(field());
    expect(last()).toBe("Title日本");
    undo();
    expect(last()).toBe("Title");
  });
});

describe("undo and redo with chips", () => {
  it("gives back the text from before a conversion exactly, and redoes it without a copy of the token", () => {
    const { last } = renderField("Add retry to the sync job");
    const text = titleText();
    typeInto(text, "[backend] [bug] Add retry to the sync job", 16);
    expect(chips()).toEqual(["backend", "bug"]);
    expect(title()?.textContent).toBe("Add retry to the sync job");
    undo();
    expect(last()).toBe("Add retry to the sync job");
    expect(chips()).toEqual([]);
    expect(title()?.textContent).toBe("Add retry to the sync job");
    expect(tagsLine()).toBe("");
    undo();
    expect(last()).toBe("Add retry to the sync job");
    redo();
    expect(last()).toBe("[backend] [bug] Add retry to the sync job");
    expect(chips()).toEqual(["backend", "bug"]);
    expect(title()?.textContent).toBe("Add retry to the sync job");
    expect(tagsLine()).toBe("Tags: backend, bug");
    redo();
    expect(last()).toBe("[backend] [bug] Add retry to the sync job");
  });

  it("does the same for a single tag in front, a tag pasted over the title, and a second tag", () => {
    const front = renderField("Fix the bug");
    typeInto(titleText(), "[ui] Fix the bug", 5);
    undo();
    expect(front.last()).toBe("Fix the bug");
    redo();
    expect(front.last()).toBe("[ui] Fix the bug");
    cleanup();
    const pasted = renderField("Title");
    selectAcross([titleText(), 0], [titleText(), 5]);
    typeInto(titleText(), "[x] ", 4, "insertFromPaste");
    expect(chips()).toEqual(["x"]);
    undo();
    expect(pasted.last()).toBe("Title");
    expect(chips()).toEqual([]);
    redo();
    expect(pasted.last()).toBe("[x] ");
    cleanup();
    const second = renderField("[a] Fix the bug");
    typeInto(titleText(), "[ui] Fix the bug", 5);
    expect(chips()).toEqual(["a", "ui"]);
    undo();
    expect(second.last()).toBe("[a] Fix the bug");
    expect(chips()).toEqual(["a"]);
  });

  it("brings a chip back that Backspace removed, and removes it again on redo", () => {
    const { last } = renderField("[a] [b] Title");
    caretAt(titleText(), 0);
    press("Backspace");
    expect(last()).toBe("[a] Title");
    undo();
    expect(last()).toBe("[a] [b] Title");
    expect(chips()).toEqual(["a", "b"]);
    expect(tagsLine()).toBe("Tags: a, b");
    redo();
    expect(last()).toBe("[a] Title");
    expect(chips()).toEqual(["a"]);
  });

  it("brings chips back that a deletion, a cut, or typing took with a select all", () => {
    const value = "[ui] [bug] Fix it\nBody";
    const { last } = renderField(value);
    press("a", { ctrlKey: true });
    beforeInput("deleteContentBackward");
    window.getSelection()!.getRangeAt(0).deleteContents();
    fireEvent.input(field(), { inputType: "deleteContentBackward" });
    expect(last()).toBe("");
    undo();
    expect(last()).toBe(value);
    expect(chips()).toEqual(["ui", "bug"]);
    redo();
    expect(last()).toBe("");
  });
});

describe("select all is the person's intent, not a place of the selection", () => {
  const VALUE = "[ui] [bug] Fix it\nBody";
  const copyData = () => {
    const data: Record<string, string> = {};
    return { data, clipboardData: { setData: (type: string, text: string) => { data[type] = text; } } };
  };
  /** The title text and the end of the field: what a mouse, Shift+Home, or Ctrl+Shift+End selects. */
  const selectTitleToEnd = () => selectAcross([titleText(), 0], [field().lastChild!, field().lastChild!.textContent!.length]);
  const selectTitle = () => selectAcross([titleText(), 0], [titleText(), titleText().length]);

  it("selects the chips too on Ctrl+A and Cmd+A, and takes the key from the browser", () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      renderField(VALUE);
      expect(press("a", init)).toBe(false);
      const range = window.getSelection()!.getRangeAt(0);
      expect(range.startContainer).toBe(field());
      expect(range.startOffset).toBe(0);
      expect(range.endContainer).toBe(field());
      expect(range.endOffset).toBe(field().childNodes.length);
      cleanup();
    }
  });

  it("leaves Ctrl+Shift+A, Alt+Ctrl+A, and a plain A to the browser", () => {
    renderField(VALUE);
    expect(press("a", { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(press("a", { ctrlKey: true, altKey: true })).toBe(true);
    expect(press("a")).toBe(true);
  });

  it("copies the chips' text with the rest after Ctrl+A, and leaves other copies to the browser", () => {
    renderField(VALUE);
    press("a", { ctrlKey: true });
    const all = copyData();
    expect(fireEvent.copy(field(), { clipboardData: all.clipboardData })).toBe(false);
    expect(all.data["text/plain"]).toBe(VALUE);
    for (const select of [selectTitleToEnd, selectTitle]) {
      select();
      const part = copyData();
      expect(fireEvent.copy(field(), { clipboardData: part.clipboardData })).toBe(true);
      expect(part.data).toEqual({});
    }
  });

  it("copies an image as nothing, never as its marker", () => {
    renderField(`[ui] Pic [image:img-0123456789ab] here\nBody`);
    press("a", { ctrlKey: true });
    const { data, clipboardData } = copyData();
    fireEvent.copy(field(), { clipboardData });
    expect(data["text/plain"]).toBe("[ui] Pic  here\nBody");
  });

  it("cuts a select all with its chips, and leaves the chips when the cut is of the title", () => {
    const { last } = renderField(VALUE);
    press("a", { ctrlKey: true });
    const { data, clipboardData } = copyData();
    expect(fireEvent.cut(field(), { clipboardData })).toBe(false);
    expect(data["text/plain"]).toBe(VALUE);
    expect(last()).toBe("");
    expect(field()).toBeEmptyDOMElement();
    cleanup();
    renderField(VALUE);
    selectTitleToEnd();
    expect(fireEvent.cut(field(), { clipboardData: copyData().clipboardData })).toBe(true);
    expect(chips()).toEqual(["ui", "bug"]);
  });

  it("takes the chips off before the browser deletes or replaces a select all", () => {
    for (const inputType of ["deleteContentBackward", "deleteContentForward", "insertText", "insertFromPaste", "insertLineBreak"]) {
      renderField(VALUE);
      press("a", { ctrlKey: true });
      beforeInput(inputType);
      expect(field().querySelector(".taskRichTags"), inputType).toBeNull();
      cleanup();
    }
  });

  it("keeps the chips when the title, or the title and all that follows, is selected and retyped", () => {
    for (const select of [selectTitle, selectTitleToEnd]) {
      for (const inputType of ["deleteContentBackward", "deleteContentForward", "insertText", "insertFromPaste"]) {
        const { last } = renderField(VALUE);
        select();
        beforeInput(inputType);
        expect(chips(), inputType).toEqual(["ui", "bug"]);
        window.getSelection()!.getRangeAt(0).deleteContents();
        title()!.append("Repair");
        fireEvent.input(field(), { inputType });
        expect(last()?.startsWith("[ui] [bug] ")).toBe(true);
        expect(chips()).toEqual(["ui", "bug"]);
        cleanup();
      }
    }
  });

  it("keeps the tags of a task that is only a title when the title is deleted and retyped", () => {
    const { last } = renderField("[backend] Fix the login redirect");
    selectTitle();
    beforeInput("deleteContentBackward");
    // The browser leaves a lone line break where the last text of the line was.
    titleText().nodeValue = "\n";
    caretAt(titleText(), 0);
    fireEvent.input(field(), { inputType: "deleteContentBackward" });
    expect(last()).toBe("[backend] ");
    expect(chips()).toEqual(["backend"]);
    expect(title()?.textContent).toBe("");
    title()!.append("Repair");
    caretAt(titleText(), 6);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[backend] Repair");
    expect(chips()).toEqual(["backend"]);
  });

  it("keeps the break of an Enter pressed after the tags", () => {
    const { last } = renderField("");
    field().append("[a] ");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field(), { inputType: "insertText" });
    title()!.append("\n\n");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertParagraph" });
    expect(last()).toBe("[a] \n\n");
  });

  it("puts an image over a select all in place of everything, chips too, as typing does", () => {
    const { last } = renderField(VALUE, { images: imagesWith([NEW_ID]) });
    press("a", { ctrlKey: true });
    fireEvent.paste(field(), { clipboardData: { files: [new File([Uint8Array.from([1, 2, 3])], "shot.png", { type: "image/png" })] } });
    expect(last()).toBe(`[image:${NEW_ID}]`);
    expect(chips()).toEqual([]);
    expect(tagsLine()).toBe("");
    undo();
    expect(last()).toBe(VALUE);
    expect(chips()).toEqual(["ui", "bug"]);
    redo();
    expect(last()).toBe(`[image:${NEW_ID}]`);
  });

  it("keeps the chips when an image is put over the title, and undoes it", () => {
    const { last } = renderField(VALUE, { images: imagesWith([NEW_ID]) });
    selectTitle();
    fireEvent.paste(field(), { clipboardData: { files: [new File([Uint8Array.from([1, 2, 3])], "shot.png", { type: "image/png" })] } });
    expect(chips()).toEqual(["ui", "bug"]);
    expect(last()).toBe(`[ui] [bug] [image:${NEW_ID}]\nBody`);
    undo();
    expect(last()).toBe(VALUE);
    expect(field().querySelectorAll("img")).toHaveLength(0);
    redo();
    expect(field().querySelectorAll("img")).toHaveLength(1);
  });
});

describe("shortcuts follow the key's letter, and the physical key on a layout with another script", () => {
  const chord = (key: string, code: string, init: { ctrlKey?: boolean; shiftKey?: boolean } = { ctrlKey: true }) => fireEvent.keyDown(field(), { key, code, ...init });

  it("names the letter of a shortcut", () => {
    expect(chordLetter({ key: "z", code: "KeyZ" })).toBe("z");
    expect(chordLetter({ key: "Z", code: "KeyZ" })).toBe("z");
    // A Russian layout: the key types a Cyrillic letter, and the physical key is the Latin one.
    expect(chordLetter({ key: "я", code: "KeyZ" })).toBe("z");
    expect(chordLetter({ key: "Н", code: "KeyY" })).toBe("y");
    expect(chordLetter({ key: "ф", code: "KeyA" })).toBe("a");
    // Dvorak types Z from another physical key, and types a slash from the key that is Z on QWERTY.
    expect(chordLetter({ key: "z", code: "Semicolon" })).toBe("z");
    expect(chordLetter({ key: "/", code: "KeyZ" })).toBe("/");
    expect(chordLetter({ key: "Backspace", code: "Backspace" })).toBe("backspace");
    expect(chordLetter({ key: "Process", code: "KeyZ" })).toBe("process");
  });

  it("undoes and redoes on a Russian layout, and with Z typed from another physical key", () => {
    const { last } = renderField("Title");
    typeInto(titleText(), "Title!", 6);
    expect(chord("я", "KeyZ")).toBe(false);
    expect(last()).toBe("Title");
    expect(chord("н", "KeyY")).toBe(false);
    expect(last()).toBe("Title!");
    expect(chord("я", "KeyZ")).toBe(false);
    expect(last()).toBe("Title");
    expect(chord("Я", "KeyZ", { ctrlKey: true, shiftKey: true })).toBe(false);
    expect(last()).toBe("Title!");
    expect(chord("z", "Semicolon")).toBe(false);
    expect(last()).toBe("Title");
    expect(chord("/", "KeyZ")).toBe(true);
    expect(last()).toBe("Title");
  });

  it("selects the whole field with the chips on a Russian layout, so typing over it removes them", () => {
    const { last } = renderField("[ui] Fix it\nBody");
    expect(chord("ф", "KeyA")).toBe(false);
    const range = window.getSelection()!.getRangeAt(0);
    expect([range.startContainer, range.startOffset]).toEqual([field(), 0]);
    beforeInput("insertText");
    expect(chips()).toEqual([]);
    window.getSelection()!.getRangeAt(0).deleteContents();
    field().append("Z");
    caretAt(field().lastChild!, 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("Z");
  });
});

describe("the history's edges", () => {
  it("ends the redo branch when select all and the same text are typed over the same text", () => {
    const { last } = renderField("");
    field().append("Z");
    caretAt(field().lastChild!, 1);
    fireEvent.input(field(), { inputType: "insertText" });
    typeInto(titleText(), "Q", 1, "insertFromPaste");
    undo();
    expect(last()).toBe("Z");
    press("a", { ctrlKey: true });
    beforeInput("insertText");
    window.getSelection()!.getRangeAt(0).deleteContents();
    field().append("Z");
    caretAt(field().lastChild!, 1);
    fireEvent.input(field(), { inputType: "insertText" });
    redo();
    expect(last()).toBe("Z");
  });

  it("leaves no step that undoes nothing after a select all is retyped to the same text", () => {
    const { last, changes } = renderField("abc");
    press("a", { ctrlKey: true });
    beforeInput("insertText");
    window.getSelection()!.getRangeAt(0).deleteContents();
    field().append("a");
    caretAt(field().lastChild!, 1);
    fireEvent.input(field(), { inputType: "insertText" });
    typeInto(titleText(), "ab", 2);
    typeInto(titleText(), "abc", 3);
    expect(last()).toBe("abc");
    // Nothing is left to undo: the retyped text was the text, so one Ctrl+Z does not seem to do nothing.
    const count = changes.length;
    undo();
    expect(changes).toHaveLength(count);
  });
});
