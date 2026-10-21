// Display-only tags of a task text: the leading run of `[ word ]` tokens at the very start of the text, separated by any whitespace.
// The twin of app/components/tasks/task-tags.ts, which the server cannot import; tests/server/tasks/task-tags.test.mjs
// runs the same cases against both. The stored text keeps its brackets.

export const TASK_TAG_LIMIT = 8;

const TAG_TOKEN = /^\[[ \t]*([\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,23})[ \t]*\]/u;
// The word that stands for an image in a plain task text. It is never a tag.
const IMAGE_WORD = "image";
// Two line breaks with only spaces and tabs between them: a blank line, which ends a run of tags.
const BLANK_LINE = /(?:\r\n|\n|\r(?!\n))[^\S\r\n]*(?:\r\n|\n|\r)/u;

// Returns `{ tags, text, runLength }`: the tags as typed without repeats, the text after the run (which has taken the
// whitespace after its last token, line breaks included), and the characters the run took. A token that touches other
// text ends the run, and so does a blank line.
export function splitTaskTags(text) {
  const tags = [];
  const seen = new Set();
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

const HEADING_MARK = /^#{1,6}\s+/u;

// The one title rule, the twin of `splitTaskTitle` in the app file. Returns `{ tags, title, rest }`: the title is the first
// non-empty line after the tags (a blank line never leads), trimmed and without a leading Markdown heading mark, and a text of
// only tags is its own bare title, its lines joined by a space, and has no tags. A display heuristic: the stored text is never changed.
export function splitTaskTitle(text) {
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
