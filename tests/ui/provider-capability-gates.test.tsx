import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MonitorState } from "../../shared/monitor-contract";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { MachineryPanel } from "../../app/components/dashboard/MachineryPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { claudeCapabilities, codexCapabilities, repositorySession } from "./dashboard-test-fixtures";

describe("provider capability gates", () => {
  it.each([
    ["Claude Code", claudeCapabilities, "claude:999b3d6b-24d5-4d66-93b1-38f502f5f811"],
    ["Codex", codexCapabilities, "codex:019ff0fa-1f93-7032-bc0d-ddec9cf3a7e4"],
  ] as const)("shows the local %s session ID without repeating the breadcrumb project", (source, capabilities, id) => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      id,
      project: "pomegr-observability-dashboard",
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source={source} capabilities={capabilities} historical={false} /></LiveClockProvider>);

    expect(screen.queryByText("pomegr-observability-dashboard")).not.toBeInTheDocument();
    expect(screen.getByText(source)).toBeInTheDocument();
    expect(screen.getByText(id.slice(id.indexOf(":") + 1))).toBeInTheDocument();
    expect(screen.queryByText(id)).not.toBeInTheDocument();
  });

  it("labels Codex provenance and shows its agent-reported session summary", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      summary: { text: "Unsupported summary must stay hidden", observedAt: null, source: "provider" },
      signal: { label: "Awaiting merge", tone: "info", reportedAt: "2026-08-24T12:00:00.000Z", description: "Implementation is complete. Next: merge the approved pull request." },
    } satisfies NonNullable<MonitorState["session"]>;
    render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Codex")).toHaveClass("providerTag");
    expect(screen.getByText("Codex").closest(".providerBadge")?.querySelector('[data-mark="openai"]')).toBeInTheDocument();
    expect(screen.getByText("Implementation is complete. Next: merge the approved pull request.")).toHaveAttribute("title", "Agent-reported session summary from the Pomegr MCP tool");
    expect(screen.getByText("Agent-reported summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Awaiting merge" })).toBeInTheDocument();
    expect(screen.queryByText("Unsupported summary must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the provider/)).not.toBeInTheDocument();
  });

  it("asks Codex agents for a report instead of claiming summaries are unsupported", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      updatedAt: "2026-08-24T12:00:00.000Z",
    };

    const { rerender } = render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);
    expect(screen.getByText("Waiting for an agent to report a session summary through Pomegr.")).toBeInTheDocument();
    expect(screen.queryByText(/not available for this provider/i)).not.toBeInTheDocument();

    rerender(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical /></LiveClockProvider>);
    expect(screen.getByText("No agent-reported summary was recorded for this session.")).toBeInTheDocument();
  });

  it("uses the Claude mark for Claude Code sessions", () => {
    const session = repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Claude Code").closest(".providerBadge")?.querySelector('[data-mark="claude"]')).toBeInTheDocument();
  });

  it("never gives an unsupported provider the Claude /context instruction", () => {
    const { container } = render(<MachineryPanel machinery={null} supported={false} historical={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/\/context/)).not.toBeInTheDocument();
  });

  it("renders no manual context instruction when a live snapshot is absent", () => {
    const { container } = render(<MachineryPanel machinery={null} supported historical={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(container).not.toHaveTextContent("/context");
  });

  it("renders no manual context instruction when a historical snapshot is absent", () => {
    const { container } = render(<MachineryPanel machinery={null} supported historical />);

    expect(container).toBeEmptyDOMElement();
    expect(container).not.toHaveTextContent("/context");
  });
});
