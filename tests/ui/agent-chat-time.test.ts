import { describe, expect, it } from "vitest";
import { formatMessageTime, fullMessageTime } from "../../app/components/agent-chat/agent-chat-presentation";

// Local dates are built from their parts, so the expectations hold in any time zone.
const local = (year: number, month: number, day: number, hour: number, minute: number, second = 0) => new Date(year, month - 1, day, hour, minute, second);

describe("the time of a chat message", () => {
  const now = local(2026, 10, 28, 18, 30);

  it("reads HH:MM in 24-hour local time for a message of today", () => {
    expect(formatMessageTime(local(2026, 10, 28, 9, 5).toISOString(), now)).toBe("09:05");
    expect(formatMessageTime(local(2026, 10, 28, 23, 59).toISOString(), now)).toBe("23:59");
    expect(formatMessageTime(local(2026, 10, 28, 12, 0).toISOString(), now)).toBe("12:00");
  });

  it("reads 00:00 at midnight, never 24:00", () => {
    expect(formatMessageTime(local(2026, 10, 28, 0, 0).toISOString(), now)).toBe("00:00");
    expect(formatMessageTime(local(2026, 10, 28, 0, 7).toISOString(), now)).toBe("00:07");
  });

  it("reads Mon D, HH:MM for a message of an earlier day", () => {
    expect(formatMessageTime(local(2026, 10, 11, 10, 0).toISOString(), now)).toBe("Oct 11, 10:00");
    expect(formatMessageTime(local(2026, 1, 3, 7, 45).toISOString(), now)).toBe("Jan 3, 07:45");
  });

  it("decides the day in local time, so a message just before midnight is not today's", () => {
    const justAfterMidnight = local(2026, 10, 28, 0, 10);
    expect(formatMessageTime(local(2026, 10, 27, 23, 50).toISOString(), justAfterMidnight)).toBe("Oct 27, 23:50");
    expect(formatMessageTime(local(2026, 10, 28, 0, 5).toISOString(), justAfterMidnight)).toBe("00:05");
  });

  it("takes the instant in milliseconds as well as a date", () => {
    expect(formatMessageTime(local(2026, 10, 28, 9, 5).toISOString(), now.getTime())).toBe("09:05");
  });

  it("answers null for a value that is no time, so no time is drawn", () => {
    expect(formatMessageTime("", now)).toBeNull();
    expect(formatMessageTime("not a time", now)).toBeNull();
    expect(fullMessageTime("not a time")).toBeNull();
  });

  it("gives the whole local date and time for the tooltip", () => {
    expect(fullMessageTime(local(2026, 10, 11, 10, 0, 7).toISOString())).toBe("Oct 11, 2026, 10:00:07");
    expect(fullMessageTime(local(2026, 10, 28, 0, 0, 0).toISOString())).toBe("Oct 28, 2026, 00:00:00");
  });
});
