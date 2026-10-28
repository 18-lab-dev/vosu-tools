import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import type { Simulation } from "@vosu-tools/replay";
import {
  DEFAULT_SCROLL_LENGTH,
  LEGACY_SCALE,
  calibratedHitPosition,
  hitPositionPixels,
  noteVelocity,
  offsets,
  receptorShift,
  BODY_UNITS,
  holdPlan,
} from "../src/calibrate";

test("5 HitPosition units are 8 px, 16 px in @2x images", () => {
  expect(LEGACY_SCALE).toBe(1.6);
  expect(hitPositionPixels(5, false)).toBe(8);
  expect(hitPositionPixels(5, true)).toBe(16);
  // Lower HitPosition: receptors move up (positive rows); 1x rounds.
  expect(receptorShift(402, 397, false)).toEqual({ rows: 8, exact: 8 });
  expect(receptorShift(402, 401, false).rows).toBe(2);
  expect(receptorShift(402, 401, true).rows).toBe(3);
  expect(receptorShift(397, 402, true).rows).toBe(-16);
});

const map = (timing: string) =>
  parseOsu(
    `osu file format v14\n[General]\nMode: 3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[TimingPoints]\n${timing}\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n64,192,90000,1,0,0:0:0:0:\n`,
  );

test("speed formulas: lazer's 11485 ms time range, scaled by beat length and SV", () => {
  // One BPM: the multiplier is 1 and the speed is the scroll length over 11485 / speed.
  const plain = map("0,500,4,2,0,60,1,0");
  expect(DEFAULT_SCROLL_LENGTH).toBeCloseTo(643.2);
  expect(noteVelocity(plain, 5000, { client: "lazer", speed: 24 })).toBeCloseTo((643.2 * 24) / 11485);
  // A section at twice the BPM moves twice as fast (lazer; stable with BPM scaling)...
  const doubled = map("0,500,4,2,0,60,1,0\n80000,250,4,2,0,60,1,0");
  const base = (643.2 * 24) / 11485;
  expect(noteVelocity(doubled, 85000, { client: "lazer", speed: 24 })).toBeCloseTo(2 * base);
  expect(noteVelocity(doubled, 85000, { client: "stable", speed: 24, bpmScale: true })).toBeCloseTo(2 * base);
  // ...but not on stable with BPM scaling off; slider velocity always counts.
  expect(noteVelocity(doubled, 85000, { client: "stable", speed: 24, bpmScale: false })).toBeCloseTo(base);
  const sv = map("0,500,4,2,0,60,1,0\n3000,-50,4,2,0,60,0,0");
  expect(noteVelocity(sv, 4000, { client: "lazer", speed: 24 })).toBeCloseTo(2 * base);
});

const simulation = (events: { object: string; offset: number; time: number; kind?: string }[]): Simulation =>
  ({ events: events.map((e) => ({ ...e, timed: true, result: null, x: 0, y: 0, note: 0, combo: 0, counts: {}, accuracy: 1 })),
    releases: events.filter((e) => e.object === "tail").map((e) => ({ note: 0, time: e.time, offset: e.offset, hit: e.kind !== "miss", veryLate: false })),
  }) as unknown as Simulation;

test("early presses lower receptors, late presses raise them to correct timing", () => {
  const plain = map("0,500,4,2,0,60,1,0");
  // Pressed 10 ms early (map time) at 1.5× rate: 6.67 ms early in real time.
  const sim = simulation([
    { object: "note", offset: -10, time: 990 },
    { object: "head", offset: -10, time: 1990 },
    { object: "tail", offset: 30, time: 2530 },
    { object: "note", offset: 99, time: 3099, kind: "miss" },
  ]);
  const press = offsets(sim, plain, "press", { client: "lazer", speed: 24 }, 1.5);
  expect(press.count).toBe(2);
  expect(press.mean).toBeCloseTo(-10 / 1.5);
  expect(press.distance).toBeCloseTo((-10 / 1.5) * ((643.2 * 24) / 11485));
  expect(press.distance).toBeLessThan(0);
  // −8.96 lazer units corrects DOWN by 5.6 HitPosition units: 402 → 408.
  expect(calibratedHitPosition(402, press)).toBe(408);
  expect(calibratedHitPosition(402, { ...press, distance: -press.distance })).toBe(396);
  expect(calibratedHitPosition(402, { ...press, distance: 0 })).toBe(402);
  expect(calibratedHitPosition(250, { ...press, distance: 100 })).toBe(240);
  expect(calibratedHitPosition(470, { ...press, distance: -100 })).toBe(480);
  const release = offsets(sim, plain, "release", { client: "lazer", speed: 24 }, 1);
  expect(release.count).toBe(1);
  expect(release.mean).toBe(30);
});

test("correcting hold ends: early gap, late percy conversion, both percy directions", () => {
  const release = (distance: number) => ({ count: 100, mean: distance, spread: 1, velocity: 1, distance });
  // A 128 px wide cap of 40 rows drawn 64 units wide: 2 rows per unit.
  const normal = { capRows: 40, tailWidth: 128, bodyHeight: 64, bodyTop: 0, noteWidth: 64, percy: false };
  expect(holdPlan(release(-5), normal)).toMatchObject({ kind: "gap", gap: 10 });
  // Late by 5 units shortens by 10 image rows, using the existing percy path.
  const late = holdPlan(release(5), normal);
  expect(late).toMatchObject({ kind: "percy", spacer: 60, capBottom: 40, height: BODY_UNITS * 2 });
  if (late.kind === "percy") expect(late.capBottom - normal.capRows).toBeGreaterThanOrEqual(0);
  // The user's set: blank 1-row tail, 40000-row body with 46 clear rows.
  const percy = { capRows: 0, tailWidth: 128, bodyHeight: 40000, bodyTop: 46, noteWidth: 112, percy: true };
  expect(holdPlan(release(10), percy)).toMatchObject({ kind: "shift-body", up: -12 });
  expect(holdPlan(release(-100), percy)).toMatchObject({ kind: "shift-body", up: 46 });
  expect(holdPlan(release(0), normal).kind).toBe("none");
  expect(holdPlan(release(0), percy).kind).toBe("none");
  expect(holdPlan(release(0.2), normal).kind).toBe("none");
});

test("hold-end notes count rows in the singular for one row", () => {
  const release = (distance: number) => ({ count: 100, mean: distance, spread: 1, velocity: 1, distance });
  // 2 rows per unit: early by half a unit lengthens by 1 row; late by half a unit shortens by 1.
  const normal = { capRows: 40, tailWidth: 128, bodyHeight: 64, bodyTop: 0, noteWidth: 64, percy: false };
  expect(holdPlan(release(-0.5), normal).note).toBe("early releases: lengthen the hold with 1 row before its cap");
  expect(holdPlan(release(0.5), normal).note).toContain("the cap's bottom edge 1 row before the end time");
  const percy = { capRows: 0, tailWidth: 128, bodyHeight: 40000, bodyTop: 1, noteWidth: 112, percy: true };
  expect(holdPlan(release(-100), percy).note).toBe("percy holds (blank tail): the body's end moves up 1 row (early: longer), limited to its 1 clear row");
});
