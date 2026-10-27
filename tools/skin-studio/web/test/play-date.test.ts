import { describe, expect, test } from "bun:test";
import { playDate } from "../src/play-date";

describe("last-play local dates", () => {
  const now = Date.parse("2026-10-27T21:00:00Z");
  test("stable milliseconds and lazer UTC date agree", () => {
    expect(playDate(now - 600000, 0, now)).toEqual(playDate("2026-10-27T20:50:00Z", 0, now));
    const date = playDate(now - 600000, 0, now);
    expect(date.text).toContain("10 min ago");
    expect(date.text).toContain("2026");
    expect(date.stale).toBe(false);
  });
  test("hour-old and regressing session dates are conspicuous", () => {
    expect(playDate(now - 3600000, 0, now).text).toContain("Older play:");
    expect(playDate(now - 1000, now, now).stale).toBe(true);
  });
  test("missing date is never presented as fresh", () => {
    expect(playDate("", 0, now).text).toContain("date unavailable");
    expect(playDate("", 0, now).stale).toBe(true);
  });
});
