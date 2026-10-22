import { expect, test } from "bun:test";
import { parseOsu, taikoVelocity, scrollPosition } from "../src";
const map = parseOsu(
  "[General]\nMode:1\n[Difficulty]\nSliderMultiplier:1.4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-50,4,1,0,100,0,0\n2000,250,3,1,0,100,1,0",
);
test("taiko velocity includes native 1.4 multiplier, BPM, inherited SV and note speed", () => {
  expect(taikoVelocity(map, 500)).toBeCloseTo(0.392);
  expect(taikoVelocity(map, 1500)).toBeCloseTo(0.784);
  expect(taikoVelocity(map, 2500)).toBeCloseTo(0.784);
  expect(taikoVelocity(map, 2500, 1.5)).toBeCloseTo(1.176);
});
test("mania SV integral is continuous across red and green points and reversible seeks", () => {
  expect(scrollPosition(map.timing, 999)).toBe(999);
  expect(scrollPosition(map.timing, 1000)).toBe(1000);
  expect(scrollPosition(map.timing, 1500)).toBe(2000);
  expect(scrollPosition(map.timing, 2000)).toBe(3000);
  expect(scrollPosition(map.timing, 2500)).toBe(3500);
  expect(scrollPosition(map.timing, 500)).toBe(500);
});
test("taiko integral also accounts for BPM changes", () => {
  expect(scrollPosition(map.timing, 2500, "taiko")).toBe(4000);
});
