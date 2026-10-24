import { describe, expect, test } from "bun:test";
import { frameRange } from "../src/partition";

describe("native timeline partitions", () => {
  test("cover every frame exactly once including uneven and tiny outputs", () => {
    for (const frames of [1, 2, 7, 60, 2995, 10001]) {
      for (let jobs = 1; jobs <= 8; jobs++) for (const warmup of [false, true]) {
        let previous = 0;
        for (let segment = 0; segment < jobs; segment++) {
          const [first, end] = frameRange(frames, segment, jobs, warmup);
          expect(first).toBe(previous);
          expect(end).toBeGreaterThanOrEqual(first);
          previous = end;
        }
        expect(previous).toBe(frames);
      }
    }
  });
  test("offsets later workers' growing warm-up cost", () => {
    const [first, end] = frameRange(3956, 0, 8, true);
    const [last, finish] = frameRange(3956, 7, 8, true);
    expect(first).toBe(0);
    expect(finish).toBe(3956);
    expect(end - first).toBeGreaterThan(finish - last);
  });
});
