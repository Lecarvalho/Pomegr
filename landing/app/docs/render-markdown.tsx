import Link from "next/link";
import { Fragment } from "react";
import type { ReactNode } from "react";
import type { DocsBlock, DocsInline } from "../../scripts/docs-content.mjs";
import styles from "./markdown.module.css";

// Renders the generated documentation blocks (`landing/generated/docs-content.json`) to React
// elements. There is no raw-HTML path: every node becomes an element from a fixed mapping, text is
// always a React child, and a node or destination the renderer does not recognize is dropped (a
// link keeps its visible text). Pass `strict` to throw instead, which tests and development use so
// a new token type or a malformed link cannot pass unnoticed.

interface Context {
  strict: boolean;
}

export interface DocsMarkdownProps {
  blocks: readonly DocsBlock[];
  /** Throw on an unrecognized block, inline, or destination instead of dropping it. */
  strict?: boolean;
}

const CODE_LANGUAGE = /^[A-Za-z0-9_+-]{1,24}$/;
const FRAGMENT = "[\\p{L}\\p{M}\\p{N}\\p{Pc}-]+";
const HEADING_ID = new RegExp(`^${FRAGMENT}$`, "u");
const PAGE_ANCHOR = new RegExp(`^#${FRAGMENT}$`, "u");
const DOCS_ROUTE = new RegExp(`^/docs(?:/[a-z0-9]+(?:-[a-z0-9]+)*){0,2}(?:#${FRAGMENT})?$`, "u");
const IMAGE_ROUTE = /^\/docs\/images\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/;
const MAX_TABLE_LABEL = 120;

const HEADING_TAGS = { 1: "h1", 2: "h2", 3: "h3", 4: "h4" } as const;
const DEPTH_CLASS = { 1: styles.depth1, 2: styles.depth2, 3: styles.depth3, 4: styles.depth4 } as const;
const ALIGN_CLASS = { left: undefined, center: styles.alignCenter, right: styles.alignRight } as const;
const CALLOUTS = {
  note: { label: "Note", className: styles.note },
  caution: { label: "Caution", className: styles.caution },
} as const;

/** Drop the unrecognized node, or fail loudly when `strict`. The description never carries content. */
function unsupported(context: Context, description: string): null {
  if (context.strict) throw new Error(`Unsupported documentation ${description}`);
  return null;
}

const describeType = (value: unknown) => JSON.stringify(typeof value === "string" ? value.slice(0, 40) : typeof value);

function rawText(nodes: readonly DocsInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "code":
        out += node.text;
        break;
      case "image":
        out += node.alt;
        break;
      case "br":
        out += " ";
        break;
      case "strong":
      case "em":
      case "link":
        out += rawText(node.children);
        break;
    }
  }
  return out;
}

/** Visible text of inline nodes, used only for accessible names. */
const plainText = (nodes: readonly DocsInline[]) => rawText(nodes).replace(/\s+/g, " ").trim();

function externalKind(href: string): "web" | "mail" | null {
  try {
    const { protocol } = new URL(href);
    if (protocol === "https:" || protocol === "http:") return "web";
    if (protocol === "mailto:") return "mail";
  } catch {
    // Not an absolute URL.
  }
  return null;
}

function renderLink(node: Extract<DocsInline, { type: "link" }>, context: Context): ReactNode {
  const children = renderInlines(node.children, context);
  const href = typeof node.href === "string" ? node.href : "";

  if (node.external === true) {
    const kind = externalKind(href);
    if (!kind) {
      unsupported(context, "external link destination");
      return children;
    }
    if (kind === "mail") return <a className={styles.link} href={href}>{children}</a>;
    return (
      <a className={`${styles.link} ${styles.external}`} href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <span className={styles.visuallyHidden}> (opens in a new tab)</span>
      </a>
    );
  }

  if (PAGE_ANCHOR.test(href)) return <a className={styles.link} href={href}>{children}</a>;
  if (DOCS_ROUTE.test(href)) return <Link className={styles.link} href={href}>{children}</Link>;
  unsupported(context, "internal link destination");
  return children;
}

const isPixelSize = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

function renderImage(node: Extract<DocsInline, { type: "image" }>, context: Context): ReactNode {
  if (typeof node.alt !== "string" || node.alt.trim() === "" || !IMAGE_ROUTE.test(String(node.src)) || !isPixelSize(node.width) || !isPixelSize(node.height)) {
    return unsupported(context, "image");
  }
  // The file's pixel size reserves the box before the bytes arrive; CSS scales it to the column.
  // next/image needs an image loader the Worker does not provide; these are static assets.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.image} src={node.src} alt={node.alt} width={node.width} height={node.height} loading="lazy" decoding="async" />;
}

function renderInline(node: DocsInline, context: Context): ReactNode {
  if (!node || typeof node !== "object") return unsupported(context, "inline node");
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return <code className={styles.inlineCode}>{node.text}</code>;
    case "strong":
      return <strong>{renderInlines(node.children, context)}</strong>;
    case "em":
      return <em>{renderInlines(node.children, context)}</em>;
    case "br":
      return <br />;
    case "link":
      return renderLink(node, context);
    case "image":
      return renderImage(node, context);
    default:
      return unsupported(context, `inline type ${describeType((node as { type?: unknown } | null)?.type)}`);
  }
}

function renderInlines(nodes: readonly DocsInline[], context: Context): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderInline(node, context)}</Fragment>);
}

function renderHeading(block: Extract<DocsBlock, { type: "heading" }>, context: Context): ReactNode {
  const Tag = HEADING_TAGS[block.depth];
  if (!Tag) return unsupported(context, `heading depth ${describeType(block.depth)}`);
  const validId = typeof block.id === "string" && HEADING_ID.test(block.id);
  if (!validId) unsupported(context, "heading anchor");
  const id = validId ? block.id : undefined;
  const heading = <Tag id={id}>{renderInlines(block.children, context)}</Tag>;
  // The page title keeps its id but gets no permalink; deeper headings link to themselves.
  if (block.depth === 1 || !id) return <div className={`${styles.heading} ${DEPTH_CLASS[block.depth]}`}>{heading}</div>;
  return (
    <div className={`${styles.heading} ${DEPTH_CLASS[block.depth]}`}>
      {heading}
      <a className={styles.anchor} href={`#${id}`} aria-label={`Link to this section: ${plainText(block.children)}`}>
        <span aria-hidden="true">#</span>
      </a>
    </div>
  );
}

function renderTable(block: Extract<DocsBlock, { type: "table" }>, context: Context): ReactNode {
  const label = `Table: ${block.header.map((cell) => plainText(cell)).join(", ")}`;
  const alignOf = (index: number) => {
    const align = block.align[index];
    return align ? ALIGN_CLASS[align] : undefined;
  };
  return (
    <div
      className={styles.tableScroll}
      role="region"
      aria-label={label.length > MAX_TABLE_LABEL ? `${label.slice(0, MAX_TABLE_LABEL - 3)}...` : label}
      tabIndex={0}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            {block.header.map((cell, column) => (
              <th key={column} scope="col" className={alignOf(column)}>{renderInlines(cell, context)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column} className={alignOf(column)}>{renderInlines(cell, context)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderList(block: Extract<DocsBlock, { type: "list" }>, context: Context): ReactNode {
  const items = block.items.map((item, index) => <li key={index}>{renderBlocks(item, context)}</li>);
  if (!block.ordered) return <ul className={styles.list}>{items}</ul>;
  const start = typeof block.start === "number" && block.start !== 1 ? block.start : undefined;
  return <ol className={styles.list} start={start}>{items}</ol>;
}

function renderBlock(block: DocsBlock, context: Context): ReactNode {
  if (!block || typeof block !== "object") return unsupported(context, "block node");
  switch (block.type) {
    case "heading":
      return renderHeading(block, context);
    case "paragraph": {
      const imageOnly = block.children.length === 1 && block.children[0].type === "image";
      return <p className={imageOnly ? styles.imageBlock : undefined}>{renderInlines(block.children, context)}</p>;
    }
    case "list":
      return renderList(block, context);
    case "table":
      return renderTable(block, context);
    case "codeblock": {
      const language = CODE_LANGUAGE.test(block.lang) ? block.lang : undefined;
      if (!language) unsupported(context, "code language");
      // A scrollable region must be reachable by keyboard.
      return (
        <pre className={styles.codeBlock} tabIndex={0}>
          <code className={language ? `language-${language}` : undefined}>{block.text}</code>
        </pre>
      );
    }
    case "callout": {
      const callout = CALLOUTS[block.kind];
      if (!callout) return unsupported(context, `callout kind ${describeType(block.kind)}`);
      return (
        <div className={`${styles.callout} ${callout.className}`} role="note">
          <p className={styles.calloutLabel}>{callout.label}</p>
          {renderBlocks(block.blocks, context)}
        </div>
      );
    }
    case "quote":
      return <blockquote className={styles.quote}>{renderBlocks(block.blocks, context)}</blockquote>;
    default:
      return unsupported(context, `block type ${describeType((block as { type?: unknown } | null)?.type)}`);
  }
}

function renderBlocks(blocks: readonly DocsBlock[], context: Context): ReactNode {
  return blocks.map((block, index) => <Fragment key={index}>{renderBlock(block, context)}</Fragment>);
}

/** The reading column for one page's blocks. The docs layout supplies the page frame and navigation. */
export function DocsMarkdown({ blocks, strict = false }: DocsMarkdownProps) {
  return <div className={styles.markdown}>{renderBlocks(blocks, { strict })}</div>;
}
