import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { inspectDocsContent } from "../../scripts/docs-content.mjs";
import type { DocsBlock, DocsContent, DocsInline, DocsPage } from "../../scripts/docs-content.mjs";

// Shared fixtures for the documentation loader tests: a throwaway repository with landing/
// beside docs/site.json and docs/public/.

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
export const FENCE = "```";
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const scratch: string[] = [];

/** Register with `afterEach` in every test file that creates fixtures. */
export function cleanupScratch() {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

export function put(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export interface Repo {
  root: string;
  landingRoot: string;
  docs: string;
  publicRoot: string;
}

export function makeRepo(manifest: unknown, files: Record<string, string | Buffer> = {}): Repo {
  const root = temporaryDirectory("pomegr-docs-");
  const landingRoot = join(root, "landing");
  const docs = join(root, "docs");
  const publicRoot = join(docs, "public");
  mkdirSync(landingRoot);
  mkdirSync(publicRoot, { recursive: true });
  put(join(docs, "site.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  put(join(docs, "internal", "secret.md"), doc("Secret", "INTERNAL_SENTINEL"));
  for (const [path, data] of Object.entries(files)) put(join(publicRoot, path), data);
  return { root, landingRoot, docs, publicRoot };
}

export const frontMatter = (title: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(`About ${title}.`)}\n---\n`;
export const doc = (title: string, body = "Body text.") => `${frontMatter(title)}\n# ${title}\n\n${body}\n`;

export const baseManifest = {
  version: 1,
  groups: [
    { id: "get-started", title: "Get started", pages: ["get-started/alpha.md", "get-started/beta.md"] },
    { id: "concepts", title: "Concepts", pages: ["concepts/gamma.md"] },
  ],
};

export function standard(overrides: Record<string, string | Buffer> = {}, manifest: unknown = baseManifest): Repo {
  return makeRepo(manifest, {
    "get-started/alpha.md": doc("Alpha", "## Alpha section\n\nText."),
    "get-started/beta.md": doc("Beta"),
    "concepts/gamma.md": doc("Gamma", "## Gamma heading\n\nText."),
    "help/hidden.md": doc("Hidden", "HIDDEN_SENTINEL"),
    "images/topic/shot.jpg": JPG,
    "images/topic/unused.jpg": JPG,
    ...overrides,
  });
}

export const alphaWith = (body: string) => ({ "get-started/alpha.md": doc("Alpha", `## Alpha section\n\n${body}`) });

export function inspect(repo: Repo) {
  return inspectDocsContent({ landingRoot: repo.landingRoot });
}

export function loaded(repo: Repo): DocsContent {
  const { content, issues } = inspect(repo);
  expect(issues).toEqual([]);
  if (!content) throw new Error("expected content");
  return content;
}

export function pageOf(content: DocsContent, source: string): DocsPage {
  const page = content.pages.find((candidate) => candidate.source === source);
  if (!page) throw new Error(`missing page ${source}`);
  return page;
}

export function rejected(repo: Repo): string {
  const result = inspect(repo);
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.content).toBeNull();
  expect(result.assets).toEqual([]);
  return result.issues.join("\n");
}

export function* inlinesOf(blocks: DocsBlock[]): Generator<DocsInline> {
  const walk = function* (nodes: DocsInline[]): Generator<DocsInline> {
    for (const node of nodes) {
      yield node;
      if ("children" in node) yield* walk(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") yield* walk(block.children);
    else if (block.type === "list") for (const item of block.items) yield* inlinesOf(item);
    else if (block.type === "table") for (const cell of [...block.header, ...block.rows.flat()]) yield* walk(cell);
    else if (block.type === "callout" || block.type === "quote") yield* inlinesOf(block.blocks);
  }
}

