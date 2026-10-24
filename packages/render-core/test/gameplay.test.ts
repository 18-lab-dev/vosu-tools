import { describe, expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { compileScene, type InputFrame } from "../src/scene";
import { CursorModel, drumFlashes, heldIntervals, isDashing, pressIntervals } from "../src/gameplay";
import { Marks, Profile } from "../src/judgements";
import { shader } from "../src/shader";
import { taikoKiaiGlow, taikoMascot } from "../src/taiko";
import type { AtlasRegion } from "../src/skin";

const regionsOf = (sizes: Record<string, [number, number]>) =>
  new Map<string, AtlasRegion>(
    Object.entries(sizes).map(([name, [width, height]], i) => [name, { u: 0, v: 0, w: 0.1, h: 0.1, width, height, first: i }]),
  );
/** Kind-35 instances written into `values`: [asset entry, time, until, profile, p1, p2, w]. */
const marksOf = (values: number[]) =>
  Array.from({ length: values.length / 24 }, (_, i) => {
    const d = values.slice(i * 24, i * 24 + 24);
    return { x: d[0], y: d[1], w: d[2], h: d[3], time: d[4], until: d[7], kind: d[12], profile: d[13], p1: d[14], p2: d[15], entry: d[21], code: d[20], tint: d.slice(8, 12) };
  });
const frames = (...steps: [number, number, number?, number?][]): InputFrame[] =>
  steps.map(([time, keys, x = 256, y = 192]) => ({ time, keys, x, y }));

const map = (mode: number, objects: string, timing = "0,500,4,1,0,100,1,0", difficulty = "CircleSize:4") =>
  parseOsu(
    `osu file format v14\n[General]\nMode: ${mode}\n[Difficulty]\nHPDrainRate:5\n${difficulty}\nOverallDifficulty:5\nApproachRate:8\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n${timing}\n[HitObjects]\n${objects}\n`,
  );

describe("input helpers", () => {
  test("mania columns are held from the frame that sets their bit to the one that clears it", () => {
    const input = frames([0, 0, 0], [100, 0, 1], [150, 0, 3], [200, 0, 2], [300, 0, 0]);
    expect(pressIntervals(input, 2)).toEqual([
      [{ start: 100, end: 200 }],
      [{ start: 150, end: 300 }],
    ]);
  });
  test("catch dashes only on exactly Left1, as lazer's CatchReplayFrame reads it", () => {
    const input = frames([0, 1], [50, 3], [80, 1], [120, 0]);
    expect(heldIntervals(input, isDashing)).toEqual([
      { start: 0, end: 50 },
      { start: 80, end: 120 },
    ]);
  });
});

describe("osu!taiko input drum", () => {
  test("a press flashes its half; a quick second press starts from the alpha reached", () => {
    const values: number[] = [],
      marks = new Marks(values, regionsOf({ "taiko-drum-inner": [90, 140], "taiko-drum-outer": [100, 150] }));
    // Left centre at 1000 and again 40 ms later; one right rim press.
    drumFlashes(frames([990, 0], [1000, 1], [1020, 0], [1040, 1], [1060, 0], [2000, 8], [2050, 0]), marks, (x) => x, (y) => y, 1, 2.7);
    const out = marksOf(values);
    expect(out.map((m) => [m.time, m.until, m.profile])).toEqual([
      [1000, 1040, Profile.drumFlash],
      [1040, 1190, Profile.drumFlash],
      [2000, 2150, Profile.drumFlash],
    ]);
    // 40 ms into an 80 ms out-quad rise: 0.75.
    expect(out[1].p1).toBeCloseTo(0.75, 6);
    // Right rim: unmirrored, its left edge at 180 - 90.4.
    expect(out[2].w).toBe(100);
    expect(out[2].x - out[2].w / 2).toBeCloseTo(89.6, 6);
    // Left centre: from the drum's left edge.
    expect(out[0].x - out[0].w / 2).toBe(0);
  });
  test("skins before 2.1 use stable's drum positions", () => {
    const values: number[] = [],
      marks = new Marks(values, regionsOf({ "taiko-drum-inner": [90, 140], "taiko-drum-outer": [100, 150] }));
    drumFlashes(frames([0, 1], [10, 2], [20, 4]), marks, (x) => x, (y) => y, 1, 1);
    const [centre, rim, right] = marksOf(values);
    expect([centre.x - 45, centre.y - 70].map((v) => +v.toFixed(6))).toEqual([28.8, 49.6]);
    // The left rim is mirrored (negative width).
    expect(rim.w).toBe(-100);
    expect([rim.x - 50, rim.y - 75].map((v) => +v.toFixed(6))).toEqual([12.8, 36.8]);
    expect(right.x - 45).toBeCloseTo(86.4, 6);
  });
});

describe("osu!taiko kiai glow and mascot", () => {
  const kiaiMap = map(1, "256,192,1000,1,0\n256,192,1500,1,0\n256,192,3000,1,0", "0,500,4,1,0,100,1,0\n800,-100,4,1,0,100,0,1\n2000,-100,4,1,0,100,0,0");
  test("the glow splits at each hit in kiai, carrying the section's ends", () => {
    const values: number[] = [];
    taikoKiaiGlow(kiaiMap, undefined, new Marks(values, regionsOf({ "taiko-glow": [200, 200] })), 0, 0, 1);
    expect(marksOf(values).map((m) => [m.time, m.until, m.p1, m.p2, m.w])).toEqual([
      [800, 1000, 800, 2000, 160],
      [1000, 1500, 800, 2000, 160],
      [1500, 2600, 800, 2000, 160],
    ]);
  });
  test("the mascot idles, kiais per beat and fails after a miss", () => {
    const values: number[] = [];
    const regions = regionsOf({ pippidonidle0: [100, 100], pippidonidle1: [100, 100], pippidonkiai0: [110, 100], pippidonfail0: [120, 100] });
    const entries = new Map([...regions].map(([name, r]) => [r.first, name]));
    taikoMascot(
      kiaiMap,
      [
        { time: 1000, result: "great", note: 0, object: "hit", x: 0, y: 0, combo: 1 },
        { time: 2500, result: "miss", note: 1, object: "hit", x: 0, y: 0, combo: 0 },
      ],
      new Marks(values, regions),
      (x) => x,
      (y) => y,
      1,
      0,
      3000,
    );
    const shown = (t: number) => {
      const m = marksOf(values).find((m) => m.time <= t && t < m.until);
      return m && entries.get(m.entry);
    };
    expect(shown(100)).toBe("pippidonidle0");
    // Beat 1 shows frame 1, beat 2 frame 0 again.
    expect(shown(600)).toBe("pippidonidle1");
    expect(shown(1100)).toBe("pippidonkiai0");
    expect(shown(2100)).toBe("pippidonidle0");
    expect(shown(2600)).toBe("pippidonfail0");
    // Bottom-left at 0.2 of the playfield's height, 0.6 scale.
    const first = marksOf(values)[0];
    expect([first.x - first.w / 2, first.y + first.h / 2, first.w]).toEqual([0, 40, 60]);
  });
});

describe("osu!catch from a replay", () => {
  const catchMap = map(2, "256,192,1000,5,0\n100,192,1500,1,0\n256,192,2200,5,0");
  const regions = regionsOf({ "fruit-catcher-idle": [300, 320], "fruit-pear": [128, 128], "fruit-grapes": [128, 128], "fruit-apple": [128, 128] });
  test("dashing leaves a trail every 60 Hz frame; walking leaves none", () => {
    const input = frames([0, 0, 256], [1000, 0, 256], [1100, 1, 200], [1200, 1, 150], [1250, 0, 140], [1500, 0, 100], [2200, 0, 256]);
    const scene = compileScene(catchMap, { input }, regions);
    const trails = Array.from({ length: scene.count }, (_, i) => scene.data.slice(i * 24, i * 24 + 24)).filter(
      (d) => d[12] === 35 && d[13] === Profile.catcherTrail,
    );
    // 1100 to the release at 1250 (exclusive), on the 1000/60 grid.
    expect(trails.length).toBe(9);
    expect(trails[0][4]).toBeCloseTo(1100, 3);
    expect(trails.every((d) => d[8] === 1 && d[20] === 13)).toBe(true);
    // Moving left: mirrored.
    expect(trails.every((d) => d[2] < 0)).toBe(true);
  });
  test("the combo's end explodes a caught plate and drops a missed one", () => {
    const input = frames([0, 0, 256], [1500, 0, 100], [2200, 0, 256]);
    const exploded = compileScene(catchMap, { input }, regions);
    const offPlate = (scene: typeof exploded) =>
      Array.from({ length: scene.count }, (_, i) => scene.data.slice(i * 24, i * 24 + 24)).filter(
        (d) => d[12] === 35 && (d[13] === Profile.plateDrop || d[13] === Profile.plateExplode),
      );
    expect(offPlate(exploded).map((d) => [d[4], d[13]])).toEqual([
      [1500, Profile.plateExplode],
      [1500, Profile.plateExplode],
    ]);
    const missed = compileScene(catchMap, {
      input,
      judgements: [
        { time: 1000, result: "great", note: 0, object: "fruit", x: 256, y: 0, combo: 1 },
        { time: 1500, result: "miss", note: 1, object: "fruit", x: 100, y: 0, combo: 0 },
      ],
    }, regions);
    expect(offPlate(missed).map((d) => [d[4], d[13]])).toEqual([[1500, Profile.plateDrop]]);
  });
});

describe("osu!mania from a replay", () => {
  test("each press lights its column until the release, then fades", () => {
    const m = map(3, "64,192,1000,1,0\n448,192,1200,1,0", "0,500,4,1,0,100,1,0", "CircleSize:4");
    const scene = compileScene(m, { input: frames([0, 0, 0], [1000, 0, 1], [1080, 0, 0], [1200, 0, 8], [1300, 0, 0]) }, regionsOf({ "mania-stage-light": [40, 300] }));
    const lights = Array.from({ length: scene.count }, (_, i) => scene.data.slice(i * 24, i * 24 + 24)).filter(
      (d) => d[12] === 35 && d[13] === Profile.columnLight,
    );
    expect(lights.map((d) => [d[4], d[7], d[14], d[20]])).toEqual([
      [1000, 1330, 1080, 40],
      [1200, 1550, 1300, 40],
    ]);
  });
});

describe("osu! cursor", () => {
  const skin = (middle: boolean) => ({
    size: (asset: string) =>
      (({ cursor: [60, 60], cursortrail: [30, 30], ...(middle ? { cursormiddle: [20, 20] } : {}) }) as Record<string, [number, number]>)[asset],
    centre: true,
    rotate: true,
    expand: true,
    trailRotate: true,
  });
  test("presses expand the cursor to 1.3 over 100 ms; releasing all buttons contracts it", () => {
    const model = new CursorModel(frames([0, 0], [1000, 5], [1050, 0], [1200, 10], [1300, 15], [1400, 0]), skin(true));
    expect(model.scaleAt(999)).toBe(1);
    expect(model.scaleAt(1049.999)).toBeCloseTo(1 + 0.3 * (1 - 0.5 ** 2), 3);
    expect(model.scaleAt(1299.999)).toBeCloseTo(1.3, 3);
    // Released at 1050 halfway: contracts from 1.225.
    expect(model.scaleAt(1050)).toBeCloseTo(1.225, 9);
    expect(model.scaleAt(1150)).toBeCloseTo(1, 9);
    // A second button pressed while one is down expands again from 1.
    expect(model.scaleAt(1300)).toBe(1);
    expect(model.rotationAt(2500)).toBeCloseTo(Math.PI / 2, 9);
  });
  test("with cursormiddle the trail lays parts along the path and fades them over 500 ms", () => {
    const model = new CursorModel(frames([0, 0, 0, 0], [500, 0, 500, 0]), skin(true));
    const sprites = model.sprites(500, 1, 511);
    const parts = sprites.filter((s) => s.asset === "cursortrail");
    // Every 30 / 1.6 / 2.5 = 7.5 units, the newest one interval behind the cursor.
    expect(parts[1].x - parts[0].x).toBeCloseTo(7.5, 6);
    expect(parts.at(-1)!.x).toBeLessThan(500 - 7.5 + 1e-6);
    expect(parts.every((p) => p.additive)).toBe(true);
    expect(parts[0].alpha).toBeCloseTo(1 - (500 - parts[0].x) / 500, 6);
    expect(sprites.slice(-2).map((s) => s.asset)).toEqual(["cursor", "cursormiddle"]);
  });
  test("without cursormiddle a part every 1/60 s fades over 150 ms", () => {
    const model = new CursorModel(frames([0, 0, 0, 0], [1000, 0, 1000, 0]), skin(false));
    const parts = model.sprites(500, 1, 511).filter((s) => s.asset === "cursortrail");
    expect(parts.length).toBe(9);
    expect(parts.every((p) => !p.additive && p.alpha > 0 && p.alpha <= 1)).toBe(true);
  });
});

test("the osu! playfield shift moves only the drawn position, from a uniform", () => {
  expect(shader).toContain("extra:vec4f");
  expect(shader).toContain("let screen=(point+vec2f(0.0,select(0.0,g.extra.x,mode==0u))-vec2f(256.0,192.0))*scale;");
});
