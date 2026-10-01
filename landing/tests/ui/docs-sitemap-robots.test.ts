import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsSearchIndex } from "../../scripts/docs-search.mjs";

// The sitemap and robots.txt (WEB-03): application routes built from the same generated content
// revision as the pages and the search index, listing exactly the public pages.

const mocks = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("vinext/server/app-router-entry", () => ({ default: { fetch: mocks.handler } }));

import searchIndex from "../../generated/docs-search.json";
import { docsContent } from "../../app/docs/content";
import robots from "../../app/robots";
import { SITE_ORIGIN } from "../../app/site-origin";
import sitemap from "../../app/sitemap";
import worker from "../../worker/index";

const path = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../../docs/site.json", import.meta.url), "utf8")) as { groups: Array<{ pages: string[] }> };
const expectedDocsRoutes = manifest.groups.flatMap((group) => group.pages).map((source) => `/docs/${source.replace(/\.md$/, "")}`);

beforeEach(() => mocks.handler.mockReset());

describe("sitemap", () => {
  const entries = sitemap();
  const urls = entries.map((entry) => entry.url);

  it("lists the home, about, and download pages and every published documentation page, nothing else", () => {
    expect(SITE_ORIGIN).toBe("https://pomegr.com");
    expect(urls).toEqual(["/", "/about", "/download", ...expectedDocsRoutes].map((route) => `https://pomegr.com${route}`));
    expect(entries).toHaveLength(3 + expectedDocsRoutes.length);
  });

  it("uses absolute canonical URLs without duplicates, queries, fragments, or trailing slashes", () => {
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.origin, url).toBe(SITE_ORIGIN);
      expect(parsed.search + parsed.hash, url).toBe("");
      expect(url.endsWith("/") && parsed.pathname !== "/", url).toBe(false);
      expect(url).toBe(`${SITE_ORIGIN}${parsed.pathname}`);
    }
  });

  it("leaves out the /docs redirect, the image assets, the API, and every internal or unknown path", () => {
    expect(urls).not.toContain(`${SITE_ORIGIN}/docs`);
    expect(urls).not.toContain(`${SITE_ORIGIN}/docs/`);
    const joined = urls.join("\n");
    expect(joined).not.toMatch(/\/docs\/images\/|\/api\/|\/dashboard|internal|plans|mockups|\.md\b|\/_next\/|\/fonts\//i);
    expect(entries.every((entry) => Object.keys(entry).join() === "url")).toBe(true);
  });

  it("is built from the same content revision as the search index and the published pages", () => {
    const index = searchIndex as unknown as DocsSearchIndex;
    expect(index.revision).toBe(docsContent.revision);
    const docsUrls = urls.filter((url) => url.includes("/docs/"));
    expect(docsUrls).toEqual(docsContent.pages.map((page) => `${SITE_ORIGIN}${page.route}`));
    expect(docsUrls).toEqual(index.pages.map((page) => `${SITE_ORIGIN}${page.route}`));
  });

  it("names pages that exist in the application", () => {
    for (const file of ["app/page.tsx", "app/about/page.tsx", "app/download/page.tsx", "app/docs/[...slug]/page.tsx"]) expect(existsSync(path(file)), file).toBe(true);
  });

  it("uses the same canonical origin as the site metadata", () => {
    const layout = readFileSync(path("app/layout.tsx"), "utf8");
    expect(layout).toContain(`metadataBase: new URL("${SITE_ORIGIN}")`);
  });
});

describe("robots.txt", () => {
  const rules = robots();

  it("allows everything and points at the sitemap, naming no other path", () => {
    expect(rules).toEqual({ rules: { userAgent: "*", allow: "/" }, sitemap: `${SITE_ORIGIN}/sitemap.xml` });
  });

  it("reveals no internal, plan, mockup, API, or application path", () => {
    const text = JSON.stringify(rules);
    expect(text).not.toMatch(/disallow|internal|plans|mockups|dashboard|\/api\/|\.md\b|docs\/images/i);
    expect(Object.keys(rules.rules as object).sort()).toEqual(["allow", "userAgent"]);
  });
});

describe("Worker allowlist", () => {
  it.each(["/sitemap.xml", "/robots.txt"])("serves %s through the application", async (route) => {
    mocks.handler.mockResolvedValue(new Response("ok", { status: 200 }));
    const response = await worker.fetch(new Request(`https://pomegr.com${route}`), { ASSETS: { fetch: vi.fn() } }, { waitUntil: vi.fn(), passThroughOnException: vi.fn() });
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });
});
