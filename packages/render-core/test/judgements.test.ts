import { describe, expect, test } from "bun:test";
import { circleRadius, parseOsu } from "@vosu-tools/osu-parse";
import { compileScene } from "../src/scene";
import {
  catchJudgements,
  catcherStates,
  maniaJudgements,
  Marks,
  osuJudgements,
  Profile,
  taikoJudgements,
  taikoNoteResults,
  type JudgementEvent,
} from "../src/judgements";
import type { AtlasRegion, Skin } from "../src/skin";

/** Stand-in atlas regions of the given display sizes. */
const regionsOf = (sizes: Record<string, [number, number, number?]>) =>
  new Map<string, AtlasRegion>(
    Object.entries(sizes).map(([name, [width, height, count]]) => [
      name,
      { u: 0, v: 0, w: 0.1, h: 0.1, width, height, ...(count ? { first: 0, count, stride: 1 } : {}) },
    ]),
  );
interface Instance {
  x: number;
  y: number;
  w: number;
  h: number;
  start: number;
  until: number;
  tint: number[];
  kind: number;
  profile: number;
  p1: number;
  p2: number;
  code: number;
  frames: number;
  fps: number;
}
const decode = (values: ArrayLike<number>): Instance[] => {
  const out: Instance[] = [];
  for (let i = 0; i + 24 <= values.length; i += 24)
    out.push({
      x: values[i],
      y: values[i + 1],
      w: values[i + 2],
      h: values[i + 3],
      start: values[i + 4],
      until: values[i + 7],
      tint: [values[i + 8], values[i + 9], values[i + 10], values[i + 11]],
      kind: values[i + 12],
      profile: values[i + 13],
      p1: values[i + 14],
      p2: values[i + 15],
      code: values[i + 20],
      frames: values[i + 22],
      fps: values[i + 23],
    });
  return out;
};
const event = (e: Partial<JudgementEvent> & Pick<JudgementEvent, "time" | "result">): JudgementEvent => ({
  note: 0,
  x: 0,
  y: 0,
  combo: 1,
  ...e,
});
const fileSkin = (extra: Partial<Skin> = {}): Skin => ({
  name: "test",
  assets: new Map(),
  sections: new Map(),
  version: 2.7,
  ...extra,
});

const OSU =
  "osu file format v14\n[Difficulty]\nCircleSize:4\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,1000,1,0\n192,192,1500,2,0,L|392:192,1,200\n";

describe("osu! judgements", () => {
  const map = parseOsu(OSU);
  const scale = circleRadius(4) / 64;
  const run = (events: JudgementEvent[], sizes: Record<string, [number, number, number?]>, skin = fileSkin()) => {
    const values: number[] = [];
    const judged = osuJudgements({
      map,
      events,
      marks: new Marks(values, regionsOf(sizes)),
      skin,
      colour: () => [0.2, 0.4, 0.6],
      hitLighting: true,
    });
    const below: Instance[] = decode(values);
    judged.below();
    const afterBelow = decode(values);
    judged.above();
    return { below: afterBelow.slice(below.length), above: decode(values).slice(afterBelow.length) };
  };
  test("pieces sit on the judged object at the circle scale, above the objects, lighting beneath", () => {
    const { below, above } = run(
      [event({ time: 1010, result: "great", note: 0, object: "circle", x: 64, y: 192 })],
      { hit300: [120, 60], lighting: [128, 128] },
    );
    expect(below).toHaveLength(1);
    expect(below[0]).toMatchObject({ kind: 35, profile: Profile.lighting, x: 64, y: 192, code: 13 });
    expect(below[0].w).toBeCloseTo(128 * scale);
    expect(below[0].tint).toEqual([0.2, 0.4, 0.6, 1]);
    expect(below[0].until - below[0].start).toBe(1400);
    expect(above).toHaveLength(1);
    expect(above[0]).toMatchObject({ profile: Profile.legacyHit, start: 1010, until: 2110, p2: 1, code: 10 });
    expect(above[0].w).toBeCloseTo(120 * scale);
  });
  test("slider judgements show only with classic behaviour, on the tail; heads always", () => {
    const lazer = run(
      [
        event({ time: 1500, result: "great", note: 1, object: "slider_head", x: 192, y: 192 }),
        event({ time: 1800, result: "great", note: 1, object: "slider", x: 192, y: 192 }),
      ],
      { hit300: [100, 50] },
    );
    expect(lazer.above.map((i) => i.x)).toEqual([192]);
    const classic = run(
      [
        event({ time: 1500, result: "large_tick_hit", note: 1, object: "slider_head", x: 192, y: 192 }),
        event({ time: 1800, result: "great", note: 1, object: "slider", x: 192, y: 192 }),
      ],
      { hit300: [100, 50] },
    );
    // The tail circle ends the slider's single span at x 392 (192 + 200).
    expect(classic.above.map((i) => Math.round(i.x))).toEqual([392]);
  });
  test("misses tilt by at most 8.6° and drop only on skins newer than 1.0", () => {
    const misses = Array.from({ length: 40 }, (_, i) =>
      event({ time: 1000 + i * 37, result: "miss", note: 0, object: "circle", x: 64, y: 192 }),
    );
    const latest = run(misses, { hit0: [80, 80] }).above;
    expect(latest.every((i) => i.profile === Profile.legacyMiss && Math.abs(i.p1) <= (8.6 * Math.PI) / 180)).toBe(true);
    expect(new Set(latest.map((i) => i.p1)).size).toBeGreaterThan(30);
    expect(latest[0].p2).toBeCloseTo(scale);
    expect(run(misses.slice(0, 1), { hit0: [80, 80] }, fileSkin({ version: 1 })).above[0].p2).toBe(0);
  });
  test("particle skins use the new-style piece: particles and the piece beneath, an additive flash above", () => {
    const { below, above } = run(
      [event({ time: 2000, result: "great", note: 0, object: "circle", x: 64, y: 192 })],
      { hit300: [100, 50], particle300: [10, 10] },
    );
    const particles = below.filter((i) => i.profile === Profile.particle);
    expect(particles).toHaveLength(150);
    for (const p of particles) {
      const duration = Math.floor(p.p1 / 8);
      expect(duration).toBeGreaterThanOrEqual(533);
      expect(duration).toBeLessThanOrEqual(1600);
      expect(p.p2).toBeLessThanOrEqual(70 * scale + 1e-4);
    }
    expect(below.at(-1)!.profile).toBe(Profile.newMain);
    expect(above).toEqual([expect.objectContaining({ profile: Profile.newTemporary, code: 13, p2: 1.05 })]);
  });
  test("tick hits use sliderpoint sprites before skin version 2; tick misses their own images", () => {
    const events = [
      event({ time: 1600, result: "large_tick_hit", note: 1, object: "slider_tick", x: 250, y: 192 }),
      event({ time: 1800, result: "slider_tail_hit", note: 1, object: "slider_tail", x: 392, y: 192 }),
      event({ time: 1900, result: "ignore_miss", note: 1, object: "slider_tail", x: 392, y: 192 }),
    ];
    const sizes: Record<string, [number, number]> = { sliderpoint30: [20, 20], sliderpoint10: [12, 12], sliderendmiss: [40, 40] };
    const old = run(events, { ...sizes }, fileSkin({ version: 1 })).above;
    expect(old.map((i) => i.profile)).toEqual([Profile.tickHit, Profile.tickHit, Profile.legacyTickMiss]);
    expect(old[0].until - old[0].start).toBe(360);
    const modern = run(events, { ...sizes }).above;
    expect(modern.map((i) => i.profile)).toEqual([Profile.legacyTickMiss]);
  });
  test("spinner ticks and bonus never show; lazer's own looks draw the default piece beneath", () => {
    const events = [
      event({ time: 3000, result: "small_bonus", object: "spinner_tick" }),
      event({ time: 3000, result: "large_bonus", object: "spinner_bonus" }),
      event({ time: 3100, result: "miss", object: "circle" }),
      event({ time: 3200, result: "ok", object: "circle" }),
    ];
    expect(run(events.slice(0, 2), { hit300: [1, 1] }).above).toEqual([]);
    const { below, above } = run(events, { hit0: [40, 20], hit100: [40, 20] }, fileSkin({ judgements: "default" }));
    expect(above).toEqual([]);
    expect(below.map((i) => [i.profile, i.p1])).toEqual([
      [Profile.defaultPiece, 1],
      [Profile.defaultPiece, 2],
    ]);
  });
});

describe("osu!taiko judgements", () => {
  const events = [
    event({ time: 1000, result: "great", note: 0, object: "hit" }),
    event({ time: 1010, result: "large_bonus", note: 0, object: "strong" }),
    event({ time: 1500, result: "ok", note: 1, object: "hit" }),
    event({ time: 2100, result: "miss", note: 2, object: "hit" }),
    event({ time: 2500, result: "great", note: 3, object: "drumroll" }),
  ];
  const run = (sizes: Record<string, [number, number]>, skin?: Skin) => {
    const values: number[] = [];
    const judged = taikoJudgements({
      events,
      marks: new Marks(values, regionsOf(sizes)),
      skin,
      x: 100,
      y: 50,
      scale: 0.5,
    });
    judged.explosions();
    const explosions = decode(values);
    judged.judgements();
    return { explosions, judgements: decode(values).slice(explosions.length) };
  };
  const all = {
    "taiko-hit300": [150, 150],
    "taiko-hit300k": [180, 180],
    "taiko-hit100": [120, 120],
    "taiko-hit0": [100, 100],
    hit300: [80, 40],
    hit100: [80, 40],
    hit0: [80, 40],
  } as Record<string, [number, number]>;
  test("each hit explodes at the hit target; a strong second hit swaps in the k image", () => {
    const { explosions, judgements } = run(all, fileSkin());
    expect(explosions.map((i) => [i.start, i.w, i.p1, i.p2])).toEqual([
      [1000, 75, 1010, 0],
      [1000, 90, 1010, 1],
      [1500, 60, 0, 0],
      [2100, 50, 0, 0],
    ]);
    expect(explosions.every((i) => i.profile === Profile.taikoExplosion && i.x === 100 && i.y === 50)).toBe(true);
    // The skin brings explosions, so lazer hides its judgements.
    expect(judgements).toEqual([]);
  });
  test("a skin's own hit images show when its explosions are borrowed", () => {
    const borrowed = fileSkin({ fallback: new Set(["taiko-hit300", "taiko-hit300k", "taiko-hit100", "taiko-hit0"]) });
    expect(run(all, borrowed).judgements.map((i) => i.profile)).toEqual([
      Profile.legacyHit,
      Profile.legacyHit,
      Profile.legacyMiss,
    ]);
    const nothingOwn = fileSkin({ fallback: new Set(Object.keys(all)) });
    expect(run(all, nothingOwn).judgements).toEqual([]);
  });
  test("note results: hit or missed, with the strong second hit", () => {
    expect([...taikoNoteResults(events)]).toEqual([
      [0, { time: 1000, hit: true, second: 1010 }],
      [1, { time: 1500, hit: true }],
      [2, { time: 2100, hit: false }],
    ]);
  });
});

describe("osu!mania judgements", () => {
  const images = {
    perfect: "mania-hit300g",
    great: "mania-hit300",
    good: "mania-hit200",
    ok: "mania-hit100",
    meh: "mania-hit50",
    miss: "mania-hit0",
  };
  const sizes = Object.fromEntries(Object.values(images).map((n) => [n, [160, 64]])) as Record<string, [number, number]>;
  const run = (events: JudgementEvent[], skin?: Skin) => {
    const values: number[] = [];
    maniaJudgements({ events, marks: new Marks(values, regionsOf(sizes)), skin, images, x: 256, y: 232, hitY: 400, scale: 1 / 1.6 });
    return decode(values);
  };
  test("one judgement at a time over the stage, at 20 fps, cut by the next", () => {
    const marks = run([
      event({ time: 1000, result: "perfect", object: "note", x: 0 }),
      event({ time: 1000, result: "great", object: "note", x: 1 }),
      event({ time: 1100, result: "miss", object: "note", x: 2 }),
      event({ time: 1200, result: "ok", object: "body", x: 2 }),
      event({ time: 2000, result: "meh", object: "tail", x: 3 }),
    ]);
    expect(marks.map((i) => [i.start, i.until, i.profile])).toEqual([
      [1000, 1100, Profile.maniaHit],
      [1100, 1320, Profile.maniaMiss],
      [2000, 2220, Profile.maniaHit],
    ]);
    expect(marks.every((i) => i.x === 256 && i.y === 232 && i.fps === 0)).toBe(true);
    expect(marks[0].w).toBe(100);
    expect(Math.abs(marks[1].p1)).toBeLessThanOrEqual((5.73 * Math.PI) / 180);
  });
  test("lazer's own looks hang the default piece 180 units above the hit position", () => {
    const [mark] = run([event({ time: 1000, result: "great", object: "note" })], fileSkin({ judgements: "default" }));
    expect(mark).toMatchObject({ profile: Profile.defaultMania, y: 400 - 180 / 1.6 });
  });
});

describe("osu!catch judgements", () => {
  test("hit lighting rides the catcher, clamped to the plate; droplets only glow", () => {
    const values: number[] = [];
    catchJudgements({
      events: [
        event({ time: 1000, result: "great", object: "fruit", x: 290, catcher: 256, combo: 101 }),
        event({ time: 1100, result: "large_tick_hit", object: "droplet", x: 200, catcher: 256, combo: 102 }),
        event({ time: 1200, result: "miss", object: "fruit", x: 0, catcher: 256, combo: 0 }),
      ],
      marks: new Marks(values, regionsOf({ "vosu-catch-explosion-1": [64, 256], "vosu-catch-explosion-2": [8, 64] })),
      catcherY: 364,
      catcherScale: 1,
      colour: () => [1, 0, 0],
      hitLighting: true,
    });
    const marks = decode(values);
    expect(marks.map((i) => [i.start, i.profile])).toEqual([
      [1000, Profile.catchBeam],
      [1000, Profile.catchGlow],
      [1100, Profile.catchGlow],
    ]);
    const half = (106.75 * 0.8) / 2;
    // 34 units right of the catcher, inside the plate: kept, then halved (scale 0.5).
    expect(marks[0].x).toBeCloseTo(34 * 0.5);
    // A combo of 100 before the catch: 16 × (100 / 200) times the image's length.
    expect(marks[0].p1).toBeCloseTo(8);
    // The beam's image is rotated: its height becomes the width.
    expect([marks[0].w, marks[0].h]).toEqual([32, 4]);
    expect(Math.abs(marks[2].x)).toBeLessThanOrEqual((half - 0.3) * 0.5 + 1e-6);
  });
  test("the combo counter pops the previous count, then the new one, and fades on a miss", () => {
    const values: number[] = [];
    const digits = Object.fromEntries(Array.from({ length: 10 }, (_, d) => [`score-${d}`, [20, 30]])) as Record<string, [number, number]>;
    catchJudgements({
      events: [
        event({ time: 1000, result: "great", object: "fruit", combo: 1, note: 0 }),
        event({ time: 1100, result: "small_tick_hit", object: "tiny_droplet", combo: 1 }),
        event({ time: 2000, result: "great", object: "fruit", combo: 2, note: 1 }),
        event({ time: 2100, result: "miss", object: "fruit", combo: 0, note: 2 }),
      ],
      marks: new Marks(values, regionsOf(digits)),
      catcherY: 364,
      catcherScale: 1,
      colour: (note) => [note, 0, 0],
      hitLighting: false,
    });
    const marks = decode(values);
    expect(marks.map((i) => [i.profile, i.start, i.until, i.p1, i.p2])).toEqual([
      [Profile.comboBefore, 1000, 1250, 1000, Infinity],
      [Profile.comboAfter, 1250, 2000, 1000, Infinity],
      [Profile.comboBurst, 1000, 1400, 1000, Infinity],
      // The next change is a miss: the counter fades from 2100 for 400 ms.
      [Profile.comboBefore, 2000, 2250, 2000, 2100],
      [Profile.comboAfter, 2250, 2500, 2000, 2100],
      [Profile.comboBurst, 2000, 2400, 2000, 2100],
    ]);
    expect(marks.every((i) => i.y === 364 - 175 && i.w === 16)).toBe(true);
    expect(marks[2].tint).toEqual([0, 0, 0, 0.65]);
    expect(marks[5].tint).toEqual([1, 0, 0, 0.65]);
  });
  test("catcher states: idle or kiai after catches, fail after misses (bananas excepted)", () => {
    expect(
      catcherStates(
        [
          event({ time: 1, result: "great", object: "fruit" }),
          event({ time: 2, result: "ignore_miss", object: "banana" }),
          event({ time: 3, result: "miss", object: "droplet" }),
          event({ time: 4, result: "great", object: "fruit" }),
        ],
        (time) => time > 3,
      ),
    ).toEqual([
      { time: 1, state: 0 },
      { time: 3, state: 2 },
      { time: 4, state: 1 },
    ]);
  });
});

describe("scenes with a replay's results", () => {
  const TAIKO =
    "osu file format v14\n[General]\nMode: 1\n[Difficulty]\nCircleSize:5\nOverallDifficulty:5\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,1,0\n256,192,1500,1,8\n";
  const sizes = {
    "taiko-hit300": [150, 150],
    "taiko-hit0": [100, 100],
    "taiko-slider": [100, 20],
    taikohitcircle: [128, 128],
    taikohitcircleoverlay: [128, 128],
  } as Record<string, [number, number]>;
  test("previews keep autoplay explosions; replays explode on their results", () => {
    const map = parseOsu(TAIKO);
    const preview = decode(compileScene(map, {}, regionsOf(sizes)).data);
    expect(preview.some((i) => i.kind === 27)).toBe(true);
    expect(preview.some((i) => i.kind === 35)).toBe(false);
    const judged = decode(
      compileScene(
        map,
        {
          judgements: [
            event({ time: 1020, result: "great", note: 0, object: "hit" }),
            event({ time: 1600, result: "miss", note: 1, object: "hit" }),
          ],
        },
        regionsOf(sizes),
      ).data,
    );
    expect(judged.some((i) => i.kind === 27)).toBe(false);
    expect(judged.filter((i) => i.kind === 35).map((i) => i.start)).toEqual([1020, 1600]);
  });
  test("a hit note leaves at its hit, a missed one scrolls on and fades", () => {
    const map = parseOsu(TAIKO);
    const base = decode(compileScene(map, {}, regionsOf(sizes)).data).filter((i) => i.kind === 3);
    const judged = decode(
      compileScene(
        map,
        {
          judgements: [
            event({ time: 1020, result: "great", note: 0, object: "hit" }),
            event({ time: 1600, result: "miss", note: 1, object: "hit" }),
          ],
        },
        regionsOf(sizes),
      ).data,
    );
    const hit = judged.filter((i) => i.kind === 3),
      missed = judged.filter((i) => i.kind === 36);
    expect(hit.map((i) => i.start)).toEqual([1020, 1020]);
    expect(missed.map((i) => [i.start, i.until, i.p1])).toEqual([
      [1600, 1700, 100],
      [1600, 1700, 100],
    ]);
    // Positions keep following the note's own time: x + (anchor - now) × v is unchanged.
    const reference = base.find((i) => i.start === 1000)!,
      shifted = hit[0];
    // Kind 3 carries the velocity in motion.y (decoded as `profile`).
    const at = (i: Instance, now: number) => i.x + (i.start - now) * i.profile;
    expect(at(shifted, 900)).toBeCloseTo(at(reference, 900), 3);
    // Flying hits start at the hit too.
    expect(judged.filter((i) => i.kind === 25).every((i) => i.start === 1020)).toBe(true);
  });
  test("taiko's top area is optional", () => {
    const map = parseOsu(TAIKO);
    const count = (taikoTopArea?: boolean) =>
      decode(compileScene(map, { taikoTopArea }, regionsOf(sizes)).data).filter((i) => i.kind === 23).length;
    expect(count()).toBeGreaterThan(0);
    expect(count(false)).toBe(0);
  });
  test("mania explosions follow results with judgements, key presses without", () => {
    const MANIA =
      "osu file format v14\n[General]\nMode: 3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,1000,1,0\n192,192,1200,1,0\n";
    const regions = regionsOf({ lightingN: [100, 100], "mania-hit300": [100, 40], "mania-hit0": [100, 40] });
    const preview = decode(compileScene(parseOsu(MANIA), {}, regions).data);
    expect(preview.filter((i) => i.kind === 18)).toHaveLength(4);
    const judged = decode(
      compileScene(
        parseOsu(MANIA),
        {
          judgements: [
            event({ time: 1005, result: "great", note: 0, object: "note", x: 0 }),
            event({ time: 1350, result: "miss", note: 1, object: "note", x: 1 }),
          ],
        },
        regions,
      ).data,
    );
    expect(judged.some((i) => i.kind === 18)).toBe(false);
    expect(judged.filter((i) => i.kind === 35).map((i) => [i.profile, i.start])).toEqual([
      [Profile.maniaExplosion, 1005],
      [Profile.maniaHit, 1005],
      [Profile.maniaMiss, 1350],
    ]);
  });
});
