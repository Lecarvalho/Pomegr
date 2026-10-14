import { useMemo } from "react";
import { inlineMarkdown } from "../inline-markdown";

// A small, safe renderer for Aril's answers. It builds React elements from text and nothing else: no HTML string is
// ever set, a link or an image is shown as the literal characters it was written with, and nothing navigates.

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] };

const OPENING_FENCE = /^\s{0,3}(`{3,}|~{3,})[^`]*$/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*$/u;
const BULLET = /^\s*[-*]\s+(.*)$/u;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/u;

const isClosingFence = (line: string, marker: string) => {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed.split("").every((character) => character === marker[0]);
};

function startsBlock(line: string): boolean {
  return OPENING_FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line);
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") { index += 1; continue; }
    const fence = OPENING_FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      // A fence that is still open (an answer being written) holds the rest of the text.
      while (index < lines.length && !isClosingFence(lines[index], fence[1])) { body.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", text: heading[1] }); index += 1; continue; }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const items: string[] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      while (index < lines.length) {
        const item = ordered ? ORDERED.exec(lines[index]) : BULLET.exec(lines[index]);
        if (!item) break;
        items.push(ordered ? item[2] : item[1]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered: Boolean(ordered), start, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== "" && (paragraph.length === 0 || !startsBlock(lines[index]))) { paragraph.push(lines[index]); index += 1; }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

const inline = (text: string) => inlineMarkdown(text, "agentChatInlineCode");

export function AgentChatMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="agentChatMarkdown">
    {blocks.map((block, index) => {
      switch (block.kind) {
        case "heading": return <p key={index} className="agentChatMdHeading">{inline(block.text)}</p>;
        case "code": return <pre key={index} className="agentChatCode"><code>{block.text}</code></pre>;
        case "list": {
          const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>);
          return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        case "paragraph": return <p key={index}>{inline(block.text)}</p>;
      }
    })}
  </div>;
}
