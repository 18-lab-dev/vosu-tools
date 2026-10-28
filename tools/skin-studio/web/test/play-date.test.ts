import { describe, expect, test } from "bun:test";
import { playDate } from "../src/play-date";

describe("last-play local dates", () => {
  const now = Date.parse("2026-10-27T21:00:00Z");
  test("stable milliseconds and lazer UTC date agree", () => {
    expect(playDate(now - 600000, 0, now)).toEqual(playDate("2026-10-27T20:50:00Z", 0, now));
    const date = playDate(now - 600000, 0, now);
    expect(date.relative).toBe("10 min ago");
    expect(date.absolute).toContain("2026");
    expect(date.stale).toBe(false);
  });
  test("ages of 48 h or more read in days", () => {
    expect(playDate(now - (47 * 60 + 59) * 60000, 0, now).relative).toBe("47 h 59 min ago");
    expect(playDate(now - 48 * 3600000, 0, now).relative).toBe("2 days ago");
    // The review's play: 563 h 57 min old.
    expect(playDate(now - (563 * 60 + 57) * 60000, 0, now).relative).toBe("23 days ago");
  });
  test("hour-old and regressing session dates are conspicuous", () => {
    expect(playDate(now - 3600000, 0, now).stale).toBe(true);
    expect(playDate(now - 1000, now, now).stale).toBe(true);
  });
  test("missing date is never presented as fresh", () => {
    expect(playDate("", 0, now).relative).toBe("date unavailable");
    expect(playDate("", 0, now).stale).toBe(true);
  });
});
