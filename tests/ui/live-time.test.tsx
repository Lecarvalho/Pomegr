import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionWallTimeText } from "../../app/components/LiveTime";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

describe("SessionWallTimeText", () => {
  it("keeps setup-only sessions out of the running wall-time display", () => {
    render(<LiveClockProvider running={false}><SessionWallTimeText session={{ startedAt: null, durationMs: 0 }} historical={false} /></LiveClockProvider>);
    expect(screen.getByText("Not started")).toBeInTheDocument();
  });
});
