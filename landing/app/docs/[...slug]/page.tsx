import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { DocsHeading, DocsPage, DocsPageLink } from "../../../scripts/docs-content.mjs";
import { docsContent, findDocsGroup, findDocsPage, slugOf } from "../content";
import { DocsMarkdown } from "../render-markdown";
import styles from "../docs.module.css";

// The one route behind every published page. Content comes from the generated manifest data; no
// page has a hand-written route. A slug the manifest does not publish is the site's 404.
export const dynamicParams = false;

interface RouteProps {
  params: Promise<{ slug?: string[] }>;
}

export function generateStaticParams() {
  return docsContent.pages.map((page) => ({ slug: slugOf(page.route) }));
}

export async function generateMetadata({ params }: RouteProps): Promise<Metadata> {
  const page = findDocsPage((await params).slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.route },
  };
}

export default async function DocsPageRoute({ params }: RouteProps) {
  const page = findDocsPage((await params).slug);
  if (!page) notFound();
  const group = findDocsGroup(page);
  const outline = buildOutline(page.headings);

  return (
    <div className={styles.page}>
      {outline.length > 0 ? (
        <details className={styles.outlineCompact}>
          <summary>On this page</summary>
          <OutlineList items={outline} />
        </details>
      ) : null}
      <div className={styles.column}>
        <article className={styles.article}>
          {group ? <p className={styles.eyebrow}>{group.title}</p> : null}
          <DocsMarkdown blocks={page.blocks} strict={import.meta.env.DEV} />
        </article>
        <Pager previous={page.previous} next={page.next} />
      </div>
      {outline.length > 0 ? (
        <nav className={styles.outlineRail} aria-labelledby="docs-outline-label">
          <p id="docs-outline-label" className={styles.outlineLabel}>On this page</p>
          <OutlineList items={outline} />
        </nav>
      ) : null}
    </div>
  );
}

interface OutlineItem {
  id: string;
  text: string;
  children: OutlineItem[];
}

/** Second- and third-level headings, each third-level heading nested under the second-level one before it. */
function buildOutline(headings: readonly DocsHeading[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const heading of headings) {
    if (heading.depth === 2) items.push({ id: heading.id, text: heading.text, children: [] });
    else if (heading.depth === 3 && items.length > 0) items[items.length - 1].children.push({ id: heading.id, text: heading.text, children: [] });
  }
  return items;
}

function OutlineList({ items }: { items: readonly OutlineItem[] }) {
  return (
    <ul className={styles.outlineList}>
      {items.map((item) => (
        <li key={item.id}>
          <a href={`#${item.id}`}>{item.text}</a>
          {item.children.length > 0 ? <OutlineList items={item.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Pager({ previous, next }: { previous: DocsPage["previous"]; next: DocsPage["next"] }) {
  if (!previous && !next) return null;
  return (
    <nav className={styles.pager} aria-label="Previous and next pages">
      {previous ? <PagerLink link={previous} direction="previous" /> : null}
      {next ? <PagerLink link={next} direction="next" /> : null}
    </nav>
  );
}

function PagerLink({ link, direction }: { link: DocsPageLink; direction: "previous" | "next" }) {
  return (
    <Link className={styles.pagerLink} href={link.route} rel={direction === "previous" ? "prev" : "next"} data-direction={direction}>
      <span className={styles.pagerLabel}>{direction === "previous" ? "Previous" : "Next"}</span>
      <span className={styles.pagerTitle}>{link.title}</span>
    </Link>
  );
}
