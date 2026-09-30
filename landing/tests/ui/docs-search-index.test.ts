import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_SEARCH_FILE, loadDocsContent, serializeDocsContent, writePreparedDocs } from "../../scripts/docs-content.mjs";
import type { DocsContent } from "../../scripts/docs-content.mjs";
import { SEARCH_INDEX_MAX_BYTES, SEARCH_TEXT_LIMIT, buildSearchIndex, serializeSearchIndex } from "../../scripts/docs-search.mjs";
import type { DocsSearchIndex } from "../../scripts/docs-search.mjs";
import { FENCE, alphaWith, cleanupScratch, loaded, standard } from "./docs-fixtures";

// The search index generator (WEB-03): a pure function of the prepared content, written by the same
// prepare step as the content, so it can only hold what the published pages hold.

afterEach(cleanupScratch);

const generatedPath = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const { content: realContent } = loadDocsContent();
const readIndex = (): DocsSearchIndex => JSON.parse(readFileSync(generatedPath(GENERATED_SEARCH_FILE), "utf8"));

describe("index built from fixture content", () => {
  const body = [
    "Plain **bold** and `inline code` with a [link text](https://example.com/page) and a line\\",
    "break.",
    "",
    "- first item",
    "- second item",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| cell one | cell two |",
    "",
    "> **Note:** callout words stay.",
    "",
    `${FENCE}text`,
    "CODE_BLOCK_SENTINEL",
    FENCE,
    "",
    "![Alt text sentinel](../images/topic/shot.jpg)",
    "",
    "### Nested heading",
    "",
    "Closing words.",
  ].join("\n");
  const content = loaded(standard(alphaWith(body)));
  const index = buildSearchIndex(content);
  const alpha = index.pages.find((page) => page.route === "/docs/get-started/alpha")!;

  it("lists each page in reading order with its route, group title, title, and description", () => {
    expect(index.schema).toBe(1);
    expect(index.revision).toBe(content.revision);
    expect(index.pages.map((page) => page.route)).toEqual(content.pages.map((page) => page.route));
    expect(alpha).toMatchObject({ group: "Get started", title: "Alpha", description: "About Alpha." });
    expect(index.pages.find((page) => page.route === "/docs/concepts/gamma")!.group).toBe("Concepts");
    expect(Object.keys(alpha).sort()).toEqual(["description", "group", "headings", "route", "text", "title"]);
  });

  it("keeps the second- to fourth-level headings with their anchors and leaves the title out", () => {
    expect(alpha.headings).toEqual([
      { id: "alpha-section", text: "Alpha section" },
      { id: "nested-heading", text: "Nested heading" },
    ]);
  });

  it("flattens prose, lists, tables, and callouts to plain text, without code blocks or image alt text", () => {
    expect(alpha.text).toContain("Plain bold and inline code with a link text and a line break.");
    expect(alpha.text).toContain("first item second item");
    expect(alpha.text).toContain("Name Value cell one cell two");
    expect(alpha.text).toContain("callout words stay.");
    expect(alpha.text).toContain("Closing words.");
    expect(alpha.text).not.toContain("CODE_BLOCK_SENTINEL");
    expect(alpha.text).not.toContain("sentinel");
    expect(alpha.text).not.toContain("https://example.com");
    expect(alpha.text).not.toMatch(/[*`|>\\]/);
  });

  it("is deterministic and serializes compactly with a trailing newline", () => {
    expect(serializeSearchIndex(buildSearchIndex(content))).toBe(serializeSearchIndex(index));
    expect(serializeSearchIndex(index)).toBe(`${JSON.stringify(index)}\n`);
    expect(serializeSearchIndex(index)).not.toMatch(/\r|\n\s/);
  });

  it("cuts a long body at a word boundary within the limit", () => {
    const words = Array.from({ length: 900 }, (_, number) => `word${number}`).join(" ");
    const long = buildSearchIndex(loaded(standard(alphaWith(words)))).pages[0].text;
    expect(long.length).toBeLessThanOrEqual(SEARCH_TEXT_LIMIT);
    expect(long.length).toBeGreaterThan(SEARCH_TEXT_LIMIT - 12);
    expect(long).toMatch(/^word0 word1 /);
    expect(long).toMatch(/word\d+$/);
    const full = words.split(" ");
    expect(full).toContain(long.split(" ").pop());
  });

  it("carries nothing from an unselected or internal page", () => {
    const serialized = serializeSearchIndex(index);
    expect(serialized).not.toContain("HIDDEN_SENTINEL");
    expect(serialized).not.toContain("INTERNAL_SENTINEL");
    expect(index.pages.some((page) => page.route.includes("hidden") || page.route.includes("secret"))).toBe(false);
  });
});

describe("index of the real documentation", () => {
  const index = buildSearchIndex(realContent);

  it("covers every published page from the same revision as the content", () => {
    expect(index.pages).toHaveLength(17);
    expect(index.revision).toBe(realContent.revision);
    expect(index.pages.map((page) => page.route)).toEqual(realContent.pages.map((page) => page.route));
    realContent.pages.forEach((page, position) => {
      expect(index.pages[position]).toMatchObject({ title: page.title, description: page.description });
      expect(index.pages[position].headings.map((heading) => heading.id)).toEqual(page.headings.filter((heading) => heading.depth >= 2).map((heading) => heading.id));
      expect(index.pages[position].text.length).toBeGreaterThan(0);
      expect(index.pages[position].text.length).toBeLessThanOrEqual(SEARCH_TEXT_LIMIT);
    });
  });

  it("is what the prepare step wrote, byte for byte, beside content of the same revision", () => {
    expect(readFileSync(generatedPath(GENERATED_SEARCH_FILE), "utf8")).toBe(serializeSearchIndex(index));
    expect(readFileSync(generatedPath("generated/docs-content.json"), "utf8")).toBe(serializeDocsContent(realContent as DocsContent));
    expect(readIndex().revision).toBe(realContent.revision);
  });

  it("stays small enough to load on demand", () => {
    const bytes = statSync(generatedPath(GENERATED_SEARCH_FILE)).size;
    expect(bytes).toBeLessThan(SEARCH_INDEX_MAX_BYTES);
    expect(bytes).toBeLessThan(realContent.pages.length * (SEARCH_TEXT_LIMIT + 1500));
  });

  it("contains no internal, plan, mockup, local-app, or filesystem path", () => {
    const serialized = serializeSearchIndex(index);
    expect(serialized).not.toMatch(/docs[\\/](?:internal|plans|mockups|design|user-guide)[\\/]/i);
    expect(serialized).not.toMatch(/\/api\/(?:state|sessions)|monitor[\\/]server|desktop[\\/]main|shared[\\/]local-|C:[\\/]Workspace/i);
    expect(serialized).not.toMatch(/\.md[)"#]/);
    expect(serialized).not.toMatch(/\/docs\/images\//);
  });
});

describe("prepared output", () => {
  it("writes the index next to the content, only when the content changes", () => {
    const repo = standard(alphaWith("Text."));
    const result = loadDocsContent({ landingRoot: repo.landingRoot });
    const written = writePreparedDocs({ landingRoot: repo.landingRoot, ...result });
    expect(written.searchFile).toBe(join(repo.landingRoot, "generated", "docs-search.json"));
    expect(readFileSync(written.searchFile, "utf8")).toBe(serializeSearchIndex(buildSearchIndex(result.content)));
    const before = statSync(written.searchFile).mtimeMs;
    writePreparedDocs({ landingRoot: repo.landingRoot, ...result });
    expect(statSync(written.searchFile).mtimeMs).toBe(before);
    expect(existsSync(join(repo.landingRoot, "public", "docs", "docs-search.json"))).toBe(false);
  });
});
