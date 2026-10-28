import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  return { ...actual, useClientAccess: () => ({ mode: "unknown", canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});
import { AgentChatSection } from "../../app/components/design-system/DesignSystemAgentChatSample";

function sectionOf(name: string) {
  return screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
}
function sample(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: ".designSystemSample > span" }).closest(".designSystemSample") as HTMLElement;
}

// The Aril chat section of the reference page: invented conversations drawn with the real panel parts.
describe("Design-system reference page, Agent chat", { timeout: 20_000 }, () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network use is forbidden on the design-system page")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the Aril chat from invented conversations: the launcher states, the panel, every proposal state and the composer", () => {
    render(<AgentChatSection />);
    const chat = sectionOf("Agent chat");
    const launcherOf = (label: string, name: string) => within(sample(chat, label)).getByRole("button", { name });
    expect(launcherOf("Launcher", "Open Aril, the Pomegr agent")).toHaveClass("agentChatLauncher", "isStatic");
    expect(launcherOf("Launcher, answering", "Open Aril, the Pomegr agent, answering")).toHaveTextContent("Aril · answering…");
    const fresh = launcherOf("Launcher, new answer", "Open Aril, the Pomegr agent, new answer");
    expect(fresh.querySelector(".agentChatLauncherDot")).not.toBeNull();

    const empty = sample(chat, "Panel, empty");
    expect(within(empty).getByRole("region", { name: "Aril, the Pomegr agent" })).toHaveClass("agentChatPanel", "isStatic");
    expect(within(empty).getByRole("heading", { level: 3, name: "Ask Aril about this board" })).toBeInTheDocument();
    expect(within(empty).getAllByRole("button").filter((button) => button.classList.contains("agentChatSuggestion"))).toHaveLength(4);
    expect(within(empty).getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
    expect(within(empty).getByRole("textbox", { name: "Message Aril" })).toBeEnabled();

    const proposed = sample(chat, "Panel, proposal");
    const rows = within(within(proposed).getByRole("region", { name: "Proposed board changes" })).getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    expect(rows[3]).toHaveTextContent("Delete T-14");
    expect(within(proposed).getByRole("button", { name: "Apply changes" })).toHaveClass("commandPrimaryAction");
    expect(within(proposed).getByRole("button", { name: "Dismiss" })).toHaveClass("commandQuietAction");

    const writing = sample(chat, "Panel, answer being written");
    expect(within(writing).getByRole("status")).toHaveTextContent("Reading repository files…");
    expect(within(writing).getByRole("button", { name: "Stop" })).toHaveClass("commandIconAction", "agentChatSend");
    expect(within(writing).getByRole("button", { name: "Stop" }).querySelector("rect")).not.toBeNull();
    expect(writing.querySelector(".isWriting .agentChatMessageHead time")).toHaveAttribute("datetime", "2026-10-11T10:00:00.000Z");
    expect(within(writing).queryByRole("button", { name: "Send" })).toBeNull();

    // The header: the glyph and name, Search, Expand, and Close; no conversation actions, no caption, and no Minimize.
    const header = empty.querySelector("header.agentChatHeader")!;
    expect([...header.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Search", "Expand", "Close Aril"]);
    expect(within(empty).getByRole("button", { name: "Expand" })).toHaveAttribute("aria-pressed", "false");
    expect(within(empty).queryByRole("button", { name: "Minimize" })).toBeNull();
    expect(within(empty).getByRole("combobox", { name: "Repository" }).closest("form")).toHaveClass("agentChatComposer");
    expect(within(proposed).getAllByRole("article", { name: "You" })[0].querySelector("time")).toHaveAttribute("datetime", "2026-10-11T10:00:00.000Z");
    expect(proposed.querySelector(".isAgent .agentChatMessageHead time")).not.toBeNull();

    const expanded = sample(chat, "Panel, expanded");
    expect(within(expanded).getByRole("region", { name: "Aril, the Pomegr agent" })).toHaveClass("agentChatPanel", "isStatic", "isExpanded");
    expect(within(expanded).getByRole("button", { name: "Dock", pressed: true })).toHaveClass("commandIconAction");
    expect(within(expanded).queryByRole("button", { name: "Expand" })).toBeNull();

    const quiet = sample(chat, "Panel, activity lines");
    const lines = [...quiet.querySelectorAll(".agentChatQuietLine")];
    expect(lines.map((line) => line.querySelector(".agentChatQuietText")?.textContent)).toEqual(["Merged T-5 and started T-6. Nothing needs you yet.", "Could not merge T-7. T-7 needs you."]);
    for (const line of lines) {
      expect(line.querySelector("svg.commandIcon")).not.toBeNull();
      expect(line.querySelector("time")).toHaveAttribute("datetime", "2026-10-11T10:05:00.000Z");
      expect(line.querySelector(".agentChatMessageHead")).toBeNull();
    }

    // The search under the header: a field with no frame, and the matches newest first, each with who wrote it, its time, and an excerpt with the searched text emphasized.
    const searching = sample(chat, "Panel, search");
    expect(within(searching).getByRole("button", { name: "Search", pressed: true })).toHaveClass("commandIconAction");
    const region = within(searching).getByRole("search", { name: "Search the conversation" });
    expect(within(region).getByRole("searchbox", { name: "Search messages" })).toHaveAttribute("maxlength", "100");
    const matches = within(within(region).getByRole("list", { name: "Matching messages" })).getAllByRole("listitem");
    expect(matches).toHaveLength(3);
    expect(matches[0].querySelector(".agentChatSearchWho")).toHaveTextContent("Aril");
    expect(matches[1].querySelector(".agentChatSearchWho")).toHaveTextContent("You");
    expect(matches[1].querySelector("time")).toHaveAttribute("datetime", "2026-10-10T16:30:00.000Z");
    expect([...matches[0].querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["retry"]);
    expect(within(matches[2]).getByRole("button")).toHaveClass("agentChatSearchResult");
    expect(searching.querySelector(".agentChatHistory")).toBeNull();
    const nothing = sample(chat, "Panel, search without a match");
    expect(within(nothing).getByText("No messages match.")).toBeInTheDocument();
    expect(nothing.querySelector(".agentChatSearchList")).toBeNull();
    const earlier = sample(chat, "Panel, earlier messages loading");
    expect(earlier.querySelector(".agentChatEarlier")).toHaveTextContent("Loading earlier messages…");

    const notes = sample(chat, "Panel, notes under an answer");
    expect(within(notes).getByText("This answer took too long and was stopped.")).toBeInTheDocument();
    expect(within(notes).getByText(/^Aril wrote a proposal that Pomegr could not read/)).toHaveClass("taskNotice", "warning");
    expect(within(sample(chat, "Panel, no repository")).getByRole("textbox", { name: "Message Aril" })).toBeDisabled();

    const chipOf = (label: string) => sample(chat, label).querySelector(".commandChip");
    expect(sample(chat, "Proposal, pending").querySelector(".commandChip")).toBeNull();
    expect(within(sample(chat, "Proposal, pending")).getByText("Nothing changes until you apply.")).toBeInTheDocument();
    expect(within(sample(chat, "Proposal, pending, with a delete")).getByText("Nothing changes until you apply. Deleting cannot be undone.")).toBeInTheDocument();
    expect(within(sample(chat, "Proposal, applying")).getByRole("region", { name: "Proposed board changes" })).toHaveAttribute("aria-busy", "true");
    expect(within(sample(chat, "Proposal, applying")).getByRole("button", { name: "Apply changes" })).toBeDisabled();
    expect(chipOf("Proposal, applied")).toHaveTextContent("Applied");
    expect(chipOf("Proposal, partly applied")).toHaveTextContent("Partly applied");
    expect(chipOf("Proposal, dismissed")).toHaveTextContent("Dismissed");
    expect([...sample(chat, "Proposal, every result word").querySelectorAll(".agentChatOpResult")].map((result) => result.textContent)).toEqual([
      "Done", "Created T-19", "Not valid", "Not found", "Board is full", "No longer possible", "Not supported", "Pomegr did not answer",
    ]);
    expect(sample(chat, "Proposal, partly applied")).toHaveTextContent("Created T-19, but it could not be queued");
    expect(sample(chat, "Proposal, partly applied")).toHaveTextContent("Not run");
    expect([...sample(chat, "Proposal, new tasks placed").querySelectorAll(".agentChatOpTitle")].map((title) => title.textContent)).toEqual(["Create task below T-12", "Create task in Ready"]);
    expect(sample(chat, "Proposal, new tasks placed")).toHaveTextContent("position 1");
    expect([...sample(chat, "Proposal, a new task not placed").querySelectorAll(".agentChatOpResult")].map((result) => result.textContent)).toEqual(["Created T-19, but it could not be placed", "Not run"]);

    const startCard = (label: string) => within(sample(chat, label)).getByRole("region", { name: "Proposed session start" });
    expect(within(startCard("Session start, proposed")).getByRole("button", { name: "Start session" })).toHaveClass("commandPrimaryAction");
    expect(startCard("Session start, proposed")).toHaveTextContent("Nothing starts until you select Start session and confirm in the desktop dialog.");
    expect(chipOf("Session start, proposed")).toBeNull();
    expect(startCard("Session start, held")).toHaveTextContent("Not started. A start gate held this task.");
    expect(startCard("Session start, held")).toHaveTextContent("This task is held: Claude Code is above 85% of the five-hour window.");
    expect(within(startCard("Session start, held")).getByRole("button", { name: "Start session" })).toBeEnabled();
    expect(startCard("Session start, failed")).toHaveTextContent("Not started. Install or update the Pomegr plugin in this repository to start sessions.");
    expect(chipOf("Session start, launched")).toHaveTextContent("Session started");
    expect(startCard("Session start, launched")).toHaveTextContent("Session started in a new terminal window.");
    expect(within(startCard("Session start, launched")).queryByRole("button")).toBeNull();
    expect(within(startCard("Session start, on a paired device")).queryByRole("button", { name: "Start session" })).toBeNull();
    expect(within(startCard("Session start, on a paired device")).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    const queueCard = (label: string) => within(sample(chat, label)).getByRole("region", { name: "Proposed queue change" });
    expect(within(queueCard("Queue change, on, proposed")).getByRole("button", { name: "Turn queue on" })).toHaveClass("commandPrimaryAction");
    expect(queueCard("Queue change, on, proposed")).toHaveTextContent("Pomegr may then start queued tasks by itself on the computer that runs Pomegr");
    expect(within(queueCard("Queue change, off, proposed")).getByRole("button", { name: "Turn queue off" })).toHaveClass("commandPrimaryAction");
    expect(queueCard("Queue change, off, proposed")).toHaveTextContent("No new task starts then, and running sessions continue.");
    expect(within(queueCard("Queue change, on a paired device")).getByRole("button", { name: "Turn queue on" })).toBeEnabled();
    expect(queueCard("Queue change, turned on")).toHaveTextContent("Queue turned on.");
    expect(within(queueCard("Queue change, turned on")).queryByRole("button")).toBeNull();
    expect(queueCard("Queue change, turned on and held").querySelector(".agentChatOpResult")).toHaveClass("is-muted");
    expect(queueCard("Queue change, turned off")).toHaveTextContent("Queue turned off.");
    expect(queueCard("Queue change, not changed")).toHaveTextContent("Queue not changed. Pomegr did not answer. Try again.");
    expect(within(queueCard("Queue change, not changed")).getByRole("button", { name: "Turn queue on" })).toBeEnabled();

    // The model and the effort: named models grouped by provider, never a default, and Medium to start; with no known model, the provider's name.
    const chosen = sample(chat, "Composer, model and effort");
    expect(within(chosen).getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-large$/);
    expect(within(chosen).getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^High$/);
    expect(within(chosen).queryByRole("combobox", { name: "Run on" })).toBeNull();
    expect(chosen.querySelector(".designSystemSampleBody")!.textContent).not.toMatch(/default/i);
    const bare = sample(chat, "Composer, no known model");
    expect(within(bare).getByRole("combobox", { name: "Model" })).toHaveTextContent(/^Claude Code$/);
    expect(within(bare).getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^Medium$/);

    // The panel over a dimmed page: the scrim sits under the docked panel, and nothing fixes either to the window.
    const stage = sample(chat, "Panel, over the dimmed page");
    expect(stage.querySelector(".designSystemChatStage > .agentChatScrim.isStatic")).not.toBeNull();
    expect(within(stage).getByRole("region", { name: "Aril, the Pomegr agent" })).toHaveClass("agentChatPanel", "isStatic");
    expect(within(stage).getAllByRole("button", { name: "Close Aril" })).toHaveLength(1);

    // An answer's head names the effort it ran with.
    expect(proposed.querySelector(".isAgent .agentChatMessageCaption")).toHaveTextContent("Claude Code · model-large · Medium");
    expect(writing.querySelector(".isWriting .agentChatMessageCaption")).toHaveTextContent("Claude Code · model-large · Medium");

    const withRepository = sample(chat, "Composer, repository");
    expect(within(withRepository).getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
    expect(within(withRepository).getByRole("button", { name: "Send" })).toHaveClass("commandIconAction", "agentChatSend");
    expect(within(sample(chat, "Composer, error")).getByRole("alert")).toHaveTextContent("Aril is already answering. Wait for it to finish.");
    expect(within(sample(chat, "Composer, over the limit")).getByText("4,012 / 4,000")).toHaveClass("isOver");
    expect(within(sample(chat, "Composer, over the limit")).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(chat.textContent).not.toMatch(/answering in another conversation/);
    const text = sample(chat, "Answer text");
    expect(text.querySelector("img, a, script")).toBeNull();
    expect(text).toHaveTextContent("<img src=x onerror=alert(1)> [a link](javascript:alert(1))");
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);
});
