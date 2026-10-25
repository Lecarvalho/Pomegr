import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TaskReviewPanel } from "../../app/components/tasks/TaskReviewPanel";
import { board, task } from "./task-group-fixtures";

it("shows the stalled T-3 projection with its reason and no completion results", () => {
  const projection = board({ tasks: [task(3, {
    text: "Synthetic task 3", state: "stalled", report: null,
    completeWhen: { checks: ["tree_clean"], own: null },
  })] });
  render(<TaskReviewPanel task={projection.tasks[0]} />);
  expect(screen.getByRole("heading", { name: "Stalled" })).toBeVisible();
  expect(screen.getByText("The session ended with no report.")).toBeVisible();
  expect(screen.queryByRole("list", { name: "Complete when" })).not.toBeInTheDocument();
});
