import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandSelect, type CommandSelectOption } from "../../app/components/command-center/CommandPage";
import { agent } from "./dashboard-test-fixtures";
import { renderPanel, snapshot } from "./requests-actions-test-fixtures";

const OPTIONS: CommandSelectOption[] = [
  { value: "all", label: "All agents" },
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta", icon: <i className="commandStatusDot online" />, iconLabel: "running" },
  { value: "bravo", label: "Bravo" },
];

function Harness({ onChange = () => undefined, disabled = false }: { onChange?: (value: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("all");
  return <CommandSelect aria-label="Scope" value={value} disabled={disabled} options={OPTIONS} onChange={(next) => { setValue(next); onChange(next); }} />;
}

const trigger = () => screen.getByRole("combobox", { name: "Scope" });
const activeOption = () => document.getElementById(trigger().getAttribute("aria-activedescendant") ?? "");

describe("CommandSelect", () => {
  it("opens a listbox on click, marks the selected option, and commits a clicked option", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox", { name: "Scope" });
    expect(within(list).getByRole("option", { name: "All agents" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(list).getByRole("option", { name: "Alpha" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Alpha");
    expect(trigger()).toHaveAttribute("data-value", "alpha");
  });

  it("follows native select keys: arrows, Home/End, typeahead, Enter, and Escape", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(activeOption()).toHaveTextContent("All agents");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(activeOption()).toHaveTextContent("Alpha");
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(activeOption()).toHaveTextContent("Bravo");
    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(activeOption()).toHaveTextContent("All agents");
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(trigger(), { key: "b" });
    expect(activeOption()).toHaveTextContent("Beta");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("names an option's glyph for assistive technology and repeats it on the trigger", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(screen.getByRole("option", { name: /^Beta,? running$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /^Beta,? running$/ }));
    expect(trigger().querySelector(".commandStatusDot")).not.toBeNull();
  });

  it("does not open while disabled", () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("Activities agent scope", () => {
  const running = { ...agent, id: "child", parentId: "primary", label: "Builder", status: "active" as const };
  const items = [snapshot(1), snapshot(2, "child")];

  it("marks agents still running in a live session", () => {
    renderPanel(items, { agents: [agent, running] });
    fireEvent.click(screen.getByRole("combobox", { name: "Agent scope" }));
    expect(screen.getByRole("option", { name: /^Builder.*running$/ }).querySelector(".commandStatusDot.online")).not.toBeNull();
    expect(screen.getByRole("option", { name: /^Primary agent$/ }).querySelector(".commandStatusDot")).toBeNull();
  });

  it("marks nothing running in a historical session", () => {
    renderPanel(items, { agents: [agent, running], historical: true });
    fireEvent.click(screen.getByRole("combobox", { name: "Agent scope" }));
    expect(document.querySelector(".commandSelectList .commandStatusDot")).toBeNull();
  });
});
