import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafeMarkdown as AgentChatMarkdown } from "../../app/components/markdown/SafeMarkdown";
import { TaskReportNote } from "../../app/components/tasks/TaskReportNote";
import { AgentChatSection } from "../../app/components/design-system/DesignSystemAgentChatSample";

const html = (text: string) => render(<AgentChatMarkdown text={text} />).container.firstElementChild as HTMLElement;

describe("AgentChatMarkdown", () => {
  it("shows GFM elements in the agent chat samples", () => {
    const { container } = render(<AgentChatSection />);
    for (const selector of ["table thead th", "table tbody td code", "blockquote", "hr", "ul ul", "em", "del", ".agentChatTaskGlyph"]) {
      expect(container.querySelector(`.agentChatMarkdown ${selector}`)).not.toBeNull();
    }
    expect(container.querySelector(".agentChatMarkdown input")).toBeNull();
    expect(container.querySelector(".agentChatTableScroll")).toHaveAttribute("tabindex", "0");
  });
  it("renders the owner's proof table inside a scroll wrapper", () => {
    const root = html("| Proof | Result |\n|---|---|\n| `npm test` | Pass: 4,011 Node, 2,418 UI; four skips |\n| `npm run lint` | Pass: 55 warnings, zero errors |");
    expect(root.querySelectorAll("table")).toHaveLength(1);
    expect(root.querySelectorAll("thead th")).toHaveLength(2);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelectorAll("td code")).toHaveLength(2);
    expect(root.querySelector("table")?.parentElement).toHaveClass("agentChatTableScroll");
    expect(root.textContent).not.toContain("|");
  });

  it("renders GFM blocks and inline formatting with non-interactive task glyphs", () => {
    const root = html("> Quoted *emphasis*\n\n---\n\n- Parent\n  - Child\n\n- [x] Finished\n- [ ] Pending\n\n~~Removed~~ and \\*literal star\\* and snake_case_name");
    expect(root.querySelector("blockquote em")).toHaveTextContent("emphasis");
    expect(root.querySelectorAll("hr")).toHaveLength(1);
    expect(root.querySelector("ul ul li")).toHaveTextContent("Child");
    expect(root.querySelector('[aria-label="Checked"]')).toHaveTextContent("☑");
    expect(root.querySelector('[aria-label="Unchecked"]')).toHaveTextContent("☐");
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("del")).toHaveTextContent("Removed");
    expect(root.textContent).toContain("*literal star* and snake_case_name");
    expect(root.querySelectorAll("em")).toHaveLength(1);
  });

  it("keeps footnotes and reference images literal without generated links", () => {
    const root = html("Note[^1]\n\n[^1]: Footnote\n\n![pixel][image]\n\n[image]: https://example.test/p.png");
    expect(root.textContent).toContain("Note[^1]");
    expect(root.textContent).toContain("[^1]: Footnote");
    expect(root.textContent).toContain("![pixel][image]");
    expect(root.querySelector("a, img, sup, section")).toBeNull();
  });

  it.each([undefined, vi.fn()])("keeps reference links and their destinations literal", (onOpenLink) => {
    const { container } = render(<AgentChatMarkdown text={"[label][id]\n\n[id]: https://example.test/"} onOpenLink={onOpenLink} />);
    expect(container.textContent).toContain("[label][id]");
    expect(container.textContent).toContain("[id]: https://example.test/");
    expect(container.querySelector("a")).toBeNull();
  });

  it("uses the same GFM renderer in task report notes", () => {
    const { container } = render(<TaskReportNote report={{ at: "2026-10-08T12:00:00.000Z", blockReason: null, attention: "*Review* `RETRY_LIMIT`\n\n| Check | Result |\n|---|---|\n| Tests | Pass |" }} />);
    expect(container.querySelector(".taskReportNotice em")).toHaveTextContent("Review");
    expect(container.querySelector(".taskReportNotice code")).toHaveTextContent("RETRY_LIMIT");
    expect(container.querySelectorAll(".taskReportNotice table")).toHaveLength(1);
    expect(container.querySelector("p div, p table")).toBeNull();
  });

  it("opts into HTTPS links, preserves label formatting, and prevents navigation", () => {
    const onOpenLink = vi.fn();
    const url = "https://github.com/o/r/pull/927";
    const { container } = render(<AgentChatMarkdown text={`[PR #927](${url})`} onOpenLink={onOpenLink} />);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", url);
    expect(links[0]).toHaveAttribute("title", url);
    expect(links[0]).toHaveClass("safeMarkdownLink");
    expect(links[0]).toHaveTextContent("PR #927");
    expect(links[0]).not.toHaveAttribute("target");
    const location = window.location.href;
    expect(fireEvent.click(links[0])).toBe(false);
    expect(window.location.href).toBe(location);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url);
    const formatted = render(<AgentChatMarkdown text="[**Review** the `diff`](https://a.test)" onOpenLink={onOpenLink} />).container;
    expect(formatted.querySelector("a strong")).toHaveTextContent("Review");
    expect(formatted.querySelector("a code")).toHaveTextContent("diff");
    expect(formatted.querySelector("a")).toHaveAttribute("href", "https://a.test/");
  });

  it.each([
    "[x](javascript:alert(1))", "[x](http://a.test)", "[x](file:///c:/x)", "[x](data:text/plain,x)",
    "[x](/relative)", "[x](https://user:password@a.test/)", "[x](https://a.test:bad/)",
    "![p](https://a.test/p.png)", "https://a.test/", '<a href="https://a.test/">x</a>',
    "[](https://a.test/)", "[two\nlines](https://a.test/)", `[x](https://a.test/${"x".repeat(2048)})`,
  ])("keeps unsupported input literal even with link opt-in: %s", (text) => {
    const { container } = render(<AgentChatMarkdown text={text} onOpenLink={vi.fn()} />);
    expect(container.querySelector("a, img")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("keeps links literal by default and inside code", () => {
    const text = "[PR #927](https://github.com/o/r/pull/927)";
    expect(html(text).querySelector("a")).toBeNull();
    const { container } = render(<AgentChatMarkdown text={`\`${text}\`\n\n\`\`\`\n${text}\n\`\`\``} onOpenLink={vi.fn()} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("uses the existing text-link color and focus tokens", () => {
    const styles = readFileSync(join(process.cwd(), "app/styles/agent-chat.css"), "utf8");
    expect(styles).toMatch(/\.safeMarkdownLink\s*\{[^}]*color:\s*var\(--command-brand-text\)/);
    expect(styles).toMatch(/\.safeMarkdownLink:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
  });

  it("renders paragraphs separated by blank lines, and keeps a line break inside one", () => {
    const root = html("First line\nsecond line\n\nNext paragraph");
    const paragraphs = root.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("First line\nsecond line");
    expect(paragraphs[1]).toHaveTextContent("Next paragraph");
  });

  it("renders bullet, star and numbered lists, and starts a numbered list where the text did", () => {
    const root = html("- one\n- two\n\n* star\n\n3. three\n4. four");
    const lists = root.querySelectorAll("ul, ol");
    expect([...lists].map((list) => list.tagName)).toEqual(["UL", "UL", "OL"]);
    expect([...lists[0].children].map((item) => item.textContent)).toEqual(["one", "two"]);
    expect(lists[1]).toHaveTextContent("star");
    expect(lists[2]).toHaveAttribute("start", "3");
    expect(lists[2].children).toHaveLength(2);
  });

  it("renders bold and inline code, and leaves a marker that never closes as the text it was", () => {
    const root = html("Use **bold** and `code` here, then **open");
    expect(root.querySelector("strong")).toHaveTextContent("bold");
    expect(root.querySelector("code.agentChatInlineCode")).toHaveTextContent("code");
    expect(root.textContent).toBe("Use bold and code here, then **open");
    expect(html("**the `flag` option**").querySelector("strong code")).toHaveTextContent("flag");
  });

  it("renders a fenced block as one code element, including a fence that is still open", () => {
    const closed = html("Before\n\n```ts\nconst a = `x`;\n**not bold**\n```\n\nAfter");
    expect(closed.querySelector("pre.agentChatCode code")?.textContent).toBe("const a = `x`;\n**not bold**\n");
    expect(closed.querySelector("pre strong")).toBeNull();
    expect(closed.querySelectorAll("p")).toHaveLength(2);
    // The answer is still being written: the open fence holds the rest of the text.
    expect(html("```\nstill writing").querySelector("pre code")?.textContent).toBe("still writing\n");
  });

  it("renders a # heading as a line of its own, and not as a heading element", () => {
    const root = html("## Plan\nbody text");
    expect(root.querySelector(".agentChatMdHeading")).toHaveTextContent("Plan");
    expect(root.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(root.textContent).not.toContain("#");
    expect([...html("# One\n\n- item").children].map((block) => block.tagName)).toEqual(["P", "UL"]);
  });

  it("shows HTML, links and images as literal text and builds none of them", () => {
    const hostile = [
      "<img src=x onerror=alert(1)>",
      "[click](javascript:alert(1))",
      "![pixel](https://example.test/p.png)",
      "<script>alert(1)</script>",
      "<a href=\"javascript:alert(1)\">go</a>",
      "<iframe src=\"https://example.test\"></iframe>",
      "https://example.test/auto",
      "- <b onclick=alert(1)>item</b>",
      "```\n<img src=x onerror=alert(1)>\n```",
      "**<img src=x onerror=alert(1)>**",
    ].join("\n\n");
    const root = html(hostile);
    expect(root.querySelector("img, a, script, iframe, input, b, svg, object, embed, form, style")).toBeNull();
    expect(root.querySelector("[onerror], [onclick], [href], [src]")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.textContent).toContain("[click](javascript:alert(1))");
    expect(root.textContent).toContain("![pixel](https://example.test/p.png)");
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("https://example.test/auto");
    // Nothing the text said became an element: only the renderer's own tags exist.
    const tags = new Set([...root.querySelectorAll("*")].map((element) => element.tagName.toLowerCase()));
    expect([...tags].filter((tag) => !["p", "ul", "ol", "li", "pre", "code", "strong", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "hr", "em", "del", "span", "div"].includes(tag))).toEqual([]);
    expect([...root.querySelectorAll("*")].flatMap((element) => [...element.attributes].filter((attribute) => /^on/i.test(attribute.name)))).toEqual([]);
  });

  it("never sets markup from a string", () => {
    const source = readFileSync(join(process.cwd(), "app", "components", "markdown", "SafeMarkdown.tsx"), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|createContextualFragment|DOMParser/);
  });

  it("renders nothing for empty text and survives a long answer", () => {
    expect(html("").children).toHaveLength(0);
    const long = Array.from({ length: 800 }, (_, index) => `Line ${index} with **bold** and \`code\``).join("\n");
    expect(html(long).querySelectorAll("strong")).toHaveLength(800);
  });
});
