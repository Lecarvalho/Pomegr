export const TASK_TAG_LIMIT = 8;

const TAG_TOKEN = /^\[[ \t]*([\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,23})[ \t]*\]/u;
/** The word that stands for an image in a plain task text. It is never a tag. */
const IMAGE_WORD = "image";

export type TaskTagged = {
  /** The tags of the leading run, as typed, without repeats. */
  tags: string[];
  /** The text with the leading run removed. A first line that held only tags is removed with it. */
  text: string;
  /** The characters the run took from the start of the text, so an editor can keep them. */
  runLength: number;
};

/**
 * The leading run of `[ word ]` tokens at the start of a task text's first line, as tags.
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
    const next = text[after];
    if (next !== undefined && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") break;
    const word = match[1];
    if (word.toLowerCase() === IMAGE_WORD) break;
    const key = word.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(word);
    }
    index = after;
    while (text[index] === " " || text[index] === "\t") index += 1;
    runLength = index;
  }
  if (tags.length === 0) return { tags, text, runLength: 0 };
  let rest = text.slice(runLength);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);
  return { tags, text: rest, runLength };
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
 * A text of only tags is its own bare title and has no tags. A display heuristic: the stored text is never changed.
 * `server/tasks/task-tags.mjs` has the same function for the Tasks home.
 */
export function splitTaskTitle(text: string): TaskTitled {
  const plain = text.replace(/\r\n?/gu, "\n");
  const { tags, text: untagged } = splitTaskTags(plain);
  const bare = tags.length > 0 && untagged.trim() === "";
  const lines = (bare ? plain : untagged).split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  if (at < 0) return { tags: [], title: "", rest: "" };
  const line = lines[at].trim();
  return { tags: bare ? [] : tags, title: bare ? line : line.replace(HEADING_MARK, ""), rest: bare ? "" : lines.slice(at + 1).join("\n") };
}
