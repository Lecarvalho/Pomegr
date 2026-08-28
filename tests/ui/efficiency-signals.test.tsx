import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InsightsPanel } from "../../app/components/dashboard/InsightsPanel";

describe("efficiency signal semantics", () => {
  it("uses a warning triangle instead of a positive check for warning signals", () => {
    const { container } = render(<InsightsPanel insights={[{
      id: "automatic-compaction-primary",
      level: "warning",
      title: "Primary agent context was automatically compacted",
      detail: "Earlier conversation detail was summarized.",
    }]} />);

    expect(container.querySelector(".insight.warning .insightWarningIcon")).toBeInTheDocument();
    expect(container.querySelector(".insight.warning .insightCheckIcon")).not.toBeInTheDocument();
  });
});
