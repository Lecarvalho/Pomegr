import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArilControlSamples } from "../../app/components/design-system/DesignSystemArilControlsSample";
import { ArilSettingsSamples } from "../../app/components/design-system/DesignSystemTaskGatesSample";

// The reference page is rendered on the server and then hydrated. A sample that read the clock would show a different time when a minute
// passed between the two, and hydration would fail on that minute of every hour.
afterEach(() => { vi.restoreAllMocks(); });

describe("the Aril settings samples", () => {
  it("do not read the clock: the same page is drawn a minute apart", () => {
    const at = vi.spyOn(Date, "now");
    at.mockReturnValue(Date.parse("2026-10-29T21:58:59.000Z"));
    const first = renderToString(<ArilSettingsSamples />);
    at.mockReturnValue(Date.parse("2026-10-29T21:59:03.000Z"));
    const second = renderToString(<ArilSettingsSamples />);
    expect(second).toBe(first);
    // The running grant still shows an end time.
    expect(first).toMatch(/is active until[^<]*(?:<!-- -->)?<span class="arilGrantTime">(?:<!-- -->)?\d{2}:\d{2}/u);
  });

  it("controls: the cards draw the same markup a minute apart, memory footers included", () => {
    const at = vi.spyOn(Date, "now");
    at.mockReturnValue(Date.parse("2026-10-29T21:58:59.000Z"));
    const first = renderToString(<ArilControlSamples />);
    at.mockReturnValue(Date.parse("2026-10-29T21:59:03.000Z"));
    expect(renderToString(<ArilControlSamples />)).toBe(first);
  });
});
