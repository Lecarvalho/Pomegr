import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TaskTextField } from "../../app/components/tasks/TaskFields";
import type { TaskFieldImages } from "../../app/components/tasks/TaskImages";
import { richLayout } from "../../app/components/tasks/task-rich-text";

const ID = "img-0123456789ab";
const OTHER = "img-ffffffffffff";
const NEW_ID = "img-aaaaaaaaaaaa";

const imagesWith = (ids: string[] = []): TaskFieldImages => ({ urls: new Map(), onAttach: () => ids });

/** The Task field as a form holds it: the value lives in state, and every change is recorded. */
function renderField(initial: string, options: { readOnly?: boolean; images?: TaskFieldImages } = {}) {
  const changes: string[] = [];
  function Field() {
    const [value, setValue] = useState(initial);
    return <TaskTextField value={value} readOnly={options.readOnly} images={options.images ?? imagesWith()}
      onChange={(next) => { changes.push(next); setValue(next); }} />;
  }
  render(<Field />);
  return { changes, last: () => changes.at(-1) };
}

const field = () => screen.getByRole("textbox", { name: "Task" });
const title = () => field().querySelector<HTMLElement>(".taskRichTitle");
const chips = () => [...field().querySelectorAll(".taskRichChip")].map((chip) => chip.textContent);
const counter = () => document.querySelector(".taskTextCounter")?.textContent;
const caretAt = (node: Node, offset: number) => window.getSelection()!.collapse(node, offset);
const caret = () => ({ node: window.getSelection()!.anchorNode, offset: window.getSelection()!.anchorOffset, collapsed: window.getSelection()!.isCollapsed });
const titleText = () => title()!.firstChild as Text;

/** The browser puts typed text in the node under the caret, then fires `input`. */
function typeInto(text: Text, value: string, caretOffset: number, inputType = "insertText") {
  text.nodeValue = value;
  caretAt(text, caretOffset);
  fireEvent.input(field(), { inputType });
}
const pressBackspace = () => fireEvent.keyDown(field(), { key: "Backspace" });

describe("the rich Task field draws a leading tag run as chips", () => {
  it("draws the chips row, the title line and the rest from a value with tags", () => {
    const value = "[ backend ] [recce] [bug] Coverage opens a shot.\nSecond line.\n\nThird.";
    renderField(value);
    expect(chips()).toEqual(["backend", "recce", "bug"]);
    expect(within(field()).getByRole("group", { name: "Tags: backend, recce, bug" })).toHaveAttribute("contenteditable", "false");
    // The shared neutral chip: no tone class, no per-tag color.
    for (const chip of field().querySelectorAll(".taskRichChip")) expect(chip.className).toBe("commandChip taskRichChip");
    expect(title()?.textContent).toBe("Coverage opens a shot.");
    expect(title()).toHaveClass("hasRest");
    expect(field().textContent).toBe("backendreccebugCoverage opens a shot.\nSecond line.\n\nThird.");
    expect(field()).toHaveAttribute("role", "textbox");
    expect(counter()).toBe(`${value.length} / 4,000`);
  });

  it("draws the first line as the title line even when it has no tags, and nothing when the text is empty", () => {
    renderField("");
    expect(field()).toBeEmptyDOMElement();
    expect(field().querySelector(".taskRichTags")).toBeNull();
    cleanup();
    renderField("Plain title\nBody text");
    expect(field().querySelector(".taskRichTags")).toBeNull();
    expect(title()?.textContent).toBe("Plain title");
    expect(field().lastChild?.textContent).toBe("\nBody text");
  });

  it("takes the title from the next line when the first line holds only tags, and keeps brackets that are not a leading run", () => {
    renderField("[ ui ] [ perf ]\nSecond line is the title\nBody");
    expect(chips()).toEqual(["ui", "perf"]);
    expect(title()?.textContent).toBe("Second line is the title");
    cleanup();
    renderField("Fix [ bug ] in the cart");
    expect(chips()).toEqual([]);
    expect(title()?.textContent).toBe("Fix [ bug ] in the cart");
  });

  it("never turns an image marker or the word image into a chip", () => {
    renderField(`[image:${ID}] Screenshot\n[image] later`);
    expect(chips()).toEqual([]);
    expect(field().querySelectorAll("img")).toHaveLength(1);
  });

  it("splits text into chips, title and rest so that they always join back into the value", () => {
    for (const value of ["", "x", "[a] ", "[a]", "[ a ]  [b]\t[A] t\nrest", "  [a] [b] \r\nline\r\nbody", "[a] [a] [b] x", "[a]\n", "[a]\n\n\nz", "\n[a] x", "[a] [image] x", "[a]\n[b]\n[c]\nTitle", "[a]\n\n[b]\r\n\r\nTitle\nBody"]) {
      const layout = richLayout(value);
      expect(layout.chips.map((chip) => chip.source).join("") + layout.title + layout.rest).toBe(value);
    }
    // A token is a chip as soon as its closing bracket is there, also at the very end of the text.
    expect(richLayout("[ perf ]").chips).toEqual([{ label: "perf", source: "[ perf ]" }]);
    expect(richLayout("[ perf ] ").chips).toEqual([{ label: "perf", source: "[ perf ] " }]);
    expect(richLayout("[ perf ]\n").chips).toEqual([{ label: "perf", source: "[ perf ]\n" }]);
    expect(richLayout("[perf")).toEqual({ chips: [], title: "[perf", rest: "" });
    // Every leading line that holds only tags joins the run, and a chip stands for the whitespace after its token, line breaks included.
    expect(richLayout("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent")).toEqual({
      chips: [{ label: "frontend", source: "[ frontend ] " }, { label: "tech-debt", source: "[ tech-debt ]\n" }, { label: "ui", source: "[ ui ]\n" }],
      title: "Make plan-intent", rest: "",
    });
    expect(richLayout("[a]\n\n\nTitle\nBody")).toEqual({ chips: [{ label: "a", source: "[a]\n\n\n" }], title: "Title", rest: "\nBody" });
    // A text that holds nothing but tags has chips and an empty title line.
    expect(richLayout("[a] [b]")).toEqual({ chips: [{ label: "a", source: "[a] " }, { label: "b", source: "[b]" }], title: "", rest: "" });
    // A repeated word is no second chip, and its text stays in the chip it repeats.
    expect(richLayout("[Bug] [ui] [bug] x").chips).toEqual([{ label: "Bug", source: "[Bug] " }, { label: "ui", source: "[ui] [bug] " }]);
  });
});

describe("tags while typing", () => {
  it("turns a token into a chip as soon as its closing bracket is typed, and leaves the caret at the start of the title", () => {
    const { last } = renderField("");
    field().append("[ perf");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field(), { inputType: "insertText" });
    // The token is not complete yet.
    expect(chips()).toEqual([]);
    expect(title()?.textContent).toBe("[ perf");

    typeInto(titleText(), "[ perf ]", 8);
    expect(chips()).toEqual(["perf"]);
    expect(title()?.textContent).toBe("");
    expect(last()).toBe("[ perf ]");
    expect(counter()).toBe("8 / 4,000");
    expect(caret()).toEqual({ node: title(), offset: 0, collapsed: true });

    // What follows is typed into the title line, after the chips. A space belongs to the chip.
    title()!.append(" ");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[ perf ] ");
    title()!.append("Fix the cart");
    caretAt(titleText(), 12);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[ perf ] Fix the cart");
    expect(chips()).toEqual(["perf"]);
  });

  it("converts a token on a line of its own, below tags, as soon as its bracket is typed", () => {
    const { last } = renderField("[ frontend ] [ tech-debt ]\nMake plan-intent consume atomic");
    typeInto(titleText(), "[ ui ]Make plan-intent consume atomic", 6);
    expect(chips()).toEqual(["frontend", "tech-debt", "ui"]);
    expect(title()?.textContent).toBe("Make plan-intent consume atomic");
    expect(last()).toBe("[ frontend ] [ tech-debt ]\n[ ui ] Make plan-intent consume atomic");
    expect(caret()).toEqual({ node: titleText(), offset: 0, collapsed: true });
  });

  it("puts one space between a token completed against the text after it and that text, and takes the space the person types next as that one", () => {
    const { last } = renderField("Fix the cart");
    typeInto(titleText(), "[ui]Fix the cart", 4);
    expect(last()).toBe("[ui] Fix the cart");
    expect(chips()).toEqual(["ui"]);
    expect(title()?.textContent).toBe("Fix the cart");
    expect(caret()).toEqual({ node: titleText(), offset: 0, collapsed: true });
    // The person goes on from the closing bracket with a space: it is the space the field added.
    titleText().nodeValue = " Fix the cart";
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[ui] Fix the cart");
    expect(title()?.textContent).toBe("Fix the cart");
    // A second space is the person's own.
    titleText().nodeValue = " Fix the cart";
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[ui]  Fix the cart");
  });

  it("puts a space between the last chip and text typed against it, so the chip stays a tag", () => {
    const { last } = renderField("");
    field().append("[ui]");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field(), { inputType: "insertText" });
    expect(chips()).toEqual(["ui"]);
    title()!.append("x");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[ui] x");
    expect(chips()).toEqual(["ui"]);
    expect(title()?.textContent).toBe("x");
    expect(caret()).toEqual({ node: titleText(), offset: 1, collapsed: true });
  });

  it("converts a pasted token the same way, against text or alone, and adds no space after a pasted space", () => {
    const against = renderField("Title");
    typeInto(titleText(), "[a] [b]Title", 7, "insertFromPaste");
    expect(against.last()).toBe("[a] [b] Title");
    expect(chips()).toEqual(["a", "b"]);
    cleanup();
    const spaced = renderField("Title");
    typeInto(titleText(), "[a] [b] Title", 8, "insertFromPaste");
    expect(spaced.last()).toBe("[a] [b] Title");
    cleanup();
    const alone = renderField("");
    field().append("[a] [b]");
    caretAt(field().firstChild!, 7);
    fireEvent.input(field(), { inputType: "insertFromPaste" });
    expect(alone.last()).toBe("[a] [b]");
    expect(chips()).toEqual(["a", "b"]);
    expect(title()?.textContent).toBe("");
  });

  it("leaves a bracket token alone that is not in the run position, or that holds the image word", () => {
    const { last } = renderField("Fix");
    typeInto(titleText(), "Fix [x]", 7);
    expect(last()).toBe("Fix [x]");
    expect(chips()).toEqual([]);
    cleanup();
    const image = renderField("");
    field().append("[image]");
    caretAt(field().firstChild!, 7);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(image.last()).toBe("[image]");
    expect(chips()).toEqual([]);
  });

  it("converts a second tag typed at the start of the title and keeps the caret at the title start", () => {
    const { last } = renderField("[ perf ] Fix the cart");
    typeInto(titleText(), "[bug] Fix the cart", 6);
    expect(chips()).toEqual(["perf", "bug"]);
    expect(last()).toBe("[ perf ] [bug] Fix the cart");
    expect(title()?.textContent).toBe("Fix the cart");
    expect(caret()).toEqual({ node: titleText(), offset: 0, collapsed: true });
  });

  it("converts every leading token of a paste at the start, in order, and stops at the first thing that is not a token", () => {
    const { last } = renderField("Existing title\nbody line");
    typeInto(titleText(), "[a] [ b ] [A] [c]x [d] Existing title", 23);
    expect(chips()).toEqual(["a", "b"]);
    expect(title()?.textContent).toBe("[c]x [d] Existing title");
    expect(last()).toBe("[a] [ b ] [A] [c]x [d] Existing title\nbody line");
    // The caret keeps its place in the text: after what was pasted.
    expect(caret()).toEqual({ node: titleText(), offset: 9, collapsed: true });
  });

  it("converts nothing while an IME composition is open, and converts when it ends", () => {
    const { last } = renderField("Title");
    const text = titleText();
    text.nodeValue = "[a] Title";
    caretAt(text, 4);
    fireEvent.input(field(), { isComposing: true });
    expect(chips()).toEqual([]);
    expect(titleText()).toBe(text);
    expect(last()).toBe("[a] Title");
    fireEvent.compositionEnd(field());
    expect(chips()).toEqual(["a"]);
    expect(last()).toBe("[a] Title");
    expect(title()?.textContent).toBe("Title");
  });

  it("leaves the text nodes and the caret alone while the typing stays in a line that is already drawn", () => {
    const { last } = renderField("[ ui ] Fix the cart\nsecond line");
    const text = titleText();
    typeInto(text, "Fix the XYZcart", 10);
    expect(titleText()).toBe(text);
    expect(caret()).toEqual({ node: text, offset: 10, collapsed: true });
    expect(last()).toBe("[ ui ] Fix the XYZcart\nsecond line");
    const rest = field().lastChild as Text;
    typeInto(rest, "\nsecond lXine", 9);
    expect(field().lastChild).toBe(rest);
    expect(caret()).toEqual({ node: rest, offset: 9, collapsed: true });
    expect(last()).toBe("[ ui ] Fix the XYZcart\nsecond lXine");
  });

  it("splits the title from the rest when a line break lands in the title, and puts the caret after the break", () => {
    const { last } = renderField("[ ui ] Fix the cart");
    typeInto(titleText(), "Fix\n the cart", 4);
    expect(title()?.textContent).toBe("Fix");
    expect(field().lastChild?.textContent).toBe("\n the cart");
    expect(last()).toBe("[ ui ] Fix\n the cart");
    expect(caret()).toEqual({ node: field().lastChild, offset: 1, collapsed: true });
  });

  it("styles a title that grows out of the text typed into an empty field", () => {
    const { last } = renderField("");
    field().append("Hello");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field());
    expect(title()?.textContent).toBe("Hello");
    expect(caret()).toEqual({ node: titleText(), offset: 5, collapsed: true });
    expect(last()).toBe("Hello");
  });
});

describe("Backspace at the very start of the title line", () => {
  it("removes the last tag in one key press, again for each tag, and then lets the browser handle the key", () => {
    const { last } = renderField("[ a ] [b] Title\nbody");
    caretAt(titleText(), 0);
    expect(pressBackspace()).toBe(false);
    expect(chips()).toEqual(["a"]);
    expect(last()).toBe("[ a ] Title\nbody");
    expect(counter()).toBe("16 / 4,000");
    expect(caret()).toEqual({ node: titleText(), offset: 0, collapsed: true });
    expect(pressBackspace()).toBe(false);
    expect(chips()).toEqual([]);
    expect(field().querySelector(".taskRichTags")).toBeNull();
    expect(last()).toBe("Title\nbody");
    expect(pressBackspace()).toBe(true);
    expect(last()).toBe("Title\nbody");
  });

  it("removes a tag whose line break ends the run along with that break, and clears an empty field", () => {
    const { last } = renderField("[a] [b] \nTitle");
    caretAt(titleText(), 0);
    expect(pressBackspace()).toBe(false);
    expect(last()).toBe("[a] Title");
    expect(chips()).toEqual(["a"]);
    cleanup();
    // A chip that was typed.
    const only = renderField("");
    field().append("[a] ");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field());
    expect(chips()).toEqual(["a"]);
    caretAt(title()!, 0);
    expect(pressBackspace()).toBe(false);
    expect(only.last()).toBe("");
    expect(field()).toBeEmptyDOMElement();
  });

  it("does nothing elsewhere: with a caret inside the title, with a selection, with a modifier, or while composing", () => {
    renderField("[a] Title");
    caretAt(titleText(), 2);
    expect(pressBackspace()).toBe(true);
    caretAt(titleText(), 0);
    window.getSelection()!.setBaseAndExtent(titleText(), 0, titleText(), 3);
    expect(pressBackspace()).toBe(true);
    caretAt(titleText(), 0);
    expect(fireEvent.keyDown(field(), { key: "Backspace", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(field(), { key: "Delete" })).toBe(true);
    expect(chips()).toEqual(["a"]);
  });

  it("keeps a value that has no tag as it is", () => {
    const { changes } = renderField("Title");
    caretAt(titleText(), 0);
    expect(pressBackspace()).toBe(true);
    expect(changes).toEqual([]);
  });
});

describe("serialization and images", () => {
  it("reads the value back exactly, with each chip as the text it stands for and each image as its marker", () => {
    const value = `[ perf ] [bug]  Pic [image:${ID}] here\nbody [image:${OTHER}]\n\nend`;
    const { last } = renderField(value);
    expect(chips()).toEqual(["perf", "bug"]);
    const images = [...field().querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("data-image-id"))).toEqual([ID, OTHER]);
    expect(title()).toContainElement(images[0]);
    expect(title()).not.toContainElement(images[1]);
    fireEvent.input(field());
    expect(last()).toBe(value);
    expect(counter()).toBe(`${value.length.toLocaleString("en-US")} / 4,000`);
  });

  it("keeps a repeated word and the spacing of each token, so the value is what was typed", () => {
    const value = "  [Bug]\t[ ui ] [bug]   Title";
    const { last } = renderField(value);
    expect(chips()).toEqual(["Bug", "ui"]);
    fireEvent.input(field());
    expect(last()).toBe(value);
  });

  it("puts a pasted image after the chips, never before them, and the value keeps the run first", () => {
    const { last } = renderField("[ perf ] Title", { images: imagesWith([NEW_ID]) });
    // A caret at the very start of the field is before the chips.
    window.getSelection()!.collapse(field(), 0);
    fireEvent.paste(field(), { clipboardData: { files: [new File([Uint8Array.from([1, 2, 3])], "shot.png", { type: "image/png" })] } });
    expect(last()).toBe(`[ perf ] [image:${NEW_ID}]Title`);
    expect(chips()).toEqual(["perf"]);
    expect(title()?.querySelectorAll("img")).toHaveLength(1);
  });

  it("removes an image from the title line like a character, leaving the tags", () => {
    const { last } = renderField(`[ perf ] Pic [image:${ID}]`);
    field().querySelector("img")!.remove();
    fireEvent.input(field());
    expect(last()).toBe("[ perf ] Pic ");
    expect(chips()).toEqual(["perf"]);
  });
});

describe("a started task and the browser fallback", () => {
  it("draws the chips and the title line in a read-only field and edits nothing", () => {
    const { changes } = renderField("[ perf ] [bug] Title\nbody", { readOnly: true });
    expect(field()).toHaveAttribute("contenteditable", "false");
    expect(field()).toHaveAttribute("aria-readonly", "true");
    expect(chips()).toEqual(["perf", "bug"]);
    expect(title()?.textContent).toBe("Title");
    expect(field().textContent).toBe("perfbugTitle\nbody");
    caretAt(titleText(), 0);
    expect(pressBackspace()).toBe(true);
    expect(chips()).toEqual(["perf", "bug"]);
    expect(changes).toEqual([]);
  });

  it("stays a plain textarea with the brackets as typed when the field has no images", () => {
    const onChange = vi.fn();
    render(<TaskTextField value="[ perf ] Title" onChange={onChange} />);
    const textarea = screen.getByRole("textbox", { name: "Task" });
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveValue("[ perf ] Title");
    fireEvent.change(textarea, { target: { value: "[bug] [ perf ] Title" } });
    expect(onChange).toHaveBeenCalledWith("[bug] [ perf ] Title");
    expect(document.querySelector(".taskRichTags, .taskRichChip, .taskRichTitle")).toBeNull();
  });
});

describe("the rich field's type and chips are drawn from tokens", () => {
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
  const rule = (selector: string) => styles.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";

  it("sets the first line as a 16px/650 node and the rest as 14px/1.6", () => {
    expect(rule(".taskRichText")).toMatch(/font: 400 var\(--text-base\)\/1\.6 var\(--font-ui\)/);
    expect(rule(".taskRichTitle")).toMatch(/display: inline-block; width: 100%/);
    expect(rule(".taskRichTitle")).toMatch(/font: 650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(rule(".taskRichTitle.hasRest")).toMatch(/margin-bottom: var\(--space-3\)/);
  });

  it("lays the chips out as one wrapping row of the shared chip, and uses no literal color", () => {
    expect(rule(".taskRichTags")).toMatch(/display: flex; flex-wrap: wrap/);
    for (const selector of [".taskRichText", ".taskRichTitle", ".taskRichTitle.hasRest", ".taskRichTags", ".taskRichChip"]) expect(rule(selector), selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});

describe("a title that is emptied while a tag leads", () => {
  it("stays an empty title line under the chips, so the next line keeps its place and typing goes into the title", () => {
    const { last } = renderField("[backend] Fix the login redirect\nSteps:\n1. Open the app");
    typeInto(titleText(), "", 0, "deleteContentBackward");
    expect(last()).toBe("[backend] \nSteps:\n1. Open the app");
    expect(chips()).toEqual(["backend"]);
    expect(title()?.textContent).toBe("");
    expect(field().lastChild?.textContent).toBe("\nSteps:\n1. Open the app");
    typeInto(titleText(), "Repair the redirect", 19);
    expect(last()).toBe("[backend] Repair the redirect\nSteps:\n1. Open the app");
    expect(title()?.textContent).toBe("Repair the redirect");
    expect(chips()).toEqual(["backend"]);
  });

  it("does the same after two Backspaces, and when the browser drops the emptied title node", () => {
    const { last } = renderField("[a] Ti\nBody");
    typeInto(titleText(), "T", 1, "deleteContentBackward");
    typeInto(titleText(), "", 0, "deleteContentBackward");
    expect(last()).toBe("[a] \nBody");
    title()!.remove();
    window.getSelection()!.collapse(field(), 1);
    fireEvent.input(field(), { inputType: "deleteContentBackward" });
    expect(last()).toBe("[a] \nBody");
    expect(title()?.textContent).toBe("");
    expect(caret()).toEqual({ node: title(), offset: 0, collapsed: true });
    title()!.append("N");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[a] N\nBody");
    expect(title()?.textContent).toBe("N");
    expect(field().lastChild?.textContent).toBe("\nBody");
  });

  it("keeps Enter after the tags as one line break that ends the tag line, so the next line is the title", () => {
    const { last } = renderField("");
    field().append("[a] ");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field(), { inputType: "insertText" });
    // The browser puts the line break and a placeholder break in the title line. The placeholder is dropped.
    title()!.append("\n\n");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertParagraph" });
    expect(last()).toBe("[a] \n");
    expect(chips()).toEqual(["a"]);
    title()!.append("Title");
    caretAt(titleText(), 5);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[a] \nTitle");
    expect(title()?.textContent).toBe("Title");
    expect(chips()).toEqual(["a"]);
  });

  it("lets Enter at the start of the title end the tag line, so the next line is the title and nothing is left over", () => {
    const { last } = renderField("[a] Make plan");
    typeInto(titleText(), "\nMake plan", 1, "insertParagraph");
    expect(last()).toBe("[a] \nMake plan");
    expect(chips()).toEqual(["a"]);
    expect(title()?.textContent).toBe("Make plan");
  });

  it("reads a stored first line of only tags as before: the next line is the title", () => {
    renderField("[a] \nBody");
    expect(chips()).toEqual(["a"]);
    expect(title()?.textContent).toBe("Body");
    expect(richLayout("[a] \nBody").title).toBe("Body");
    expect(richLayout("[a] \nBody", { ownTitleLine: true })).toEqual({ chips: [{ label: "a", source: "[a] " }], title: "", rest: "\nBody" });
    expect(richLayout("[a] \n\n", { ownTitleLine: true }).chips).toEqual([{ label: "a", source: "[a] \n\n" }]);
    expect(richLayout("[a]\n[b] \nBody", { ownTitleLine: true })).toEqual({
      chips: [{ label: "a", source: "[a]\n" }, { label: "b", source: "[b] " }], title: "", rest: "\nBody",
    });
  });
});

describe("a text that holds only tags", () => {
  it("draws its tags as chips with an empty title line, stored or typed, and leaves the caret for the title", () => {
    const { last } = renderField("[a] [b]");
    expect(chips()).toEqual(["a", "b"]);
    expect(field().querySelector(".taskRichTags")).not.toBeNull();
    expect(title()?.textContent).toBe("");
    expect(field().textContent).toBe("ab");
    title()!.append("x");
    caretAt(titleText(), 1);
    fireEvent.input(field(), { inputType: "insertText" });
    expect(last()).toBe("[a] [b] x");
    expect(chips()).toEqual(["a", "b"]);
    expect(title()?.textContent).toBe("x");
    cleanup();
    renderField("[a]\n[b]\n\n");
    expect(chips()).toEqual(["a", "b"]);
    expect(title()?.textContent).toBe("");
  });

  it("is a text of tags on every line that holds only tags, with the title below them", () => {
    renderField("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic across browser tabs");
    expect(chips()).toEqual(["frontend", "tech-debt", "ui"]);
    expect(title()?.textContent).toBe("Make plan-intent consume atomic across browser tabs");
    expect(within(field()).getByRole("group", { name: "Tags: frontend, tech-debt, ui" })).toBeInTheDocument();
  });
});

describe("the field keeps its nodes when only its structure changes", () => {
  it("moves the text node into the title line for the first character, and splits one for an Enter, without drawing them again", () => {
    renderField("");
    const typed = document.createTextNode("Hello");
    field().append(typed);
    window.getSelection()!.collapse(typed, 5);
    fireEvent.input(field());
    expect(titleText()).toBe(typed);
    typeInto(typed, "Hel\nlo", 4);
    expect(titleText()).toBe(typed);
    expect(typed.nodeValue).toBe("Hel");
    expect(field().lastChild?.textContent).toBe("\nlo");
    expect(caret()).toEqual({ node: field().lastChild, offset: 1, collapsed: true });
  });

  it("joins the rest back into the title line when the break is deleted, with the same nodes", () => {
    const { last } = renderField("Title\nBody");
    const head = titleText();
    const rest = field().lastChild as Text;
    rest.nodeValue = "Body";
    caretAt(rest, 0);
    fireEvent.input(field());
    expect(last()).toBe("TitleBody");
    expect(title()?.firstChild).toBe(head);
    expect(title()?.lastChild).toBe(rest);
    expect(title()?.textContent).toBe("TitleBody");
    expect(field().childNodes).toHaveLength(1);
  });

  it("draws a new chip from new nodes and leaves the node the browser typed into whole", () => {
    renderField("Fix it\nBody");
    const text = titleText();
    typeInto(text, "[ui] Fix it", 4);
    expect(chips()).toEqual(["ui"]);
    expect(title()?.textContent).toBe("Fix it");
    expect(titleText()).not.toBe(text);
    expect(text.isConnected).toBe(false);
    expect(text.nodeValue).toBe("[ui] Fix it");
  });

  it("does the same for a token pasted over the title and for a second chip", () => {
    renderField("Title");
    const pasted = titleText();
    typeInto(pasted, "[x] ", 4);
    expect(chips()).toEqual(["x"]);
    expect(pasted.isConnected).toBe(false);
    expect(pasted.nodeValue).toBe("[x] ");
    const before = title()!;
    before.append("Fix");
    const typed = titleText();
    typeInto(typed, "[b] Fix", 4);
    expect(chips()).toEqual(["x", "b"]);
    expect(typed.isConnected).toBe(false);
    expect(typed.nodeValue).toBe("[b] Fix");
    expect(title()?.textContent).toBe("Fix");
  });

  it("keeps the nodes of a change that adds no chip", () => {
    renderField("[ui] Fix it\nBody");
    const text = titleText();
    const rest = field().lastChild as Text;
    typeInto(text, "Fix itx", 7);
    typeInto(rest, "\nBody!", 6);
    expect(titleText()).toBe(text);
    expect(field().lastChild).toBe(rest);
    typeInto(text, "Fix\n it", 4);
    expect(titleText()).toBe(text);
    expect(text.nodeValue).toBe("Fix");
  });
});

describe("the tags are named beside the textbox", () => {
  it("describes the textbox with a visually hidden line that lists the chips, and clears it with the last chip", () => {
    renderField("[ui] [bug] Fix it");
    const line = document.querySelector<HTMLElement>(".srOnly")!;
    expect(line).toHaveTextContent("Tags: ui, bug");
    expect(field().getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
    expect(field()).toHaveAccessibleDescription(expect.stringContaining("Tags: ui, bug"));
    expect(field().contains(line)).toBe(false);
    caretAt(titleText(), 0);
    pressBackspace();
    expect(line).toHaveTextContent("Tags: ui");
    pressBackspace();
    expect(line).toBeEmptyDOMElement();
  });

  it("names the tags of a chip that is typed", () => {
    renderField("");
    field().append("[perf] ");
    window.getSelection()!.selectAllChildren(field());
    window.getSelection()!.collapseToEnd();
    fireEvent.input(field());
    expect(document.querySelector(".srOnly")).toHaveTextContent("Tags: perf");
  });
});

describe("the caret after a line break typed in the title line", () => {
  it("is set again after an Enter, so the browser's own caret at the end of the title does not take the next text", () => {
    renderField("Title\nBody");
    // The browser has typed the break into a node after the title and left its caret at the start of the next node.
    const next = field().lastChild as Text;
    const typedBreak = document.createTextNode("\n");
    title()!.after(typedBreak);
    caretAt(next, 0);
    const collapse = vi.spyOn(window.getSelection()!, "collapse");
    fireEvent.input(field(), { inputType: "insertParagraph" });
    expect(collapse).toHaveBeenCalledWith(next, 0);
    expect(caret()).toEqual({ node: next, offset: 0, collapsed: true });
    collapse.mockClear();
    fireEvent.input(field(), { inputType: "insertLineBreak" });
    expect(collapse).toHaveBeenCalledTimes(1);
    collapse.mockRestore();
  });

  it("is left alone after typing, a deletion, a composition, and a selection that is not collapsed", () => {
    renderField("Title\nBody");
    const collapse = vi.spyOn(window.getSelection()!, "collapse");
    caretAt(titleText(), 2);
    collapse.mockClear();
    for (const inputType of ["insertText", "deleteContentBackward", "insertFromPaste"]) fireEvent.input(field(), { inputType });
    expect(collapse).not.toHaveBeenCalled();
    window.getSelection()!.setBaseAndExtent(titleText(), 1, titleText(), 3);
    fireEvent.input(field(), { inputType: "insertParagraph" });
    expect(collapse).not.toHaveBeenCalled();
    expect(window.getSelection()!.isCollapsed).toBe(false);
    collapse.mockRestore();
  });

  it("keeps the value and the nodes when the caret is set again", () => {
    const { last } = renderField("Title\nBody");
    const rest = field().lastChild as Text;
    caretAt(rest, 0);
    fireEvent.input(field(), { inputType: "insertParagraph" });
    expect(last()).toBe("Title\nBody");
    expect(field().lastChild).toBe(rest);
    expect(titleText().nodeValue).toBe("Title");
  });
});
