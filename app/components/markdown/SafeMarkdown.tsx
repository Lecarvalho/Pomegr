import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

function httpsUrl(value: string): string | undefined {
  if (value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048) return url.href;
  } catch { /* Unsupported destinations stay literal. */ }
}

// Keep unsupported constructs as their original source before conversion to React elements.
function remarkLiteralContent({ links }: { links: boolean }) {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    function literal(node: RootContent): RootContent {
      const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
      if (node.type === "html" || node.type === "image" || node.type === "imageReference"
        || node.type === "footnoteDefinition" || node.type === "footnoteReference" || node.type === "linkReference" || node.type === "definition") {
        return { type: "text", value: raw };
      }
      if (node.type === "link") {
        const url = httpsUrl(node.url);
        // GFM autolinks are text even when the caller has a desktop link opener.
        if (!links || !raw.startsWith("[") || !node.children.length || /[\r\n]/u.test(raw) || !url) return { type: "text", value: raw };
        node.url = url;
      }
      if ("children" in node) node.children = node.children.map(literal) as typeof node.children;
      return node;
    }
    tree.children = tree.children.map(literal);
  };
}

const Heading = ({ children }: { children?: ReactNode }) => <p className="agentChatMdHeading">{children}</p>;

export function SafeMarkdown({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  return <div className="agentChatMarkdown">
    <ReactMarkdown remarkPlugins={[remarkGfm, [remarkLiteralContent, { links: Boolean(onOpenLink) }]]}
      urlTransform={(url) => httpsUrl(url) ?? ""}
      components={{
        h1: Heading, h2: Heading, h3: Heading, h4: Heading, h5: Heading, h6: Heading,
        pre: ({ children }) => <pre className="agentChatCode">{children}</pre>,
        code: ({ children }) => <code className="agentChatInlineCode">{children}</code>,
        table: ({ children }) => <div className="agentChatTableScroll" tabIndex={0} role="region" aria-label="Markdown table"><table>{children}</table></div>,
        input: ({ checked }) => <span className="agentChatTaskGlyph" role="img" aria-label={checked ? "Checked" : "Unchecked"}>{checked ? "☑" : "☐"}</span>,
        img: ({ node }) => text.slice(node?.position?.start.offset, node?.position?.end.offset),
        a: ({ href, children, node }) => {
          const url = httpsUrl(href ?? "");
          return onOpenLink && url
            ? <a className="safeMarkdownLink" href={url} title={url} onClick={(event) => { event.preventDefault(); onOpenLink(url); }}>{children}</a>
            : text.slice(node?.position?.start.offset, node?.position?.end.offset);
        },
      }}>{text}</ReactMarkdown>
  </div>;
}
