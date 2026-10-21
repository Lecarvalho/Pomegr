export const TASK_TAG_LIMIT = 8;

const TAG_TOKEN = /^\[[ \t]*([\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,23})[ \t]*\]/u;
/** The word that stands for an image in a plain task text. It is never a tag. */
const IMAGE_WORD = "image";
/** Two line breaks with only spaces and tabs between them: a blank line, which ends a run of tags. */
const BLANK_LINE = /(?:\r\n|\n|\r(?!\n))[^\S\r\n]*(?:\r\n|\n|\r)/u;
/** What may follow a token for it to be a tag: whitespace, or the end of the text. */
const isGap = (character: string | undefined) => character === undefined || character === " " || character === "\t" || character === "\n" || character === "\r";

export type TaskTagged = {
  /** The tags of the leading run, as typed, without repeats. */
  tags: string[];
  /** The text after the leading run, which has taken the whitespace after its last token, line breaks included. */
  text: string;
  /** The characters the run took from the start of the text, so an editor can keep them. */
  runLength: number;
};

/**
 * The leading run of `[ word ]` tokens at the very start of a task text, as tags. Any whitespace, line breaks included, separates the
 * tokens, so leading lines that hold only tags all join the run. A token that touches other text ends the run, and so does a blank line.
 * A display heuristic: the stored text keeps its brackets.
 */
export function splitTaskTags(text: string): TaskTagged {
  const tags: string[] = [];
  const seen = new Set<string>();
  let index = text.length - text.trimStart().length;
  if (text.slice(0, index).includes("\n")) return { tags, text, runLength: 0 };
  let runLength = 0;
  while (tags.length < TASK_TAG_LIMIT) {
    const match = TAG_TOKEN.exec(text.slice(index));
    if (!match) break;
    const after = index + match[0].length;
    if (!isGap(text[after])) break;
    const word = match[1];
    if (word.toLowerCase() === IMAGE_WORD) break;
    const key = word.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(word);
    }
    index = after;
    while (/\s/u.test(text[index] ?? "")) index += 1;
    // A blank line ends the run: the text after it is the body, even when it starts with a bracket.
    if (BLANK_LINE.test(text.slice(after, index))) {
      runLength = index;
      break;
    }
    runLength = index;
  }
  if (tags.length === 0) return { tags, text, runLength: 0 };
  return { tags, text: text.slice(runLength), runLength };
}

/**
 * The text with one space after each token of the leading run that touches the text after it, for the tokens that end in `[from, to]`, and how many
 * spaces that added; null when there is none. The editor calls it after the person types or pastes there, so the token is a tag, as it is when
 * it is typed one character at a time. A token that is outside the run, that holds the image word, or that follows a blank line is left alone.
 */
export function spaceGluedTokens(text: string, from: number, to: number): { text: string; added: number } | null {
  let value = text;
  let added = 0;
  for (let round = 0; round <= TASK_TAG_LIMIT; round += 1) {
    const run = splitTaskTags(value);
    if (run.tags.length >= TASK_TAG_LIMIT) break;
    let stop = run.runLength;
    if (run.tags.length === 0) {
      stop = value.length - value.trimStart().length;
      if (value.slice(0, stop).includes("\n")) break;
    } else if (BLANK_LINE.test(value.slice(0, stop).match(/\s*$/u)![0])) break;
    const match = TAG_TOKEN.exec(value.slice(stop));
    if (!match || match[1].toLowerCase() === IMAGE_WORD) break;
    const after = stop + match[0].length;
    if (isGap(value[after]) || after < from || after > to) break;
    value = `${value.slice(0, after)} ${value.slice(after)}`;
    added += 1;
    to += 1;
  }
  return added === 0 ? null : { text: value, added };
}

export type TaskTitled = {
  /** The tags of the leading run. Empty for a text that holds nothing but tags: that text is its own title. */
  tags: string[];
  /** The title line: the first non-empty line after the tags, trimmed, without a leading Markdown heading mark. */
  title: string;
  /** The text after the title line, with its line breaks as `\n`. */
  rest: string;
};

const HEADING_MARK = /^#{1,6}\s+/u;

/**
 * The one title rule of every surface that names a task: the tags of the first line, then the first non-empty line after them as the
 * title, then the rest. A blank line (also one of spaces, or a Windows line break) never leads, and a heading mark is left out.
 * A text of only tags is its own bare title, its lines joined by a space, and has no tags. A display heuristic: the stored text is never changed.
 * `server/tasks/task-tags.mjs` has the same function for the Tasks home.
 */
export function splitTaskTitle(text: string): TaskTitled {
  const plain = text.replace(/\r\n?/gu, "\n");
  const { tags, text: untagged } = splitTaskTags(plain);
  const bare = tags.length > 0 && untagged.trim() === "";
  const lines = (bare ? plain : untagged).split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  if (at < 0) return { tags: [], title: "", rest: "" };
  // A text of only tags is its title: the lines of the run, on one line.
  const line = bare ? lines.map((each) => each.trim()).filter((each) => each !== "").join(" ") : lines[at].trim();
  return { tags: bare ? [] : tags, title: bare ? line : line.replace(HEADING_MARK, ""), rest: bare ? "" : lines.slice(at + 1).join("\n") };
}
