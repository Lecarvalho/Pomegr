// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsSearchIndex } from "../../scripts/docs-search.mjs";

// The documentation search (WEB-03): the matching rules over the real generated index, and the
// accessible search box in the sidebar. The index comes from the real prepared content, so a newly
// published page is covered automatically.

const mocks = vi.hoisted(() => ({ pathname: "/docs/get-started/introduction" }));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, usePathname: () => mocks.pathname };
});

import rawIndex from "../../generated/docs-search.json";
import { DocsNav } from "../../app/docs/DocsNav";
import { DocsSearch } from "../../app/docs/DocsSearch";
import { docsContent } from "../../app/docs/content";
import { MAX_HEADINGS_PER_RESULT, MAX_RESULTS, isSearchable, searchDocs, words } from "../../app/docs/search";

const index = rawIndex as unknown as DocsSearchIndex;
const pages = index.pages;
const byRoute = new Map(pages.map((page) => [page.route, page]));

afterEach(cleanup);
beforeEach(() => {
  mocks.pathname = "/docs/get-started/introduction";
});

describe("matching", () => {
  const find = (query: string) => searchDocs(index, query);
  const routes = (query: string) => find(query).results.map((result) => result.page.route);

  it("splits text into lowercase words, folding accents and ignoring punctuation", () => {
    expect(words("Cache reuse, five-hour Usage_Limits (v0.5)!")).toEqual(["cache", "reuse", "five", "hour", "usage", "limits", "v0", "5"]);
    expect(words("Résumé CAFÉ")).toEqual(["resume", "cafe"]);
    expect(words("  --  ")).toEqual([]);
  });

  it("finds a page by any of its second-level or deeper headings, listing that heading", () => {
    let checked = 0;
    for (const page of pages) {
      for (const heading of page.headings) {
        const { results } = find(heading.text);
        const hit = results.find((result) => result.page.route === page.route);
        expect(hit, `${page.route} "${heading.text}"`).toBeDefined();
        expect(hit!.headings.map((entry) => entry.id), `${page.route} "${heading.text}"`).toContain(heading.id);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("finds a page by its title and ranks the title match first", () => {
    for (const page of pages) expect(routes(page.title)[0], page.title).toBe(page.route);
  });

  it("matches the start of words, in any case, and every typed word must match", () => {
    expect(routes("reus")).toContain("/docs/concepts/cache-reuse");
    expect(routes("CACHE")).toEqual(routes("cache"));
    expect(routes("cache   reuse")).toEqual(routes("cache reuse"));
    expect(routes("reuse cache")).toEqual(expect.arrayContaining(routes("cache reuse")));
    expect(find("cache zzzzqqqq").total).toBe(0);
    expect(find("zzzzqqqq").results).toEqual([]);
    // A fragment inside a word is not a match; only the start of a word is.
    expect(find("ache").results.every((result) => words(`${result.page.title} ${result.page.description} ${result.page.headings.map((heading) => heading.text).join(" ")} ${result.page.text}`).some((word) => word.startsWith("ache")))).toBe(true);
  });

  it("ranks a matching title above a heading, a heading above the description, and the description above the body", () => {
    const ranked = find("cache reuse").results;
    expect(ranked[0].page.route).toBe("/docs/concepts/cache-reuse");
    expect(ranked.map((result) => result.score)).toEqual([...ranked.map((result) => result.score)].sort((a, b) => b - a));
  });

  it("matches nothing for an empty query or one without letters or digits", () => {
    for (const query of ["", "   ", "--", "?!", "—"]) expect(find(query), JSON.stringify(query)).toEqual({ total: 0, results: [] });
  });

  it("bounds the results and headings per result while reporting the real total", () => {
    const broad = find("the");
    expect(broad.total).toBeGreaterThan(MAX_RESULTS);
    expect(broad.results).toHaveLength(MAX_RESULTS);
    for (const result of broad.results) expect(result.headings.length).toBeLessThanOrEqual(MAX_HEADINGS_PER_RESULT);
  });

  describe("one-character words", () => {
    const entry = (route: string, title: string, headings: string[], text = "") => ({
      route,
      group: "Concepts",
      title,
      description: "",
      headings: headings.map((heading, position) => ({ id: `section-${position}`, text: heading })),
      text,
    });
    const synthetic: DocsSearchIndex = {
      schema: 1,
      revision: "0".repeat(64),
      pages: [
        entry("/docs/concepts/first", "Context", ["Spot a compaction", "About caches"], "Spot the compaction marker."),
        entry("/docs/concepts/second", "Usage", ["Limits"], "An unrelated page with spot and compaction words."),
        entry("/docs/concepts/third", "Plans", ["Zoning"], "A page about nothing relevant."),
      ],
    };
    const outcome = (query: string) => searchDocs(synthetic, query);
    const summary = (query: string) => outcome(query).results.map((result) => [result.page.route, result.headings.map((heading) => heading.text)]);

    it("does not match a lone letter as a prefix, so an article neither widens nor narrows a match", () => {
      // Pages that hold "spot" and "compaction" but no word starting with "a" still match.
      expect(summary("spot a compaction").map(([route]) => route)).toEqual(["/docs/concepts/first", "/docs/concepts/second"]);
      expect(summary("spot a compaction")).toEqual(summary("spot compaction"));
    });

    it("lists only the headings that hold a real query word, never one matched by the lone letter", () => {
      expect(summary("spot a compaction")[0]).toEqual(["/docs/concepts/first", ["Spot a compaction"]]);
      expect(summary("spot a compaction").flatMap(([, headings]) => headings)).not.toContain("About caches");
    });

    it("keeps typing a heading word for word ranking it first", () => {
      expect(outcome("spot a compaction").results[0].page.route).toBe("/docs/concepts/first");
      expect(outcome("spot a compaction").results[0].score).toBeGreaterThan(outcome("spot compaction").results[0].score);
    });

    it("reports whether a query holds a word long enough to match, so the field can ask for more letters", () => {
      for (const query of ["a", "a b", "A  i", "5", "--", "?!", "a-b-c"]) expect(isSearchable(query), JSON.stringify(query)).toBe(false);
      for (const query of ["ab", "a ca", "spot a compaction", "5m", "v0.5"]) expect(isSearchable(query), JSON.stringify(query)).toBe(true);
    });

    it("matches nothing when every word is one character", () => {
      for (const query of ["a", "a b", "A  i", "5", "a-b-c"]) expect(outcome(query), JSON.stringify(query)).toEqual({ total: 0, results: [] });
      expect(find("a")).toEqual({ total: 0, results: [] });
    });

    it("still matches two-character words and ignores a lone letter beside them", () => {
      expect(summary("ab").length + summary("ca").length).toBeGreaterThan(0);
      expect(summary("a ca")).toEqual(summary("ca"));
    });
  });

  it("only ever returns published pages, whatever the query", () => {
    for (const query of ["docs/internal", "plans", "mockups", "../secret", "%2e%2e", "<script>", "api state"]) {
      for (const result of find(query).results) expect(byRoute.has(result.page.route), query).toBe(true);
    }
    expect(find("docs internal plans mockups").total).toBe(0);
  });

  it("keeps headings in document order within a result", () => {
    const { results } = find("the");
    for (const result of results) {
      const positions = result.headings.map((heading) => result.page.headings.findIndex((candidate) => candidate.id === heading.id));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

describe("the search box", () => {
  const user = () => userEvent.setup();
  const pageList = <p>PAGE LIST</p>;
  const harness = (props: { onNavigate?: () => void; onEscape?: () => void } = {}) => (
    // jsdom cannot navigate, so the harness swallows link activation after the component has handled it.
    <div onClick={(event) => event.preventDefault()} onKeyDown={props.onEscape ? (event) => event.key === "Escape" && props.onEscape?.() : undefined}>
      <DocsSearch onNavigate={props.onNavigate}>{pageList}</DocsSearch>
    </div>
  );
  const box = () => screen.getByRole("searchbox", { name: "Search documentation" });
  const sample = pages.find((page) => page.route === "/docs/concepts/cache-reuse")!;
  const sampleHeading = sample.headings[0];

  it("renders a labelled search field in a search landmark, with an empty polite status region and the page list", () => {
    render(harness());
    const landmark = screen.getByRole("search");
    expect(within(landmark).getByRole("searchbox", { name: "Search documentation" })).toBe(box());
    expect(box().getAttribute("type")).toBe("search");
    expect(document.querySelector("label[for=docs-search-input]")?.textContent).toBe("Search documentation");
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    expect(box().getAttribute("aria-describedby")).toBe(status.id);
    expect(screen.getByText("PAGE LIST")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("server-renders the same field without results, so it works before the script loads", () => {
    const html = renderToStaticMarkup(harness());
    expect(html).toContain('<form role="search">');
    expect(html).toMatch(/<label class="[^"]*" for="docs-search-input">Search documentation<\/label>/);
    expect(html).toContain('type="search"');
    expect(html).toContain('role="status"');
    expect(html).toContain("PAGE LIST");
    expect(html).not.toContain("Search results");
  });

  it("lists matching pages with their group, title, and heading anchor links, replacing the page list", async () => {
    render(harness());
    await user().type(box(), sampleHeading.text);

    const list = await screen.findByRole("list", { name: "Search results" });
    expect(screen.queryByText("PAGE LIST")).toBeNull();
    const item = within(list).getByRole("link", { name: sample.title }).closest("li")!;
    expect(within(item).getByRole("link", { name: sample.title }).getAttribute("href")).toBe(sample.route);
    expect(item.textContent).toContain(sample.group);
    const sections = within(item).getByRole("list", { name: `Matching sections in ${sample.title}` });
    const headingLink = within(sections).getByRole("link", { name: sampleHeading.text });
    expect(headingLink.getAttribute("href")).toBe(`${sample.route}#${sampleHeading.id}`);

    // Every result link points at a published page, optionally at one of its real headings.
    for (const link of within(list).getAllByRole("link")) {
      const [route, id] = link.getAttribute("href")!.split("#");
      expect(byRoute.has(route), route).toBe(true);
      if (id) expect(docsContent.pages.find((page) => page.route === route)!.headings.some((heading) => heading.id === id), `${route}#${id}`).toBe(true);
    }
  });

  it("announces the number of matching pages, and that nothing matched, in the live region", async () => {
    render(harness());
    const typing = user();
    await typing.type(box(), "zzzzqqqq");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No pages match “zzzzqqqq”."));
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(screen.getByText("PAGE LIST")).toBeTruthy();

    await typing.clear(box());
    await typing.type(box(), sample.title);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^\d+ pages? match(?:es)?$/));
    const total = searchDocs(index, sample.title).total;
    expect(screen.getByRole("status").textContent).toBe(total === 1 ? "1 page matches" : `${total} pages match`);
    expect(screen.getByRole("status")).toBe(document.getElementById("docs-search-status"));

    await typing.clear(box());
    await typing.type(box(), "the");
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Showing the best 8 of \d+ pages\.$/));
    expect(within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link").length).toBeGreaterThan(MAX_RESULTS - 1);

    // A single letter is not matched as a prefix: the field asks for more and keeps the page list.
    await typing.clear(box());
    await typing.type(box(), "a");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Type at least 2 letters."));
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(screen.getByText("PAGE LIST")).toBeTruthy();
    await typing.type(box(), "{Backspace}--");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Type at least 2 letters."));
    await typing.clear(box());
    await typing.type(box(), "a zzzzqqqq");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No pages match “a zzzzqqqq”."));
  });

  it("clears with Escape, restores the page list, keeps focus in the field, and does not bubble", async () => {
    const onEscape = vi.fn();
    render(harness({ onEscape }));
    const typing = user();
    await typing.type(box(), "cache");
    await screen.findByRole("list", { name: "Search results" });

    await typing.keyboard("{Escape}");
    expect((box() as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(box());
    expect(screen.getByText("PAGE LIST")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(onEscape).not.toHaveBeenCalled();

    // With nothing to clear, Escape belongs to whatever surrounds the search, such as the phone menu.
    await typing.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("clears with Escape from a result link and returns focus to the field", async () => {
    render(harness());
    const typing = user();
    await typing.type(box(), "cache");
    const first = (await screen.findAllByRole("link"))[0];
    first.focus();
    await typing.keyboard("{Escape}");
    expect((box() as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(box());
  });

  it("walks the field and every result with Tab, and with ArrowDown and ArrowUp", async () => {
    render(harness());
    const typing = user();
    await typing.type(box(), "cache");
    const list = await screen.findByRole("list", { name: "Search results" });
    const links = within(list).getAllByRole("link");
    expect(links.length).toBeGreaterThan(2);

    await typing.tab();
    expect(document.activeElement).toBe(links[0]);
    await typing.tab();
    expect(document.activeElement).toBe(links[1]);

    box().focus();
    await typing.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[0]);
    await typing.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[1]);
    await typing.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(links[0]);
    await typing.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(box());

    links[links.length - 1].focus();
    await typing.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[links.length - 1]);
  });

  it("opens the first result on Enter, then clears the search and tells the menu", async () => {
    const onNavigate = vi.fn();
    render(harness({ onNavigate }));
    const typing = user();
    await typing.type(box(), sample.title);
    const first = (await screen.findAllByRole("link"))[0];
    const href = first.getAttribute("href");
    const clicked = vi.fn();
    first.addEventListener("click", clicked);
    await typing.keyboard("{Enter}");
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(href).toBe(sample.route);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect((box() as HTMLInputElement).value).toBe("");
    expect(screen.getByText("PAGE LIST")).toBeTruthy();
  });

  it("does nothing on Enter without results", async () => {
    const onNavigate = vi.fn();
    render(harness({ onNavigate }));
    const typing = user();
    await typing.type(box(), "zzzzqqqq{Enter}");
    expect(onNavigate).not.toHaveBeenCalled();
    expect((box() as HTMLInputElement).value).toBe("zzzzqqqq");
  });

  it("bounds the query the field accepts", () => {
    render(harness());
    expect(box().getAttribute("maxlength")).toBe("100");
  });

  it("keeps the page list and says so when the index cannot be loaded, then retries on the next focus", async () => {
    vi.resetModules();
    let broken = true;
    vi.doMock("../../generated/docs-search.json", () => {
      if (broken) throw new Error("offline");
      return { default: rawIndex };
    });
    const { DocsSearch: Fresh } = await import("../../app/docs/DocsSearch");
    render(<Fresh>{pageList}</Fresh>);
    const typing = userEvent.setup();
    await typing.type(screen.getByRole("searchbox", { name: "Search documentation" }), "cache");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Search is unavailable right now. Use the page list instead."));
    expect(screen.getByText("PAGE LIST")).toBeTruthy();

    broken = false;
    await typing.clear(screen.getByRole("searchbox"));
    await typing.type(screen.getByRole("searchbox"), "cache");
    await screen.findByRole("list", { name: "Search results" });
    vi.doUnmock("../../generated/docs-search.json");
    vi.resetModules();
  });
});

describe("the search box in the documentation navigation", () => {
  const renderNav = () =>
    render(
      <div onClick={(event) => event.preventDefault()}>
        <DocsNav navigation={docsContent.navigation} contentId="docs-content" />
        <main id="docs-content" tabIndex={-1}>Content</main>
      </div>,
    );
  const toggle = () => screen.getByRole("button", { name: "Documentation menu" });
  const box = () => screen.getByRole("searchbox", { name: "Search documentation" });

  it("sits first in the sidebar panel, before the page groups, so the phone menu holds it too", () => {
    const html = renderToStaticMarkup(<DocsNav navigation={docsContent.navigation} contentId="docs-content" />);
    const panel = html.slice(html.indexOf('<div id="docs-nav-panel"'));
    expect(panel.indexOf("role=\"search\"")).toBeGreaterThan(0);
    expect(panel.indexOf('role="search"')).toBeLessThan(panel.indexOf("docs-nav-group-get-started"));
    expect(html.indexOf("Documentation menu")).toBeLessThan(html.indexOf('role="search"'));
  });

  it("replaces the page list by results and restores it when the query is cleared", async () => {
    renderNav();
    const typing = userEvent.setup();
    expect(screen.getByText("Get started")).toBeTruthy();
    await typing.type(box(), "usage limits");
    await screen.findByRole("list", { name: "Search results" });
    expect(screen.queryByText("Get started", { selector: "p" })).toBeNull();
    expect(screen.getAllByRole("navigation", { name: "Documentation" })).toHaveLength(1);
    await typing.keyboard("{Escape}");
    expect(screen.getByText("Get started", { selector: "p" })).toBeTruthy();
  });

  it("clears the search on the first Escape and closes the phone menu on the second", async () => {
    renderNav();
    const typing = userEvent.setup();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await typing.type(box(), "cache");
    await screen.findByRole("list", { name: "Search results" });

    await typing.keyboard("{Escape}");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect((box() as HTMLInputElement).value).toBe("");

    await typing.keyboard("{Escape}");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("closes the phone menu and moves focus to the page when a result is chosen", async () => {
    renderNav();
    const typing = userEvent.setup();
    fireEvent.click(toggle());
    await typing.type(box(), "install");
    const list = await screen.findByRole("list", { name: "Search results" });
    const link = within(list).getAllByRole("link")[0];
    link.focus();
    await typing.click(link);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(document.getElementById("docs-content"));
    expect((box() as HTMLInputElement).value).toBe("");
  });

  it("moves focus to the page after choosing a result on the always-visible desktop sidebar", async () => {
    renderNav();
    const typing = userEvent.setup();
    await typing.type(box(), "install");
    const link = within(await screen.findByRole("list", { name: "Search results" })).getAllByRole("link")[0];
    await typing.click(link);
    expect(document.activeElement).toBe(document.getElementById("docs-content"));
  });
});
