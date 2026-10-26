import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { catchObjects } from "@vosu-tools/ruleset-convert";
import {
  MANIA_KEYS,
  demoLoop,
  demos,
  maniaDemo,
  maniaStill,
  repeatOsu,
} from "../src";

const CIRCLE = 1,
  SLIDER = 2,
  NEW_COMBO = 4,
  SPINNER = 8,
  HOLD = 128;

test("every demo is a valid one-period map of 8-12 s", () => {
  for (const d of demos) {
    const map = parseOsu(d.osu);
    expect(map.mode).toBe(d.ruleset);
    expect(d.period).toBeGreaterThanOrEqual(8000);
    expect(d.period).toBeLessThanOrEqual(12000);
    expect(map.objects.length).toBeGreaterThan(8);
    for (const o of map.objects) {
      expect(o.time).toBeGreaterThanOrEqual(0);
      expect(o.time).toBeLessThan(d.period);
    }
    if (d.keys) expect(map.difficulty.cs).toBe(d.keys);
  }
});

test("repeating shifts objects, spinner/hold ends and timing points", () => {
  const text = [
    "[TimingPoints]",
    "0,500,4,2,0,60,1,0",
    "800,-100,4,2,0,60,0,1",
    "",
    "[HitObjects]",
    "64,192,100,128,0,400:0:0:0:0:",
    "256,192,500,12,0,900,0:0:0:0:",
  ].join("\n");
  const out = repeatOsu(text, 1000, 3);
  expect(out).toContain("1800,-100,4,2,0,60,0,1");
  expect(out).toContain("64,192,2100,128,0,2400:0:0:0:0:");
  expect(out).toContain("256,192,1500,12,0,1900,0:0:0:0:");
  expect(out.match(/,128,/g)?.length).toBe(3);
});

test("loops are periodic, combo colours included", () => {
  for (const d of demos) {
    const { beatmap, start, length } = demoLoop(d.id);
    expect(start).toBe(d.period);
    expect(length).toBe(d.period);
    const n = beatmap.objects.length / 3;
    expect(Number.isInteger(n)).toBe(true);
    for (let i = 0; i < n; i++) {
      const a = beatmap.objects[i],
        b = beatmap.objects[i + n],
        c = beatmap.objects[i + 2 * n];
      expect(b.time - a.time).toBe(d.period);
      expect(c.time - b.time).toBe(d.period);
      expect(b.endTime - a.endTime).toBe(d.period);
      expect([b.x, b.y, b.type & ~NEW_COMBO, b.combo, b.number]).toEqual([
        a.x,
        a.y,
        a.type & ~NEW_COMBO,
        a.combo,
        a.number,
      ]);
      expect(c.combo).toBe(a.combo);
    }
  }
});

test("osu! has numbered circles, a repeating slider with ticks and a spinner", () => {
  const map = parseOsu(demos.find((d) => d.id === "osu")!.osu);
  const slider = map.objects.find((o) => o.type & SLIDER)!;
  expect(slider.repeats).toBeGreaterThanOrEqual(1);
  expect(slider.ticks.length).toBeGreaterThan(0);
  expect(map.objects.some((o) => o.type & SPINNER)).toBe(true);
  expect(map.objects.filter((o) => o.type & CIRCLE).length).toBeGreaterThan(5);
  expect(Math.max(...map.objects.map((o) => o.number))).toBeGreaterThanOrEqual(
    4,
  );
});

test("taiko has every note type, a kiai section and barlines", () => {
  const map = parseOsu(demos.find((d) => d.id === "taiko")!.osu);
  const hits = map.objects.filter((o) => o.type & CIRCLE);
  const rim = (o: { sound: number }) => (o.sound & (2 | 8)) !== 0,
    big = (o: { sound: number }) => (o.sound & 4) !== 0;
  expect(hits.some((o) => !rim(o) && !big(o))).toBe(true);
  expect(hits.some((o) => rim(o) && !big(o))).toBe(true);
  expect(hits.some((o) => !rim(o) && big(o))).toBe(true);
  expect(hits.some((o) => rim(o) && big(o))).toBe(true);
  const rolls = map.objects.filter((o) => o.type & SLIDER);
  expect(rolls.some((o) => !big(o)) && rolls.some(big)).toBe(true);
  expect(map.objects.some((o) => o.type & SPINNER)).toBe(true);
  expect(map.timing.some((t) => t.effects & 1)).toBe(true);
  expect(map.timing.find((t) => t.uninherited)!.meter).toBe(4);
});

test("catch has a juice stream, a hyper-dash and a banana shower, off screen at the seam", () => {
  const { beatmap, start } = demoLoop("fruits");
  const objects = catchObjects(beatmap);
  const kinds = new Set(objects.map((o) => o.kind));
  for (const kind of ["fruit", "droplet", "tiny", "banana"] as const)
    expect(kinds.has(kind)).toBe(true);
  expect(objects.some((o) => o.hyper)).toBe(true);
  // AR 8 shows fruits 600 ms early; nothing may be falling at either seam.
  for (const seam of [start, 2 * start])
    expect(
      objects.some((o) => o.time > seam - 300 && o.time < seam + 650),
    ).toBe(false);
});

test("mania covers 1K-10K with notes, long notes, a long-note chord and a long hold", () => {
  expect(demos.filter((d) => d.ruleset === 3).map((d) => d.keys)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  for (const keys of MANIA_KEYS) {
    const id = maniaDemo(keys)!;
    const map = parseOsu(demos.find((d) => d.id === id)!.osu);
    expect(map.difficulty.cs).toBe(keys);
    const column = (o: { x: number }) => Math.floor((o.x * keys) / 512);
    const holds = map.objects.filter((o) => o.type & HOLD);
    expect(map.objects.some((o) => o.type & CIRCLE)).toBe(true);
    expect(
      Math.max(...holds.map((o) => o.endTime - o.time)),
    ).toBeGreaterThanOrEqual(2500);
    if (keys > 1) {
      const starts = holds.map((o) => o.time);
      expect(starts.some((t, i) => starts.indexOf(t) !== i)).toBe(true);
    }
    expect(new Set(map.objects.map(column)).size).toBe(keys);
    // No column ever has two objects at once (a tap inside a hold, or two taps).
    for (let c = 0; c < keys; c++) {
      const own = map.objects
        .filter((o) => column(o) === c)
        .sort((a, b) => a.time - b.time);
      for (let i = 1; i < own.length; i++)
        expect(own[i].time).toBeGreaterThan(
          Math.max(own[i - 1].time, own[i - 1].endTime),
        );
    }
  }
  expect(maniaDemo(14)).toBeUndefined();
});

test("the still stage shows a hold and a note in every column", () => {
  for (const keys of [1, 4, 7, 10]) {
    const map = maniaStill(keys);
    expect(map.difficulty.cs).toBe(keys);
    for (let column = 0; column < keys; column++) {
      const objects = map.objects.filter(
        (o) => Math.floor((o.x * keys) / 512) === column,
      );
      expect(objects.map((o) => [o.time, o.endTime])).toEqual([
        [150, 450],
        [600, 600],
      ]);
    }
  }
});
