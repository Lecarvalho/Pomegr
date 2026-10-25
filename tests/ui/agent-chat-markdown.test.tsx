import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafeMarkdown as AgentChatMarkdown, parseBlocks } from "../../app/components/markdown/SafeMarkdown";

const html = (text: string) => render(<AgentChatMarkdown text={text} />).container.firstElementChild as HTMLElement;

describe("AgentChatMarkdown", () => {
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
    expect(closed.querySelector("pre.agentChatCode code")?.textContent).toBe("const a = `x`;\n**not bold**");
    expect(closed.querySelector("pre strong")).toBeNull();
    expect(closed.querySelectorAll("p")).toHaveLength(2);
    // The answer is still being written: the open fence holds the rest of the text.
    expect(html("```\nstill writing").querySelector("pre code")?.textContent).toBe("still writing");
  });

  it("renders a # heading as a line of its own, and not as a heading element", () => {
    const root = html("## Plan\nbody text");
    expect(root.querySelector(".agentChatMdHeading")).toHaveTextContent("Plan");
    expect(root.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(root.textContent).not.toContain("#");
    expect(parseBlocks("# One\n\n- item").map((block) => block.kind)).toEqual(["heading", "list"]);
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
    expect(root.querySelector("img, a, script, iframe, b, svg, object, embed, form, style")).toBeNull();
    expect(root.querySelector("[onerror], [onclick], [href], [src]")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.textContent).toContain("[click](javascript:alert(1))");
    expect(root.textContent).toContain("![pixel](https://example.test/p.png)");
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("https://example.test/auto");
    // Nothing the text said became an element: only the renderer's own tags exist.
    const tags = new Set([...root.querySelectorAll("*")].map((element) => element.tagName.toLowerCase()));
    expect([...tags].filter((tag) => !["p", "ul", "ol", "li", "pre", "code", "strong"].includes(tag))).toEqual([]);
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
