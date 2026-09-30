import { fireEvent, within } from "@testing-library/react";

/** Opens a CommandSelect and picks the option whose value or label matches, as user.selectOptions did for native selects. */
export function chooseCommandOption(trigger: HTMLElement, option: string | number) {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  if (!list) throw new Error("CommandSelect listbox did not open");
  const wanted = String(option);
  const match = within(list).getAllByRole("option").find((element) => element.dataset.value === wanted || element.textContent === wanted);
  if (!match) throw new Error(`CommandSelect has no option ${wanted}`);
  fireEvent.click(match);
}
