import { afterAll, describe, expect, test } from "bun:test";
import { parseOsu } from "../../osu-parse/src/index";
import {
  judgeReplay,
  parseFrames,
  playableMap,
  simulateStableMania,
  stableManiaWindows,
  stateAt,
  type Replay,
  type ReplayFrame,
} from "../src/index";
afterAll(() => {
  globalThis.onmessage = null;
});

const STABLE = 20260412;
const replayOf = (mode: 0 | 1 | 3, frames: ReplayFrame[], counts: Partial<Replay["counts"]>, mods = 0): Replay => ({
  mode,
  version: STABLE,
  beatmapHash: "",
  player: "test",
  replayHash: "",
  counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0, ...counts },
  score: 0,
  maxCombo: 0,
  perfect: false,
  mods,
  life: [],
  timestamp: 0n,
  onlineId: 0n,
  frames,
  seed: null,
  rate: mods & 64 ? 1.5 : 1,
  lazer: null,
});
const map = (mode: 0 | 1 | 3, objects: string, difficulty = "HPDrainRate:5\nCircleSize:4\nOverallDifficulty:8") =>
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
const judged = (replay: Replay, raw: ReturnType<typeof map>) => judgeReplay(replay, raw).simulation;
/** Counted results in order (ignored misses are events too, for drawing). */
const results = (replay: Replay, raw: ReturnType<typeof map>) =>
  judged(replay, raw)
    .events.filter((e) => e.kind !== "ignore_miss")
    .map((e) => e.result);

test("replay frames are decoded the way lazer reads stable replays", () => {
  // stable's two lead-in frames at (256, -500) are dropped, and the seed is kept.
  const parsed = parseFrames("0|256|-500|0,-1|256|-500|0,100|5|0|0,-12345|0|0|42,");
  expect(parsed.seed).toBe(42);
  expect(parsed.frames.map((f) => f.time)).toEqual([99]);
  // Fractional deltas round; a frame going back in time is skipped instead of failing the replay.
  expect(parseFrames("10|1|1|0,20.6|2|2|0,-5|3|3|0,7|4|4|0").frames.map((f) => [f.time, f.x])).toEqual([
    [10, 1],
    [31, 2],
    [33, 4],
  ]);
});

describe("osu!stable mania rules", () => {
  test("windows: whole milliseconds, Hard Rock and Easy scale them, converts use the fixed table", () => {
    expect(stableManiaWindows(8)).toEqual([16, 40, 73, 103, 127, 164]);
    expect(stableManiaWindows(8, { hardRock: true })).toEqual([11, 28, 52, 73, 90, 117]);
    expect(stableManiaWindows(8, { easy: true })).toEqual([22, 56, 102, 144, 177, 229]);
    expect(stableManiaWindows(3, { convert: true })).toEqual([16, 47, 77, 97, 121, 158]);
    expect(stableManiaWindows(8, { scoreV2: true })[0]).toBe(16);
    expect(stableManiaWindows(2, { scoreV2: true })[0]).toBe(21);
  });
  test("a note is missed from the ok window late; earlier presses use the windows", () => {
    const raw = map(3, "64,192,1000,1,0,0:0:0:0:\n64,192,2000,1,0,0:0:0:0:");
    // OD 8: ok is 103 ms, so a press 103 ms late is already too late.
    const replay = replayOf(3, keys([1103, 1], [1150, 0], [2102, 1], [2150, 0]), { n100: 1, miss: 1 });
    expect(results(replay, raw)).toEqual(["miss", "n100"]);
    expect(judged(replay, raw).verified).toBe(true);
  });
  test("a press cannot reach a note before the previous one in its column has started", () => {
    const raw = map(3, "64,192,1000,1,0,0:0:0:0:\n64,192,1135,1,0,0:0:0:0:");
    // The second press lands at 998, before the first note starts: stable ignores it.
    const replay = replayOf(3, keys([990, 1], [995, 0], [998, 1], [1001, 0], [1130, 1], [1160, 0]), { geki: 2 });
    expect(results(replay, raw)).toEqual(["geki", "geki"]);
  });
  test("presses from the meh window outwards miss; earlier than the miss window they do nothing", () => {
    const raw = map(3, "64,192,1000,1,0,0:0:0:0:\n192,192,1000,1,0,0:0:0:0:");
    // Column 0: 130 ms early (meh is 127, miss 164). Column 1: 170 ms early, then on time.
    const replay = replayOf(3, keys([830, 2], [831, 0], [870, 1], [880, 0], [1000, 2], [1010, 0]), { geki: 1, miss: 1 });
    expect(results(replay, raw)).toEqual(["miss", "geki"]);
  });
  test("hold notes combine the head and release errors into one judgement", () => {
    const raw = map(3, "64,192,1000,128,0,2000:0:0:0:0:");
    // Head 10 ms, release 35 ms: 45 ms total is over 2.4 × 16 but within 2.2 × 40.
    const replay = replayOf(3, keys([1010, 1], [2035, 0]), { n300: 1 });
    expect(results(replay, raw)).toEqual(["n300"]);
    expect(judged(replay, raw).verified).toBe(true);
  });
  test("a dropped hold picked up again is capped at good; never picked up, it is a miss", () => {
    const raw = map(3, "64,192,1000,128,0,2000:0:0:0:0:\n192,192,1000,128,0,2000:0:0:0:0:");
    const replay = replayOf(
      3,
      // Column 0: drops at 1020, picks it up at 1030 (a great head), releases on time.
      // Column 1: drops and never returns.
      keys([1000, 3], [1020, 0], [1030, 1], [2000, 0], [2200, 0]),
      { katu: 1, miss: 1 },
    );
    expect(results(replay, raw)).toEqual(["katu", "miss"]);
  });
  test("ScoreV2 judges heads and tails separately, tails with 1.5× windows", () => {
    const raw = map(3, "64,192,1000,128,0,2000:0:0:0:0:");
    // Head 5 ms (perfect), release 100 ms late: 66.7 ms after the leniency is a good.
    const replay = replayOf(3, keys([1005, 1], [2100, 0]), { geki: 1, katu: 1 }, 1 << 29);
    expect(results(replay, raw)).toEqual(["geki", "katu"]);
    expect(judged(replay, raw).verified).toBe(true);
  });
  test("rate mods keep the windows in real time; edge cases follow the header", () => {
    const raw = map(3, "64,192,1000,1,0,0:0:0:0:");
    // Double Time: 60 map ms is 40 real ms, the edge of OD 8's great. During
    // play it may have been 60.4: the header settles which side it fell on.
    expect(results(replayOf(3, keys([1060, 1], [1090, 0]), { n300: 1 }, 64), raw)).toEqual(["n300"]);
    expect(results(replayOf(3, keys([1060, 1], [1090, 0]), { katu: 1 }, 64), raw)).toEqual(["katu"]);
    // 62 map ms is past the edge whatever the header says.
    expect(results(replayOf(3, keys([1062, 1], [1090, 0]), { n300: 1 }, 64), raw)).toEqual(["katu"]);
  });
  test("stable's combo and the state at a time", () => {
    const raw = map(3, "64,192,1000,1,0,0:0:0:0:");
    const replay = { ...replayOf(3, keys([1000, 1], [1050, 0]), { geki: 1 }), maxCombo: 1 };
    const simulation = simulateStableMania(replay, playableMap(replay, raw));
    expect(simulation).toMatchObject({ verified: true, comboVerified: true, scoreVerified: false, client: "stable" });
    expect(stateAt(replay, simulation, 1000).combo).toBe(1);
  });
  test("osu! maps are converted to mania, key mods choosing the layout", () => {
    const raw = map(0, "256,192,1000,1,0,0:0:0:0:", "HPDrainRate:5\nCircleSize:4\nOverallDifficulty:3");
    const playable = playableMap(replayOf(3, [], {}, 65536), raw);
    expect(playable.mode).toBe(3);
    expect(playable.difficulty.cs).toBe(5);
    const column = Math.floor((playable.objects[0].x * 5) / 512);
    // Converts use the fixed windows: great is 47 ms at OD 3 (not 55).
    const replay = replayOf(3, keys([1050, 1 << column], [1080, 0]), { katu: 1 }, 65536);
    expect(results(replay, raw)).toEqual(["katu"]);
  });
});

describe("osu!stable taiko rules", () => {
  const centre = (time: number) => `256,192,${time},1,0,0:0:0:0:`;
  const rim = (time: number) => `256,192,${time},1,2,0:0:0:0:`;
  test("a late press inside the miss window misses the note instead of reaching the next", () => {
    // OD 8: ok 59.5, miss 80 (whole millisecond included).
    const raw = map(1, [centre(1000), centre(1100)].join("\n"));
    const replay = replayOf(1, taikoKeys([1070, 1], [1080, 0], [1100, 1], [1120, 0]), { n300: 1, miss: 1 });
    expect(results(replay, raw)).toEqual(["miss", "n300"]);
    expect(judged(replay, raw).verified).toBe(true);
    // lazer would have missed the first note at 1060 and given the press to the second.
    const lazer = { ...replay, version: 30000019 };
    expect(results(lazer, raw)).toEqual(["miss", "n100"]);
  });
  test("pressing both colours at once applies the wrong one first; the right one reaches the next note", () => {
    const raw = map(1, [centre(1000), centre(1030)].join("\n"));
    // Rim (2) and centre (4) in one frame on a centre note.
    const replay = replayOf(1, taikoKeys([1000, 6], [1050, 0]), { n100: 1, miss: 1 });
    expect(results(replay, raw)).toEqual(["miss", "n100"]);
  });
  test("notes take presses before drum roll ticks", () => {
    // A drum roll under a note: the press is the note's.
    const raw = map(1, ["256,192,900,2,0,L|356:192,1,140", centre(1000)].join("\n"));
    const replay = replayOf(1, taikoKeys([1000, 1], [1020, 0]), { n300: 1 });
    expect(judged(replay, raw).verified).toBe(true);
  });
  test("ScoreV2 counts every drum roll and completed swell as a 300", () => {
    const raw = map(1, [centre(500), "256,192,900,2,0,L|356:192,1,140"].join("\n"));
    const replay = replayOf(1, taikoKeys([500, 1], [520, 0], [1500, 0]), { n300: 2 }, 1 << 29);
    expect(judged(replay, raw).verified).toBe(true);
  });
  test("osu! maps are converted to taiko", () => {
    const raw = map(0, [centre(1000), rim(1500)].join("\n"));
    const replay = replayOf(1, taikoKeys([1000, 1], [1020, 0], [1500, 2], [1520, 0]), { n300: 2 });
    expect(judged(replay, raw).verified).toBe(true);
  });
});
