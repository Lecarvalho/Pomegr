// Types for the build-time documentation loader and the generated content it emits
// (`landing/generated/docs-content.json`). Import types only from runtime code: the Worker
// must bundle the generated JSON, never `docs-content.mjs` itself.

export type DocsInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: DocsInline[] }
  | { type: "em"; children: DocsInline[] }
  | { type: "br" }
  /** `href` is an absolute `/docs/...` route (optionally with `#anchor`), a bare `#anchor`, or an http(s)/mailto URL when `external`. */
  | { type: "link"; href: string; external: boolean; children: DocsInline[] }
  /** `src` is a `/docs/images/<topic>/<file>` route; `alt` is non-empty plain text. */
  | { type: "image"; src: string; alt: string };

export type DocsBlock =
  | { type: "heading"; depth: 1 | 2 | 3 | 4; id: string; children: DocsInline[] }
  | { type: "paragraph"; children: DocsInline[] }
  | { type: "list"; ordered: boolean; start: number | null; items: DocsBlock[][] }
  | { type: "table"; align: Array<"left" | "center" | "right" | null>; header: DocsInline[][]; rows: DocsInline[][][] }
  | { type: "codeblock"; lang: string; text: string }
  | { type: "callout"; kind: "note" | "caution"; blocks: DocsBlock[] }
  | { type: "quote"; blocks: DocsBlock[] };

export interface DocsHeading {
  depth: number;
  id: string;
  text: string;
}

export interface DocsPageLink {
  route: string;
  title: string;
}

export interface DocsPage {
  /** `/docs/<group>/<slug>`, no trailing slash. */
  route: string;
  /** Source path relative to the public documentation root, such as `concepts/cache-reuse.md`. */
  source: string;
  group: string;
  title: string;
  description: string;
  /** Every heading in document order, including the single depth-1 title. */
  headings: DocsHeading[];
  blocks: DocsBlock[];
  previous: DocsPageLink | null;
  next: DocsPageLink | null;
}

export interface DocsNavigationGroup {
  id: string;
  title: string;
  pages: DocsPageLink[];
}

export interface DocsImage {
  route: string;
  bytes: number;
  sha256: string;
}

export interface DocsContent {
  schema: 1;
  /** SHA-256 over the manifest, every selected page's normalized Markdown, and every referenced image. */
  revision: string;
  /** Route of the first page in reading order, or null when the manifest selects nothing. */
  entry: string | null;
  /** Non-empty groups in manifest order. */
  navigation: DocsNavigationGroup[];
  /** Pages in reading order. */
  pages: DocsPage[];
  /** Referenced images only, sorted by route. */
  images: DocsImage[];
}

export interface DocsAsset extends DocsImage {
  /** Path beneath `public/docs/images/`, such as `topic/file.jpg`. */
  relativePath: string;
  data: Buffer;
}

export interface DocsContentOptions {
  /** Absolute path of the landing package; defaults to the package containing this module. */
  landingRoot?: string;
}

export const CONTENT_SCHEMA_VERSION: 1;
export const CONTENT_INPUTS: Readonly<{ manifest: string; publicRoot: string }>;
export const GENERATED_CONTENT_FILE: string;
export const GENERATED_IMAGES_DIR: string;
export const GENERATED_SEARCH_FILE: string;
export const GROUP_IDS: readonly string[];
export const DOCS_ROUTE_PREFIX: string;
export const IMAGE_ROUTE_PREFIX: string;

export class DocsContentError extends Error {
  readonly issues: string[];
  constructor(issues: string[]);
}

export function decodeCharacterReferences(text: string): string;
export function slugifyHeading(text: string): string;
export function createSlugger(): (text: string) => string;

export interface ManifestPage {
  source: string;
  group: string;
  topic: string;
  route: string;
}
export interface ManifestGroup {
  id: string;
  title: string;
  pages: ManifestPage[];
}
export function validateManifest(raw: unknown): { groups: ManifestGroup[]; issues: string[] };

export function parseFrontMatter(markdown: string): {
  metadata: { title: string; description: string } | null;
  body: string;
  bodyLine: number;
  issues: Array<{ message: string; line: number }>;
};

export function inspectDocsContent(options?: DocsContentOptions): {
  content: DocsContent | null;
  assets: DocsAsset[];
  issues: string[];
};
export function loadDocsContent(options?: DocsContentOptions): { content: DocsContent; assets: DocsAsset[] };
export function serializeDocsContent(content: DocsContent): string;
export function writePreparedDocs(options: DocsContentOptions & { content: DocsContent; assets: DocsAsset[] }): {
  contentFile: string;
  /** The search index built from the same content; see `docs-search.mjs`. */
  searchFile: string;
  imagesRoot: string;
};
