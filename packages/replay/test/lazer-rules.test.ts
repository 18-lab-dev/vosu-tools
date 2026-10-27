import { afterAll, describe, expect, test } from "bun:test";
import { applyMods, NetRandom, parseOsu } from "../../osu-parse/src/index";
import {
  healthDeviation,
  judgeReplay,
  maniaHitWindows,
  replayHealth,
  replayPitched,
  replayRate,
  simulateHealth,
  simulateMania,
  simulateTaiko,
  taikoHitWindows,
  type Outcome,
  type Replay,
  type ReplayFrame,
  type Simulation,
} from "../src/index";
afterAll(() => {
  globalThis.onmessage = null;
});

const LAZER = 30000019;
const replayOf = (mode: 1 | 3, frames: ReplayFrame[], mods: Replay["lazer"] = null): Replay => ({
  mode,
  version: LAZER,
  beatmapHash: "",
  player: "test",
  replayHash: "",
  counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 },
  score: 0,
  maxCombo: 0,
  perfect: false,
  mods: 0,
  life: [],
  timestamp: 0n,
  onlineId: 0n,
  frames,
  seed: null,
  rate: 1,
  lazer: mods,
});
const lazerMods = (mods: { acronym: string; settings?: Record<string, unknown> }[]): Replay["lazer"] => ({
  mods,
  statistics: {},
  maximumStatistics: {},
  clientVersion: "2026.1005.0-lazer",
  totalScoreWithoutMods: null,
});
const map = (mode: 1 | 3, objects: string, difficulty = "HPDrainRate:5\nCircleSize:4\nOverallDifficulty:8") =>
  parseOsu(`osu file format v14

[General]
Mode: ${mode}

[Difficulty]
${difficulty}
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${objects}
`);
/** Mania frames: `x` holds the pressed columns. */
const keys = (...steps: [number, number][]): ReplayFrame[] => steps.map(([time, x]) => ({ time, x, y: 0, keys: 0 }));
const taikoKeys = (...steps: [number, number][]): ReplayFrame[] => steps.map(([time, keys]) => ({ time, x: 0, y: 0, keys }));

describe("lazer mania rules", () => {
  test("hit windows follow OD, Classic, Hard Rock and rate", () => {
    expect(maniaHitWindows(8)).toEqual([16.5, 40.5, 73.5, 103.5, 127.5, 164.5]);
    // Classic keeps stable's fixed perfect window; lazer's grows at low OD.
    expect(maniaHitWindows(0)[0]).toBe(22.5);
    expect(maniaHitWindows(0, { classic: true })).toEqual([16.5, 64.5, 97.5, 127.5, 151.5, 188.5]);
    expect(maniaHitWindows(8, { difficulty: 1.4 })[1]).toBe(28.5);
    expect(maniaHitWindows(8, { rate: 1.5 })[1]).toBe(60.5);
  });

  test("Classic with ScoreV2 uses modern windows for heads and tails", () => {
    // ManiaHitWindows.updateWindows: Classic is conditional on !ScoreV2Active.
    // https://github.com/ppy/osu/blob/97e94babde9d5ecbe574ecdd33509db27452cd0f/osu.Game.Rulesets.Mania/Scoring/ManiaHitWindows.cs#L134-L169
    expect(maniaHitWindows(0, { classic: true, scoreV2: true })).toEqual(maniaHitWindows(0));
    expect(maniaHitWindows(0, { classic: true, scoreV2: true, convert: true, rate: 1.5, difficulty: 1.4 }))
      .toEqual(maniaHitWindows(0, { rate: 1.5, difficulty: 1.4 }));
    const chart = map(3, "64,192,1000,128,0,2000:0:0:0:0:", "CircleSize:4\nOverallDifficulty:0");
    const frames = keys([1020, 1], [2028, 0], [2400, 0]);
    const classic = simulateMania(replayOf(3, frames, lazerMods([{ acronym: "CL" }])), chart);
    const scoreV2 = simulateMania(replayOf(3, frames, lazerMods([{ acronym: "CL" }, { acronym: "SV2" }])), chart);
    expect(classic.events.filter((e) => e.object === "head" || e.object === "tail").map((e) => e.kind)).toEqual(["great", "great"]);
    expect(scoreV2.events.filter((e) => e.object === "head" || e.object === "tail").map((e) => e.kind)).toEqual(["perfect", "perfect"]);
  });

  // A note in column 0, a hold in column 1, a note in column 2.
  const MANIA = map(3, "64,192,1000,1,0,0:0:0:0:\n192,192,2000,128,0,2500:0:0:0:0:\n320,192,3000,1,0,0:0:0:0:");

  test("notes, a hold's head and tail, and a timed-out note", () => {
    const replay = replayOf(3, keys([1010, 1], [1100, 0], [1970, 2], [2520, 0], [4000, 0]));
    const simulation = simulateMania(replay, MANIA);
    expect(simulation.statistics).toEqual({ perfect: 2, great: 1, ignore_hit: 2, miss: 1 });
    expect(simulation.events.map((e) => `${e.object}:${e.kind}`)).toEqual([
      "note:perfect",
      "head:great",
      "tail:perfect",
      "note:miss",
    ]);
    // Combo 3 before the miss: the body's ignore_hit never counts.
    expect(Math.max(...simulation.events.map((e) => e.combo))).toBe(3);
  });

  test("a dropped hold breaks combo and caps the tail at meh", () => {
    const replay = replayOf(3, keys([1000, 1], [1050, 0], [2000, 2], [2200, 0], [2400, 2], [2505, 0], [4000, 0]));
    const simulation = simulateMania(replay, MANIA);
    const kinds = simulation.events.map((e) => `${e.object}:${e.kind}`);
    expect(kinds).toContain("body:combo_break");
    expect(kinds).toContain("tail:meh");
  });

  test("No Release judges a hold kept down through its end as perfect", () => {
    const frames = keys([1000, 1], [1050, 0], [2000, 2], [3200, 0], [4000, 0]);
    const plain = simulateMania(replayOf(3, frames), MANIA);
    const held = simulateMania(replayOf(3, frames, lazerMods([{ acronym: "NR" }])), MANIA);
    expect(plain.events.find((e) => e.object === "tail")?.kind).toBe("miss");
    expect(held.events.find((e) => e.object === "tail")?.kind).toBe("perfect");
  });

  test("Invert turns gaps into holds and Hold Off turns holds into notes", () => {
    const column = map(3, "64,192,1000,1,0,0:0:0:0:\n64,192,2000,1,0,0:0:0:0:\n64,192,3000,128,0,3600:0:0:0:0:");
    const inverted = applyMods(column, [{ acronym: "IN" }]);
    // Gaps of 1000 ms at 500 ms beats: the hold ends a quarter beat before the next start.
    expect(inverted.objects.map((o) => [o.time, o.endTime, o.type & 128])).toEqual([
      [1000, 1875, 128],
      [2000, 2875, 128],
    ]);
    const held = applyMods(column, [{ acronym: "HO" }]);
    expect(held.objects.map((o) => [o.time, o.type & 128])).toEqual([
      [1000, 0],
      [2000, 0],
      [3000, 0],
    ]);
  });
});

describe("lazer taiko rules", () => {
  test("hit windows", () => {
    expect(taikoHitWindows(5)).toEqual([34.5, 79.5, 94.5]);
  });

  // Centre, rim, big centre, then two centres 40 ms apart.
  const TAIKO = map(
    1,
    "256,192,1000,1,0,0:0:0:0:\n256,192,1500,1,2,0:0:0:0:\n256,192,2000,1,4,0:0:0:0:\n256,192,3000,1,0,0:0:0:0:\n256,192,3040,1,0,0:0:0:0:",
    "HPDrainRate:5\nCircleSize:5\nOverallDifficulty:5",
  );
  test("colours, strong second hits and presses swallowed in one frame", () => {
    const replay = replayOf(
      1,
      taikoKeys(
        [1010, 1],
        [1100, 0],
        [1490, 1], // centre on a rim: miss
        [1600, 0],
        [2000, 1],
        [2010, 5], // second centre within 30 ms: strong bonus
        [2100, 0],
        [3000, 5], // both centres at once: the second press goes nowhere
        [3020, 0],
        [3045, 4],
        [3100, 0],
      ),
    );
    const simulation = simulateTaiko(replay, TAIKO);
    // Without the swallowed press the 3040 note would be an early ok.
    expect(simulation.statistics).toEqual({ great: 4, miss: 1, large_bonus: 1 });
  });
});

describe("mods on the map", () => {
  const MANIA = map(3, "64,192,1000,1,0,0:0:0:0:", "HPDrainRate:5\nCircleSize:4\nOverallDifficulty:8");
  test("Hard Rock and Easy per ruleset", () => {
    const hr = applyMods(MANIA, [{ acronym: "HR" }]).difficulty;
    // Mania keeps OD and key count; its windows shrink instead.
    expect([hr.od, hr.cs, hr.hp]).toEqual([8, 4, 7]);
    const taiko = applyMods(map(1, "256,192,1000,1,0,0:0:0:0:"), [{ acronym: "HR" }]).difficulty;
    expect(taiko.od).toBeCloseTo(10);
    expect(taiko.sliderMultiplier).toBeCloseTo((1.4 * 1.4 * 4) / 3);
    const ez = applyMods(map(1, "256,192,1000,1,0,0:0:0:0:"), [{ acronym: "EZ" }]).difficulty;
    expect([ez.od, ez.hp]).toEqual([4, 2.5]);
  });
  test("Swap flips colours; seeded Random follows .NET's generator", () => {
    const taiko = map(1, "256,192,1000,1,0,0:0:0:0:\n256,192,1500,1,8,0:0:0:0:");
    expect(applyMods(taiko, [{ acronym: "SW" }]).objects.map((o) => !!(o.sound & 10))).toEqual([true, false]);
    const random = new NetRandom(1);
    expect([random.nextInt(), random.nextInt()]).toEqual([534011718, 237820880]);
  });
  test("custom rates and adjust pitch", () => {
    const replay = replayOf(3, [], lazerMods([{ acronym: "DT", settings: { speed_change: 1.25, adjust_pitch: true } }]));
    expect(replayRate(replay)).toBe(1.25);
    expect(replayPitched(replay)).toBe(true);
    expect(replayPitched(replayOf(3, [], lazerMods([{ acronym: "DT" }])))).toBe(false);
  });
});

describe("health", () => {
  const outcome = (time: number, type: Outcome["type"], max: Outcome["max"], object: "hit" | "circle" | "note", note: number): Outcome => ({
    time,
    note,
    type,
    max,
    count: null,
    offset: null,
    x: 0,
    y: 0,
    v1: { value: 0, multiplied: false, bonus: false, combo: "none" },
    hp: { object, end: time, top: true, newCombo: note === 0, lastInCombo: false },
  });
  const circles = (type: Outcome["type"]) => Array.from({ length: 20 }, (_, i) => outcome(1000 + i * 500, type, "great", "circle", i));
  const osuMap = { difficulty: { hp: 6, cs: 4, od: 8, ar: 9, sliderMultiplier: 1.4, sliderTickRate: 1 }, breaks: [] };

  test("osu! drains between hits and fails on misses", () => {
    const perfect = circles("great");
    const passed = simulateHealth({ mode: 0, map: osuMap, mods: [], classic: false }, perfect, perfect);
    expect(passed.failedAt).toBeNull();
    const lowest = Math.min(...passed.points.map((p) => p.health));
    expect(lowest).toBeGreaterThan(0.5);
    expect(lowest).toBeLessThan(1);
    const missed = simulateHealth({ mode: 0, map: osuMap, mods: [], classic: false }, perfect, circles("miss"));
    expect(missed.failedAt).not.toBeNull();
    expect(missed.points.at(-1)?.health).toBe(0);
    // No Fail keeps playing; Easy refills the bar twice first.
    const noFail = simulateHealth({ mode: 0, map: osuMap, mods: [{ acronym: "NF" }], classic: false }, perfect, circles("miss"));
    expect(noFail.failedAt).toBeNull();
    const easy = simulateHealth({ mode: 0, map: osuMap, mods: [{ acronym: "EZ" }], classic: false }, perfect, circles("miss"));
    expect(easy.failedAt).toBeGreaterThan(missed.failedAt!);
  });

  test("taiko fills from empty", () => {
    const hits = Array.from({ length: 10 }, (_, i) => outcome(1000 + i * 200, "great", "great", "hit", i));
    const { points } = simulateHealth({ mode: 1, map: osuMap, mods: [], classic: false }, hits, hits);
    expect(points[0].health).toBe(0);
    expect(points.at(-1)!.health).toBeGreaterThan(0.3);
  });

  test("mania never drains: health only moves on judgements", () => {
    const MANIA = map(3, "64,192,1000,1,0,0:0:0:0:\n192,192,2000,1,0,0:0:0:0:\n320,192,3000,1,0,0:0:0:0:");
    const simulation = simulateMania(replayOf(3, keys([1000, 1], [1050, 0], [5000, 0])), MANIA);
    const health = simulation.health!;
    expect(health[0].health).toBe(1);
    // Two misses: two steps down, flat in between.
    const levels = [...new Set(health.map((p) => p.health.toFixed(6)))];
    expect(levels.length).toBe(3);
  });

  test("the recorded life graph wins; simulated health needs verified judgements", () => {
    const simulation = { verified: true, health: [{ time: 0, health: 0.5 }] } as Simulation;
    const stable = { life: [{ time: 0, health: 0.8 }] };
    expect(replayHealth(stable, simulation, 100)).toBe(0.8);
    expect(replayHealth({ life: [] }, simulation, 100)).toBe(0.5);
    expect(replayHealth({ life: [] }, { ...simulation, verified: false }, 100)).toBeNull();
    expect(healthDeviation(stable, { ...simulation, health: [{ time: 0, health: 0.5 }, { time: 10, health: 0.5 }] })).toEqual({
      samples: 1,
      mean: 0.30000000000000004,
      max: 0.30000000000000004,
    });
  });

  test("judgeReplay: stable taiko/mania use stable's rules and get a simulated health bar", () => {
    const MANIA = map(3, "64,192,1000,1,0,0:0:0:0:");
    const stable = { ...replayOf(3, keys([1000, 1], [1050, 0])), version: 20260412 };
    const { simulation } = judgeReplay(stable, MANIA);
    expect(simulation.client).toBe("stable");
    expect(simulation.health?.length).toBeGreaterThan(0);
  });
});
