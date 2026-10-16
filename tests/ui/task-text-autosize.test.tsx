import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskTextField } from "../../app/components/tasks/TaskFields";
import { TASK_BOUNDS } from "../../shared/task-contract";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Task textarea autosizing", () => {
  it("fits existing text, typing, pasted text and deletion without replacing the focused field", () => {
    const existing = "Existing task\n".repeat(40);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return (this as HTMLTextAreaElement).value.split("\n").length * 20;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(152);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(150);
    function Editor() {
      const [value, setValue] = useState(existing);
      return <TaskTextField value={value} onChange={setValue} />;
    }
    render(<Editor />);
    const field = screen.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement;
    expect(field.style.height).toBe("822px");
    expect(field).toHaveAttribute("maxlength", String(TASK_BOUNDS.textLength));
    field.focus();
    fireEvent.change(field, { target: { value: `${existing}Typed\n` } });
    expect(field.style.height).toBe("842px");
    // A browser reports the resulting value after a paste or a selection deletion through the same change event.
    fireEvent.change(field, { target: { value: `${field.value}${"Pasted\n".repeat(20)}` } });
    expect(field.style.height).toBe("1242px");
    field.setSelectionRange(5, 5);
    fireEvent.change(field, { target: { value: "Short task" } });
    expect(field.style.height).toBe("22px");
    expect(field).toHaveAccessibleDescription("10 / 4,000");
    expect(screen.getByRole("textbox", { name: "Task" })).toBe(field);
    expect(field).toHaveFocus();
  });

  it("remeasures after opening and width changes, preserves the caret, and disconnects on close", () => {
    let resize!: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(0);
    const { unmount } = render(<TaskTextField value={"Long text ".repeat(80)} onChange={vi.fn()} readOnly />);
    const field = screen.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement;
    expect(field.style.height).toBe("auto");
    const notifyWidth = (width: number) => act(() => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    height.mockReturnValue(600);
    notifyWidth(560);
    expect(field.style.height).toBe("600px");
    field.focus();
    field.setSelectionRange(12, 24);
    height.mockReturnValue(1400);
    notifyWidth(280);
    expect(field.style.height).toBe("1400px");
    expect([field.selectionStart, field.selectionEnd]).toEqual([12, 24]);
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("readonly");
    height.mockReturnValue(600);
    notifyWidth(560);
    expect(field.style.height).toBe("600px");
    // Height-only notifications must not cause another measurement cycle.
    height.mockClear();
    notifyWidth(560);
    expect(height).not.toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
