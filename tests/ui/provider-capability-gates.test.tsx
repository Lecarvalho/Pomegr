import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MachineryPanel } from "../../app/components/dashboard/MachineryPanel";

describe("provider capability gates", () => {
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
