import { fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FeatureModalSamples } from "../../app/components/design-system/DesignSystemFeatureModalSample";
import { SessionTaskSection } from "../../app/components/design-system/DesignSystemSessionTaskSample";
import { TaskFieldsSection } from "../../app/components/design-system/DesignSystemTaskFieldsSample";
import { REPOSITORY_ID, forbidNetwork, sample, sectionOf } from "./design-system-helpers";

// The Task modal's fields, the Feature modal and the Sessions list Task cell of /design-system, drawn from static data.
describe("Design-system reference page, task fields", () => {
  forbidNetwork();

  it("renders the Task fields samples from static data: grouped Run on, required Effort and Complete when, review panels and read views", async () => {
    const user = userEvent.setup();
    render(<TaskFieldsSection />);
    const section = sectionOf("Task fields");
    const chosen = within(sample(section, "Run on and Effort, chosen"));
    expect(chosen.getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · model-large");
    // Only the sample of a task stored with nothing chosen shows Not set.
    expect(within(sample(section, "Stored task with nothing chosen, no model list")).getByRole("combobox", { name: "Run on" })).toHaveTextContent("Not set");
    expect(within(sample(section, "Remote Control, on")).getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · Default model");
    const effort = chosen.getByRole("button", { name: "High" });
    expect(effort).toHaveAttribute("aria-pressed", "true");
    await user.click(effort);
    expect(effort).toHaveAttribute("aria-pressed", "true");
    expect(effort.parentElement).toHaveClass("commandSegmented");
    expect(within(sample(section, "Complete when, new task")).getByRole("checkbox", { name: "PR open" })).toBeChecked();

    // Each Review panel shows its own results; a count of them would only break when a sample is added.
    expect(within(sample(section, "Review panel, needs review")).getAllByText("Passed").length).toBeGreaterThan(0);
    expect(within(sample(section, "Review panel, needs review")).getAllByText("Not passed").length).toBeGreaterThan(0);
    // A condition Pomegr could not verify is muted: it takes neither result color.
    const unverified = within(section).getAllByText("Not verified");
    expect(unverified.length).toBeGreaterThan(0);
    for (const note of unverified) expect(note.className).toBe("taskCheckResult");
    // A done task keeps the panel, headed Agent report.
    const done = sample(section, "Review panel, done with a report");
    expect(within(done).getByRole("heading", { level: 3, name: "Agent report" })).toBeInTheDocument();
    expect(within(done).getAllByText("Passed").length).toBeGreaterThan(0);

    // The rich text sample with tags draws them as the chips row above the title line.
    const tagged = within(section).getByRole("group", { name: "Tags: backend, recce, bug" });
    expect(tagged.parentElement).toHaveClass("taskRichText");
    expect(tagged.nextElementSibling).toHaveClass("taskRichTitle");
    // The read view shows an inline image where the text names it.
    expect(sample(section, "Task, read view, inline image").querySelector(".taskRead .taskInlineImage")).toHaveAttribute("alt", "Image 1");
    // The Observed model differs notice sits in the Run on row.
    const settings = sample(section, "Run settings, observed model differs");
    const runOn = [...settings.querySelectorAll("dt")].find((term) => term.textContent === "Run on")?.closest(".taskRow") as HTMLElement;
    expect(within(runOn).getByText("Observed model differs")).toBeInTheDocument();
    expect(within(runOn).getByText("model-small", { selector: "code" })).toBeInTheDocument();

    // The feature fields: three selects, no Step, and the folded list of the feature's tasks.
    expect(within(section).getAllByRole("combobox", { name: "Feature" })).toHaveLength(3);
    expect(within(section).queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();
    expect(within(section).getAllByRole("combobox", { name: "Feature" })[0]).toHaveTextContent("Upload reliability");
    const created = sample(section, "New feature");
    expect(within(created).getByRole("textbox", { name: "Feature name" })).toHaveValue("Retry telemetry");
    const placed = sample(section, "Feature");
    expect(placed.querySelector(".taskFeatureDetails > summary")).toHaveTextContent("In this feature3 tasks · 1 done");
    expect(placed.querySelectorAll(".taskFeatureItem")).toHaveLength(3);
    await user.type(within(created).getByRole("textbox", { name: "Feature name" }), "!");
    expect(within(created).getByRole("textbox", { name: "Feature name" })).toHaveValue("Retry telemetry!");
  });

  it("renders the Feature modal as static chrome: both modes, the live primary, the unread fields and the three failure lines", async () => {
    const user = userEvent.setup();
    const { container: fields } = render(<FeatureModalSamples />);

    const created = sample(fields, "Feature modal, new feature");
    expect(within(created).getByRole("heading", { level: 2, name: "New feature" })).toBeInTheDocument();
    expect(created.querySelector(".taskModalSubtitle")).toHaveTextContent("pomegr");
    const title = within(created).getByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("maxlength", "80");
    expect(title).toHaveAttribute("placeholder", "What is this feature?");
    expect(within(created).getByRole("textbox", { name: "Description" })).not.toHaveAttribute("maxlength");
    const version = within(created).getByRole("textbox", { name: "App version" });
    expect(version).toHaveClass("taskOwnInput", "featureVersion");
    expect(version).toHaveAttribute("maxlength", "40");
    expect(created.querySelectorAll(".newTaskField.featureField")).toHaveLength(3);
    expect([...created.querySelectorAll(".featureCounter")].map((counter) => counter.textContent)).toEqual(["0 / 80", "0 / 2,000"]);
    const create = within(created).getByRole("button", { name: "Create feature" });
    expect(create).toBeDisabled();
    expect(create).toHaveClass("commandPrimaryAction");
    expect(within(created).getByRole("button", { name: "Cancel" })).toHaveClass("commandQuietAction");
    await user.type(title, "Retry telemetry");
    expect(created.querySelector(".featureCounter")).toHaveTextContent("15 / 80");
    expect(create).toBeEnabled();
    // The Description counter takes the error colour past its bound, and the primary is disabled.
    fireEvent.change(within(created).getByRole("textbox", { name: "Description" }), { target: { value: "x".repeat(2001) } });
    expect(created.querySelectorAll(".featureCounter")[1]).toHaveClass("isOver");
    expect(created.querySelectorAll(".featureCounter")[1]).toHaveTextContent("2,001 / 2,000");
    expect(create).toBeDisabled();

    const stored = sample(fields, "Feature modal, feature, saved");
    expect(within(stored).getByRole("heading", { level: 2, name: "Feature" })).toBeInTheDocument();
    expect(stored.querySelector(".taskModalTitleGroup .commandChip")).toHaveClass("taskCardChip", "neutral");
    expect(stored.querySelector(".taskModalTitleGroup .commandChip")).toHaveTextContent("1 of 3 done");
    const save = within(stored).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(save).toHaveClass("commandPrimaryAction");
    expect(within(stored).getByRole("button", { name: "Delete feature" })).toHaveClass("commandQuietAction");
    expect(within(stored).queryByRole("button", { name: "Cancel" })).toBeNull();
    const tasks = stored.querySelector("details.taskFeatureDetails") as HTMLDetailsElement;
    expect(tasks.open).toBe(false);
    expect(tasks.querySelector(".taskFeatureLabel")).toHaveTextContent("Tasks");
    expect(tasks.querySelector(".taskFeatureCount")).toHaveTextContent("3 tasks · 1 done");
    expect(tasks.querySelectorAll(".taskFeatureItem")).toHaveLength(3);
    expect(tasks.querySelector(".taskFeatureOpen")).toBeInTheDocument();
    await user.type(within(stored).getByRole("textbox", { name: "App version" }), "1");
    expect(save).toBeEnabled();
    expect(within(sample(fields, "Feature modal, feature, changed")).getByRole("button", { name: "Save" })).toBeEnabled();

    const unread = sample(fields, "Feature modal, details not read");
    expect(within(unread).getByRole("textbox", { name: "Description" })).toBeDisabled();
    expect(within(unread).getByRole("textbox", { name: "App version" })).toBeDisabled();
    expect(within(unread).getByRole("textbox", { name: "Title" })).toBeEnabled();
    expect(within(unread).getByRole("alert")).toHaveTextContent("The description and app version could not be read.");

    const duplicate = sample(fields, "Feature modal, duplicate title");
    const line = within(duplicate).getByRole("alert");
    expect(line).toHaveClass("newTaskError");
    expect(line).toHaveTextContent("Another feature already has this title.");
    expect(within(duplicate).getByRole("textbox", { name: "Title" }).getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
    expect(within(sample(fields, "Feature modal, could not save")).getByRole("alert")).toHaveTextContent("The feature could not be saved.");
    expect(within(sample(fields, "Feature modal, feature limit")).getByRole("alert")).toHaveTextContent("This board already holds 50 features. Delete one first.");
    // The delete footer: the confirmation with the tasks, the started task that blocks it, and the failed delete.
    const confirmation = sample(fields, "Feature modal, delete confirmation");
    expect(within(confirmation).queryByRole("button", { name: "Save" })).toBeNull();
    const group = within(confirmation).getByRole("group", { name: "Confirm delete" });
    expect(group.querySelector(".taskModalNote")).toHaveTextContent("Delete this feature? Its 3 tasks stay on the board with no feature. This cannot be undone.");
    expect(within(group).getByRole("button", { name: "Delete feature" })).toHaveClass("commandSecondaryAction");
    await user.click(within(group).getByRole("button", { name: "Keep feature" }));
    expect(within(confirmation).queryByRole("group", { name: "Confirm delete" })).toBeNull();
    expect(within(confirmation).getByRole("button", { name: "Delete feature" })).toHaveClass("commandQuietAction");
    const blocked = sample(fields, "Feature modal, delete blocked");
    expect(blocked.querySelector(".taskModalResolve .taskModalNote")).toHaveTextContent("T-2 is running. Delete the feature after its tasks finish.");
    expect(within(blocked).getByRole("button", { name: "Delete feature" })).toBeDisabled();
    expect(within(sample(fields, "Feature modal, could not delete")).getByRole("alert")).toHaveTextContent("The feature could not be deleted.");
  });

  it("renders the Sessions list Task cell for every outcome, from static references", () => {
    render(<SessionTaskSection />);
    const cells = sectionOf("Sessions list Task cell");

    const working = sample(cells, "Working on the task");
    expect(within(working).getByRole("link", { name: "Open task T-14 on its board" })).toHaveAttribute("href", `/tasks?repository=${REPOSITORY_ID}`);
    expect(within(working).getByRole("link", { name: "Open task T-14 on its board" })).toHaveClass("commandTextLink", "commandSessionTaskId");
    expect(working.querySelector(".commandChip")).toBeNull();
    expect(working.querySelector(".commandSessionTaskFeature")).toHaveTextContent("Upload reliability");
    expect(sample(cells, "Needs review").querySelector(".commandChip")).toHaveClass("warning");
    expect(sample(cells, "Stalled").querySelector(".commandChip")).toHaveTextContent("Stalled");
    expect(sample(cells, "Stalled").querySelector(".commandChip")).toHaveClass("warning");
    expect(sample(cells, "Done").querySelector(".commandChip")).toHaveClass("neutral");
    expect(sample(cells, "Under a Feature group").querySelector(".commandSessionTaskFeature")).toBeNull();
    expect(sample(cells, "No feature").querySelector(".commandSessionTaskFeature")).toBeNull();
    // A reviewer session shows the task it reviews, under the Review label.
    const reviewer = sample(cells, "Reviewer session");
    expect(within(reviewer).getByRole("link", { name: "Open task T-12 on its board" })).toBeInTheDocument();
    expect(within(reviewer).getByText("Review")).toHaveClass("commandSessionTaskFeature");
    expect(within(sample(cells, "Started by you")).getByTitle("Not started from a task, reviewing one, or assigned to one")).toHaveTextContent("—");
    expect(within(sample(cells, "Table footnote")).getByText(/^Task shows the task a session was started for or reviewed \(marked Review\), and the tasks it is assigned to\./)).toHaveClass("commandUnavailableNote");
  });
});
