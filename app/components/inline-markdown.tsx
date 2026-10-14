import type { ReactNode } from "react";

// Inline formatting for one run of agent-written text. It builds React elements from text and nothing else: no HTML
// string is ever set, a link or an image stays the literal characters it was written with, and nothing navigates.

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/gu;

export function inlineMarkdown(text: string, codeClassName: string, allowBold = true): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (!allowBold && match[1] === undefined) continue;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) nodes.push(<code key={match.index} className={codeClassName}>{match[1]}</code>);
    else nodes.push(<strong key={match.index}>{inlineMarkdown(match[2], codeClassName, false)}</strong>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
