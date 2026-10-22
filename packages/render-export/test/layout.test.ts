import { expect, test } from "bun:test";
import { layoutRects, assertCompatible } from "../src/index";
test("side by side uses every pixel without overlap", () => {
  const r = layoutRects(3, 1920, 1080, "side-by-side", 8);
  expect(r[0].x).toBe(0);
  expect(r[2].x + r[2].width).toBe(1920);
  expect(r[0].x + r[0].width + 8).toBe(r[1].x);
  expect(r.every((v) => v.height === 1080)).toBe(true);
});
test("stacked layout and odd pixel rounding stay bounded", () => {
  const r = layoutRects(3, 1279, 719, "stacked", 7);
  expect(r[2].y + r[2].height).toBe(719);
  expect(r[0].y + r[0].height + 7).toBe(r[1].y);
  expect(r.every((v) => v.width === 1279)).toBe(true);
});
test("grid dimensions and invalid layouts", () => {
  expect(layoutRects(4, 1000, 600, "grid")).toHaveLength(4);
  expect(() => layoutRects(0, 10, 10, "grid")).toThrow();
  expect(() => layoutRects(16, 2, 2, "side-by-side")).toThrow();
});
test("multi replay rates must match even inside one set", () => {
  expect(() =>
    assertCompatible([
      { rate: 1, beatmapHash: "a", mapset: "set" },
      { rate: 1.5, beatmapHash: "b", mapset: "set" },
    ]),
  ).toThrow("rate");
});
test("different difficulties within one mapset are allowed", () => {
  expect(() =>
    assertCompatible([
      { rate: 1, beatmapHash: "a", mapset: "set" },
      { rate: 1, beatmapHash: "b", mapset: "set" },
    ]),
  ).not.toThrow();
  expect(() =>
    assertCompatible([
      { rate: 1, beatmapHash: "a" },
      { rate: 1, beatmapHash: "b" },
    ]),
  ).toThrow("beatmap");
});
