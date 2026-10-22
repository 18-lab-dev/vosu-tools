import { test, expect } from "bun:test";
import {
  parseOsu,
  sliderPath,
  pathPosition,
  applyMods,
  approachTime,
  circleRadius,
  scrollPosition,
  timingAt,
} from "../src";
const fixture = (objects: string, mode = 0) =>
  `osu file format v14\n[General]\nMode:${mode}\nStackLeniency:0.7\n[Metadata]\nTitle:Sample\n[Difficulty]\nCircleSize:4\nApproachRate:9\nOverallDifficulty:8\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,80,1,0\n1000,-50,4,1,0,80,0,0\n[Events]\n0,0,"a,b.jpg",0,0\n2,2000,2500\n[HitObjects]\n${objects}`;
test("sections, timing, slider repeats and holds", () => {
  const m = parseOsu(
    fixture(
      "100,100,1000,2,0,L|380:100,2,280\n256,192,3000,128,0,4000:0:0:0:0:",
      3,
    ),
  );
  expect(m.metadata.Title).toBe("Sample");
  expect(m.breaks).toEqual([[2000, 2500]]);
  expect(m.objects[0].span).toBe(500);
  expect(m.objects[0].endTime).toBe(2000);
  expect(m.objects[0].ticks).toEqual([]);
  expect(m.duration).toBe(4000);
  expect(timingAt(m.timing, 1500).sv).toBe(2);
});
test("linear path trims and extends by declared arc length", () => {
  expect(
    sliderPath(
      "L",
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      50,
    ).at(-1),
  ).toEqual({ x: 50, y: 0 });
  expect(
    sliderPath(
      "L",
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      150,
    ).at(-1),
  ).toEqual({ x: 150, y: 0 });
});
test("perfect arc passes middle on correct side", () => {
  const p = sliderPath("P", [
    { x: 0, y: 0 },
    { x: 50, y: -50 },
    { x: 100, y: 0 },
  ]);
  const mid = pathPosition(p, 0.5);
  expect(mid.x).toBeCloseTo(50, 1);
  expect(mid.y).toBeCloseTo(-50, 1);
});
test("Bezier repeated control points form independent segments", () => {
  const p = sliderPath("B", [
    { x: 0, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ]);
  expect(
    p.some((v) => Math.abs(v.x - 100) < 0.01 && Math.abs(v.y) < 0.01),
  ).toBe(true);
  expect(p.at(-1)).toEqual({ x: 200, y: 0 });
  expect(Math.max(...p.map((v) => v.y))).toBeCloseTo(50, 0);
});
test("Catmull hits endpoints and intermediate controls", () => {
  const p = sliderPath("C", [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 0 },
  ]);
  expect(p[0]).toEqual({ x: 0, y: 0 });
  expect(p.at(-1)).toEqual({ x: 200, y: 0 });
  expect(p.some((v) => v.x === 100 && v.y === 100)).toBe(true);
});
test("stacked circles and slider-tail offsets", () => {
  const m = parseOsu(
    fixture("100,100,1000,1,0\n100,100,1100,1,0\n100,100,1200,1,0"),
  );
  expect(m.objects.map((o) => o.stack)).toEqual([2, 1, 0]);
  const s = parseOsu(
    fixture("100,100,1000,2,0,L|380:100,1,280\n380,100,1550,1,0"),
  );
  expect(s.objects[1].stack).toBe(-1);
});
test("mods preserve input, flip paths, deterministic lane permutation", () => {
  const source = parseOsu(fixture("100,100,1000,2,0,L|200:100,1,100"));
  const hard = applyMods(source, [{ acronym: "HR" }]);
  expect(hard.objects[0].y).toBe(284);
  expect(hard.objects[0].path[1].y).toBe(284);
  expect(source.objects[0].y).toBe(100);
  expect(hard.difficulty.ar).toBe(10);
  const m = parseOsu(
    fixture(
      "64,192,1000,1,0\n192,192,1100,1,0\n320,192,1200,1,0\n448,192,1300,1,0",
      3,
    ),
  );
  const a = applyMods(m, [{ acronym: "RD" }], { seed: 42 }),
    b = applyMods(m, [{ acronym: "RD" }], { seed: 42 });
  expect(a.objects.map((o) => o.x)).toEqual(b.objects.map((o) => o.x));
  expect(new Set(a.objects.map((o) => o.x)).size).toBe(4);
  expect(applyMods(m, [{ acronym: "MR" }]).objects[0].x).toBe(448);
});
test("AR CS formulas, mod rate, and integrated timing seek", () => {
  expect(approachTime(0)).toBe(1800);
  expect(approachTime(5)).toBe(1200);
  expect(approachTime(10)).toBe(450);
  expect(circleRadius(5)).toBeCloseTo(32);
  const m = parseOsu(fixture("100,100,1000,1,0"));
  expect(scrollPosition(m.timing, 1500)).toBe(2000);
  expect(scrollPosition(m.timing, 500)).toBe(500);
  expect(scrollPosition(m.timing, 1500, "taiko")).toBe(2000);
  expect(
    applyMods(m, [{ acronym: "DT", settings: { speed_change: 1.3 } }]).rate,
  ).toBe(1.3);
});
