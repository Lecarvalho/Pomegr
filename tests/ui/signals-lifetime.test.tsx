import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SignalsDomain } from "../../shared/session-domain-contract";
import { SignalsLifetimeSection } from "../../app/components/dashboard/signals/SignalsLifetimeSection";

const agents: SignalsDomain["agents"] = [
  { id: "primary", label: "Primary agent", cacheLifetime: "1h", signal: null },
  { id: "worker", label: "Worker", cacheLifetime: "30m+", signal: null },
];

describe("Signals cache lifetime", () => {
  it("shows normalized lifetimes and documents the minimum without treating it as expiry", () => {
    render(<SignalsLifetimeSection agents={agents} readiness="ready" />);
    expect(screen.getByText("1h")).toBeInTheDocument();
    expect(screen.getByText("≥30m")).toBeInTheDocument();
    expect(screen.getByText("≥30m is a documented minimum, not a recorded expiry.")).toBeInTheDocument();
  });

  it("does not invent lifetimes when context evidence is unavailable", () => {
    render(<SignalsLifetimeSection agents={agents} readiness="unavailable" />);
    expect(screen.getAllByText("unavailable")).toHaveLength(2);
    expect(screen.getByText("Context evidence is unavailable, so cache lifetimes are unavailable.")).toBeInTheDocument();
  });
});
