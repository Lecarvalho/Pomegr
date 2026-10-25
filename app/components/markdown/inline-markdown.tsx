import type { ReactNode } from "react";

// Inline formatting for one run of agent-written text. It builds React elements from text and nothing else: no HTML
// string is ever set. Links stay literal unless the caller supplies a renderer; images always stay literal.

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/gu;
const WITH_LINKS = new RegExp(`${INLINE.source}|(!?)\\[([^\\]\\r\\n]+)\\]\\(`, "gu");
type LinkRenderer = (url: string, children: ReactNode[], key: number) => ReactNode;

export function inlineMarkdown(text: string, codeClassName: string, allowBold = true, renderLink?: LinkRenderer): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(renderLink ? WITH_LINKS : INLINE)) {
    if (match.index < last || (!allowBold && match[2] !== undefined)) continue;
    let end = match.index + match[0].length;
    let link: ReactNode;
    if (match[4] !== undefined) {
      const start = end;
      let depth = 1;
      while (end < text.length && depth && !/[\r\n]/u.test(text[end])) {
        if (text[end] === "(") depth += 1;
        if (text[end] === ")") depth -= 1;
        end += 1;
      }
      if (depth) continue;
      const value = text.slice(start, end - 1);
      let url: URL | undefined;
      try { url = new URL(value); } catch { /* Unsupported destinations stay literal. */ }
      link = !match[3] && value.length <= 2048 && url?.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048
        ? renderLink!(url.href, inlineMarkdown(match[4], codeClassName, allowBold), match.index)
        : inlineMarkdown(text.slice(match.index, end), codeClassName, allowBold);
    }
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) nodes.push(<code key={match.index} className={codeClassName}>{match[1]}</code>);
    else if (match[2] !== undefined) nodes.push(<strong key={match.index}>{inlineMarkdown(match[2], codeClassName, false, renderLink)}</strong>);
    else nodes.push(link);
    last = end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
