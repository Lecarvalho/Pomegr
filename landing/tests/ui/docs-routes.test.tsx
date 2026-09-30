// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsContent, DocsPage } from "../../scripts/docs-content.mjs";

// Every route, the layout, and the Worker allowlist for the public documentation (WEB-02). The
// pages come from the real generated content, so a new published page is covered automatically.

const mocks = vi.hoisted(() => ({ pathname: "/docs/get-started/introduction", handler: vi.fn() }));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, usePathname: () => mocks.pathname };
});
vi.mock("vinext/server/app-router-entry", () => ({ default: { fetch: mocks.handler } }));

import DocsEntryPage from "../../app/docs/page";
import DocsLayout from "../../app/docs/layout";
import DocsNotFound from "../../app/docs/not-found";
import DocsPageRoute, { dynamicParams, generateMetadata, generateStaticParams } from "../../app/docs/[...slug]/page";
import { DocsNav } from "../../app/docs/DocsNav";
import { docsContent, findDocsPage, slugOf } from "../../app/docs/content";
import worker from "../../worker/index";

afterEach(cleanup);
beforeEach(() => {
  mocks.pathname = "/docs/get-started/introduction";
  mocks.handler.mockReset();
});

const content: DocsContent = docsContent;
const pages = content.pages;
const byRoute = new Map(pages.map((page) => [page.route, page]));

const routeProps = (slug: string[] | undefined) => ({ params: Promise.resolve({ slug }) });
const pageMarkup = async (page: DocsPage) => renderToStaticMarkup(await DocsPageRoute(routeProps(slugOf(page.route))));
const layoutMarkup = async (page: DocsPage) => {
  mocks.pathname = page.route;
  return renderToStaticMarkup(<DocsLayout>{await DocsPageRoute(routeProps(slugOf(page.route)))}</DocsLayout>);
};
const count = (html: string, needle: string) => html.split(needle).length - 1;
const idsOf = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const linksIn = (html: string) => [...html.matchAll(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({ tag: match[0], href: match[1], text: decode(match[2].replace(/<[^>]+>/g, "")) }));
const between = (html: string, open: RegExp, close: string) => {
  const start = html.search(open);
  expect(start, `${open} is missing`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf(close, start) + close.length);
};
const digestOf = async (promise: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? "");
  }
  return "";
};

describe("routes", () => {
  it("publishes all 17 manifest pages through one dynamic route, with no page per Markdown file", () => {
    expect(pages).toHaveLength(17);
    expect(dynamicParams).toBe(false);
    const params = generateStaticParams();
    expect(params).toHaveLength(17);
    expect(params.map((entry) => `/docs/${entry.slug.join("/")}`)).toEqual(pages.map((page) => page.route));
    expect(new Set(params.map((entry) => entry.slug.join("/"))).size).toBe(17);

    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(directory, entry.name)).map((child) => `${entry.name}/${child}`) : [entry.name],
      );
    const files = walk(join(dirname(fileURLToPath(import.meta.url)), "../../app/docs"));
    expect(files.filter((file) => /(^|\/)(page|layout|route|not-found)\.[jt]sx?$/.test(file)).sort()).toEqual([
      "[...slug]/page.tsx",
      "layout.tsx",
      "not-found.tsx",
      "page.tsx",
    ]);
  });

  it.each(pages.map((page) => [page.route, page] as const))("renders %s with its article, title, and metadata", async (_route, page) => {
    const html = await pageMarkup(page);
    expect(count(html, "<article")).toBe(1);
    expect(count(html, "<h1 ")).toBe(1);
    expect(html).toContain(`<h1 id="${page.headings[0].id}">${page.title.replace(/&/g, "&amp;")}</h1>`);
    expect(await generateMetadata(routeProps(slugOf(page.route)))).toEqual({
      title: page.title,
      description: page.description,
      alternates: { canonical: page.route },
    });
  });

  it("finds a page only by its exact manifest slug", () => {
    for (const page of pages) expect(findDocsPage(slugOf(page.route))).toBe(page);
    const unknown: Array<string[] | undefined> = [
      undefined,
      [],
      ["nope"],
      ["get-started"],
      ["get-started", "nope"],
      ["get-started", "introduction", "extra"],
      ["GET-STARTED", "introduction"],
      ["get-started/introduction"],
      ["get-started", "introduction/"],
      ["get-started", "introduction.md"],
      ["get-started", ""],
      ["get-started", ".."],
      ["images", "topic", "shot.jpg"],
    ];
    for (const slug of unknown) expect(findDocsPage(slug), JSON.stringify(slug)).toBeNull();
  });

  it("answers an unknown slug with the framework 404, never a page", async () => {
    for (const slug of [["nope"], ["concepts", "nope"], ["get-started"], ["concepts/cache-reuse"], ["images", "x", "y.jpg"], undefined]) {
      expect(await digestOf(DocsPageRoute(routeProps(slug))), JSON.stringify(slug)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404$/);
      expect(await generateMetadata(routeProps(slug)), JSON.stringify(slug)).toEqual({});
    }
  });

  it("redirects /docs to the manifest entry and has no content of its own", async () => {
    expect(content.entry).toBe(pages[0].route);
    expect(await digestOf(() => DocsEntryPage())).toBe(`NEXT_REDIRECT;replace;${content.entry};307;`);
  });

  it("renders the 404 message inside the docs frame with a way back", () => {
    mocks.pathname = "/docs/nope";
    const html = renderToStaticMarkup(<DocsLayout><DocsNotFound /></DocsLayout>);
    expect(html).toContain("This page is not in the documentation.");
    expect(html).toContain(`href="${content.entry}"`);
    expect(count(html, "<h1")).toBe(1);
    expect(html).not.toContain('aria-current="page" class=');
    expect(between(html, /<nav[^>]*aria-label="Documentation"/, "</nav>")).not.toContain("aria-current");
  });
});

describe("layout", () => {
  it("frames every page with a skip link, the site header and footer, navigation, and one main landmark", async () => {
    const page = pages[2];
    const html = await layoutMarkup(page);
    expect(count(html, "<main")).toBe(1);
    expect(html).toMatch(/<main id="docs-content" class="[^"]*" tabindex="-1">/);
    expect(html.indexOf('<a class="')).toBeLessThan(html.indexOf("<header"));
    expect(html).toMatch(/<a class="[^"]*" href="#docs-content">Skip to documentation content<\/a>/);
    expect(count(html, "<header")).toBe(1);
    expect(count(html, "<footer")).toBe(1);
    expect(html.indexOf("<header")).toBeLessThan(html.indexOf("<main"));
    expect(html.indexOf("</main>")).toBeLessThan(html.indexOf("<footer"));
    expect(count(html, "<h1 ")).toBe(1);
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('aria-label="Documentation"');
    expect(html).toContain('aria-label="Previous and next pages"');
    expect(html).toContain('aria-labelledby="docs-outline-label"');
    expect(html).toContain('aria-label="Legal and project links"');
  });

  it("marks Docs as the current section in the header and omits the redundant footer link", async () => {
    const html = await layoutMarkup(pages[0]);
    const header = between(html, /<header/, "</header>");
    expect(header).toContain('<a aria-current="page" href="/docs">Docs</a>');
    expect(count(header, 'aria-current="page"')).toBe(1);
    const footer = between(html, /<footer/, "</footer>");
    expect(footer).toContain('href="/about"');
    expect(footer).toContain('href="/"');
    expect(footer).not.toContain('href="/docs"');
  });

  it("keeps layout ids unique and unable to collide with any published heading slug", async () => {
    const layoutIds = new Set<string>();
    for (const page of pages) {
      const html = await layoutMarkup(page);
      const ids = idsOf(html);
      expect(new Set(ids).size, `${page.route} repeats an id`).toBe(ids.length);
      const headingIds = new Set(page.headings.map((heading) => heading.id));
      for (const id of ids) if (!headingIds.has(id)) layoutIds.add(id);
    }
    expect([...layoutIds].every((id) => id.startsWith("docs-"))).toBe(true);
    for (const page of pages) for (const heading of page.headings) expect(layoutIds.has(heading.id), `${page.route}#${heading.id}`).toBe(false);
    expect([...layoutIds]).toEqual(expect.arrayContaining(["docs-content", "docs-nav-panel", "docs-outline-label", "docs-nav-group-get-started"]));
  });
});

describe("sidebar", () => {
  const navMarkup = (path: string) => {
    mocks.pathname = path;
    return renderToStaticMarkup(<DocsNav navigation={content.navigation} contentId="docs-content" />);
  };

  it("lists the groups and pages in manifest order", () => {
    const html = navMarkup("/docs/get-started/introduction");
    const titles = [...html.matchAll(/<p id="docs-nav-group-([a-z-]+)"[^>]*>([^<]*)<\/p>/g)].map((match) => [match[1], match[2]]);
    expect(titles).toEqual(content.navigation.map((group) => [group.id, group.title]));
    expect(content.navigation.map((group) => group.id)).toEqual(["get-started", "using-pomegr", "concepts", "help"]);

    const links = linksIn(between(html, /<div id="docs-nav-panel"/, "</nav>"));
    expect(links.map((link) => link.href)).toEqual(pages.map((page) => page.route));
    expect(links.map((link) => link.text)).toEqual(pages.map((page) => page.title));
    for (const group of content.navigation) {
      expect(html).toContain(`<ul class="`);
      expect(html).toContain(`aria-labelledby="docs-nav-group-${group.id}"`);
    }
  });

  it("names the landmark and gives the phone button its state and target", () => {
    const html = navMarkup("/docs/get-started/introduction");
    expect(html).toMatch(/<nav class="[^"]*" aria-label="Documentation">/);
    expect(html).toMatch(/<button type="button" class="[^"]*" aria-expanded="false" aria-controls="docs-nav-panel"><span>Documentation menu<\/span>/);
    expect(html).toMatch(/<div id="docs-nav-panel" class="[^"]*" data-open="false">/);
  });

  it.each(pages.map((page) => [page.route] as const))("marks only %s as the current page", (route) => {
    const current = linksIn(navMarkup(route)).filter((link) => link.tag.includes('aria-current="page"'));
    expect(current.map((link) => link.href)).toEqual([route]);
  });

  it("marks nothing for the entry, unknown paths, or a path outside the docs, and ignores a trailing slash", () => {
    for (const path of ["/docs", "/docs/nope", "/docs/get-started", "/about", "/"]) {
      expect(navMarkup(path), path).not.toContain("aria-current");
    }
    expect(linksIn(navMarkup("/docs/concepts/cache-reuse/")).filter((link) => link.tag.includes("aria-current")).map((link) => link.href)).toEqual([
      "/docs/concepts/cache-reuse",
    ]);
  });
});

describe("outline and previous/next links", () => {
  it.each(pages.map((page) => [page.route, page] as const))("builds the outline and pager for %s from the generated data", async (_route, page) => {
    const html = await pageMarkup(page);
    const expectedOutline = page.headings.filter((heading) => heading.depth === 2 || heading.depth === 3);
    expect(expectedOutline.length).toBeGreaterThan(0);

    const rail = between(html, /<nav class="[^"]*" aria-labelledby="docs-outline-label"/, "</nav>");
    expect(rail).toContain('<p id="docs-outline-label"');
    expect(rail).toContain(">On this page</p>");
    const railLinks = linksIn(rail);
    expect(railLinks.map((link) => link.href)).toEqual(expectedOutline.map((heading) => `#${heading.id}`));
    expect(railLinks.map((link) => link.text)).toEqual(expectedOutline.map((heading) => heading.text));
    for (const link of railLinks) expect(html, link.href).toContain(` id="${link.href.slice(1)}"`);

    const compact = between(html, /<details/, "</details>");
    expect(compact).toContain("<summary>On this page</summary>");
    expect(linksIn(compact).map((link) => link.href)).toEqual(railLinks.map((link) => link.href));

    const pager = html.includes('aria-label="Previous and next pages"') ? between(html, /<nav class="[^"]*" aria-label="Previous and next pages"/, "</nav>") : "";
    const pagerLinks = linksIn(pager);
    const expected = [page.previous && { direction: "prev", link: page.previous }, page.next && { direction: "next", link: page.next }].filter(Boolean) as Array<{
      direction: string;
      link: { route: string; title: string };
    }>;
    expect(pagerLinks.map((link) => link.href)).toEqual(expected.map((entry) => entry.link.route));
    pagerLinks.forEach((link, index) => {
      expect(link.tag).toContain(`rel="${expected[index].direction}"`);
      expect(link.text).toContain(expected[index].link.title);
      expect(byRoute.has(link.href)).toBe(true);
    });
  });

  it("nests third-level headings under the second-level heading before them", async () => {
    const page = byRoute.get("/docs/using-pomegr/reporting-plugins")!;
    const rail = between(await pageMarkup(page), /<nav class="[^"]*" aria-labelledby="docs-outline-label"/, "</nav>");
    const install = page.headings.find((heading) => heading.text === "Install the plugin")!;
    const codex = page.headings.find((heading) => heading.text === "Codex")!;
    expect(rail).toMatch(new RegExp(`<li><a href="#${install.id}">Install the plugin</a><ul[^>]*><li><a href="#${codex.id}">Codex</a></li>`));
  });

  it("chains every page to the next one in reading order, with no previous on the first page or next on the last", () => {
    expect(pages[0].previous).toBeNull();
    expect(pages[pages.length - 1].next).toBeNull();
    pages.forEach((page, index) => {
      expect(page.next?.route ?? null).toBe(pages[index + 1]?.route ?? null);
      expect(page.previous?.route ?? null).toBe(pages[index - 1]?.route ?? null);
    });
  });
});

describe("phone navigation", () => {
  // jsdom cannot navigate, so the harness swallows link activation; the component's own handler still runs first.
  const harness = () => (
    <div onClick={(event) => event.preventDefault()}>
      <DocsNav navigation={content.navigation} contentId="docs-content" />
      <main id="docs-content" tabIndex={-1}>Content</main>
    </div>
  );
  const renderNav = () => render(harness());
  const toggle = () => screen.getByRole("button", { name: "Documentation menu" });

  it("opens and closes in place with a real button", () => {
    renderNav();
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(toggle().getAttribute("aria-controls")!)!;
    expect(panel.getAttribute("data-open")).toBe("false");

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("data-open")).toBe("true");

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel.getAttribute("data-open")).toBe("false");
  });

  it("closes on Escape and returns focus to the button", () => {
    renderNav();
    fireEvent.click(toggle());
    const first = screen.getAllByRole("link")[0];
    first.focus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("leaves Escape alone while the menu is closed", () => {
    renderNav();
    const first = screen.getAllByRole("link")[0];
    first.focus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(document.activeElement).toBe(first);
  });

  it("closes when a page is chosen and moves focus to the content instead of losing it", () => {
    renderNav();
    fireEvent.click(toggle());
    const link = screen.getByRole("link", { name: "Install Pomegr" });
    link.focus();
    fireEvent.click(link);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(document.getElementById("docs-content"));
  });

  it("does not move focus when a page is chosen from the always-visible desktop sidebar", () => {
    renderNav();
    const link = screen.getByRole("link", { name: "Install Pomegr" });
    link.focus();
    fireEvent.click(link);
    expect(document.activeElement).toBe(link);
  });

  it("closes by itself when the route changes", () => {
    const view = renderNav();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    mocks.pathname = "/docs/get-started/install";
    view.rerender(harness());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("link", { name: "Install Pomegr" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("Worker allowlist", () => {
  const call = async (path: string) => {
    mocks.handler.mockResolvedValue(new Response("app", { status: 200 }));
    const response = await worker.fetch(new Request(`https://pomegr.com${path}`), { ASSETS: { fetch: vi.fn() } }, { waitUntil: vi.fn(), passThroughOnException: vi.fn() });
    return { response, reached: mocks.handler.mock.calls.length > 0 };
  };

  it.each([
    "/docs",
    "/docs/",
    "/docs/concepts/cache-reuse",
    "/docs/concepts/x",
    "/docs/get-started/introduction",
    "/docs/images/install/installer.jpg",
    "/docs/a/b/c",
  ])("lets %s reach the application", async (path) => {
    const { response, reached } = await call(path);
    expect(reached, path).toBe(true);
    expect(response.status).toBe(200);
  });

  it.each(["/docsx", "/docs..", "/docs.", "/doc", "/Docs", "/DOCS/concepts", "/docs%2Fconcepts", "/docs%2F", "/documents/x", "/x/docs/concepts", "/docs/../dashboard", "/docs/%2e%2e/dashboard"])(
    "keeps %s out of the application with the Worker's own 404",
    async (path) => {
      const { response, reached } = await call(path);
      expect(reached, path).toBe(false);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    },
  );

  it("passes the application's own 404 for an unknown docs page straight through, hardened", async () => {
    mocks.handler.mockResolvedValue(new Response("application 404", { status: 404, headers: { "Content-Type": "text/html" } }));
    const response = await worker.fetch(new Request("https://pomegr.com/docs/concepts/nope"), { ASSETS: { fetch: vi.fn() } }, { waitUntil: vi.fn(), passThroughOnException: vi.fn() });
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("application 404");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("keeps the previous allowlist unchanged", async () => {
    for (const path of ["/", "/about", "/download", "/api/waitlist", "/robots.txt", "/fonts/rokkitt-variable.ttf", "/landing/x.png"]) {
      expect((await call(path)).reached, path).toBe(true);
      mocks.handler.mockReset();
    }
    for (const path of ["/dashboard", "/api/state", "/api/sessions", "/random", "/api"]) {
      expect((await call(path)).reached, path).toBe(false);
    }
  });
});
