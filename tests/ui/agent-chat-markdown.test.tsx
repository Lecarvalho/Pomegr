import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeMarkdown as AgentChatMarkdown, parseBlocks } from "../../app/components/markdown/SafeMarkdown";

const html = (text: string) => render(<AgentChatMarkdown text={text} />).container.firstElementChild as HTMLElement;

describe("AgentChatMarkdown", () => {
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
