import { inlineCodeParts } from "./task-presentation";

/** Task text on one line, with each backtick code span drawn as code and its backticks left out. */
export function TaskInlineText({ text }: { text: string }) {
  return <>{inlineCodeParts(text).map((part, index) => index % 2 === 1 ? <code key={index}>{part}</code> : part)}</>;
}
