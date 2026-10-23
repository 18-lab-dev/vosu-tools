import { afterAll, describe, expect, test } from "bun:test";
import { applyMods, parseOsu, type Beatmap } from "../../osu-parse/src/index";
import { catchObjects } from "../../ruleset-convert/src/index";
import {
  catcherAt,
  halfCatchWidth,
  lazerMultiplier,
  osuHitWindows,
  parseReplay,
  peppyStars,
  replayMods,
  simulate,
  simulateCatch,
  simulateOsu,
  stateAt,
  type LazerScoreInfo,
  type Replay,
  type ReplayFrame,
} from "../src/index";
afterAll(() => {
  globalThis.onmessage = null;
});

const LAZER = 30000019,
  STABLE = 20260412;
const header = (mode: 0 | 2, frames: ReplayFrame[], version: number): Replay => ({
  mode,
  version,
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
  lazer: null,
});
const lazerInfo = (statistics: Record<string, number>, maximum: Record<string, number>, total: number): LazerScoreInfo => ({
  mods: [],
  statistics,
  maximumStatistics: maximum,
  clientVersion: "test",
  totalScoreWithoutMods: total,
});
/** Frames every 10 ms from `from` to `to` (inclusive) at `at(time)`. */
function frames(from: number, to: number, at: (time: number) => { x: number; y: number; keys: number }): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  for (let time = from; time <= to; time += 10) out.push({ time, ...at(time) });
  return out;
}

// One circle, a two-span slider with a tick per span, and a two-second spinner.
const OSU = `osu file format v14

[General]
Mode: 0
StackLeniency: 0.7

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
100,100,1000,1,0,0:0:0:0:
100,300,2000,2,0,L|380:300,2,280
256,192,5000,12,0,7000,0:0:0:0:
`;
/** A clean play: click the circle, follow the slider ball, spin at 6 rps. */
function perfectOsu(time: number) {
  if (time < 1500) return { x: 100, y: 100, keys: time >= 1000 && time < 1050 ? 5 : 0 };
  if (time < 2000) return { x: 100, y: 300, keys: 0 };
  if (time <= 4100) {
    const progress = Math.min(1, (time - 2000) / 2000) * 2,
      p = progress <= 1 ? progress : 2 - progress;
    return { x: 100 + 280 * p, y: 300, keys: 10 };
  }
  if (time < 5000) return { x: 306, y: 192, keys: 0 };
  const angle = ((time - 5000) / 1000) * 6 * 2 * Math.PI;
  return { x: 256 + 50 * Math.cos(angle), y: 192 + 50 * Math.sin(angle), keys: time <= 7000 ? 5 : 0 };
}

describe("osu! judgement simulation", () => {
  const map = parseOsu(OSU);
  test("hit windows follow lazer's floored OD ranges", () => {
    expect(osuHitWindows(8)).toEqual([31.5, 75.5, 119.5]);
    expect(osuHitWindows(5)).toEqual([49.5, 99.5, 149.5]);
  });
  test("a clean lazer play scores 1,000,000 plus spinner bonus", () => {
    // 6 rps from 5000 up to (not including) 7000: 11 whole spins, 6 required.
    const replay = header(0, frames(0, 7500, perfectOsu), LAZER);
    const statistics = {
      great: 3,
      large_tick_hit: 3,
      slider_tail_hit: 1,
      small_bonus: 8,
      large_bonus: 3,
      ignore_hit: 1,
      ignore_miss: 2,
    };
    const maximum = { great: 3, large_tick_hit: 3, slider_tail_hit: 1, small_bonus: 8, large_bonus: 5, ignore_hit: 1 };
    Object.assign(replay, {
      counts: { n300: 3, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 },
      maxCombo: 7,
      score: 1000230,
      lazer: lazerInfo(statistics, maximum, 1000230),
    });
    const sim = simulateOsu(replay, map, { baseDifficulty: map.difficulty });
    expect(sim.differences).toEqual({});
    expect(sim).toMatchObject({ verified: true, comboVerified: true, scoreVerified: true, client: "lazer" });
    expect(sim.statistics).toEqual(statistics);
    const state = stateAt(replay, sim, 7100);
    expect(state).toMatchObject({ combo: 7, accuracy: 1, score: 1000230 });
    // Hit errors come only from the circle and the slider head.
    expect(sim.events.filter((e) => e.timed).map((e) => e.offset)).toEqual([0, 0]);
  });
  test("a stable play is judged with classic rules and ScoreV1", () => {
    const twoObjects = parseOsu(OSU.replace(/256,192,5000.*\n/, ""));
    const replay = header(0, frames(0, 4500, perfectOsu), STABLE);
    const stars = peppyStars(twoObjects, twoObjects.difficulty);
    // AccuracyScore 300 + (30 + 10 + 30 + 10 + 30 + 300); ComboScore (6 - 1) × 300/25 × stars.
    const expected = 710 + Math.trunc(5 * (12 * stars));
    Object.assign(replay, {
      counts: { n300: 2, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 },
      maxCombo: 6,
      score: expected,
    });
    const sim = simulateOsu(replay, twoObjects, { baseDifficulty: twoObjects.difficulty });
    expect(sim).toMatchObject({ verified: true, comboVerified: true, scoreVerified: true, client: "stable" });
    expect(sim.statistics).toMatchObject({ great: 2, large_tick_hit: 4, small_tick_hit: 1 });
    expect(stateAt(replay, sim, 5000)).toMatchObject({ combo: 6, accuracy: 1, score: expected });
  });
  test("note lock: an early click on the next circle is ignored; a late one misses the first", () => {
    const two = parseOsu(
      OSU.replace(/\[HitObjects\][\s\S]*/, "[HitObjects]\n100,100,1000,1,0,0:0:0:0:\n300,100,1200,1,0,0:0:0:0:\n"),
    );
    const at = (clicks: [number, number][]) => (time: number) => {
      const click = clicks.find(([t]) => time >= t && time < t + 20);
      return { x: click ? click[1] : 200, y: 100, keys: click ? 5 : 0 };
    };
    // The early click shakes; both circles are then hit on time.
    const locked = simulateOsu(header(0, frames(0, 1600, at([[900, 300], [1000, 100], [1200, 300]])), LAZER), two, {
      baseDifficulty: two.difficulty,
    });
    expect(locked.counts).toMatchObject({ n300: 2, miss: 0 });
    // Hitting the second circle after the first's time misses the first at once.
    const skipped = simulateOsu(header(0, frames(0, 1600, at([[1100, 300]])), LAZER), two, {
      baseDifficulty: two.difficulty,
    });
    expect(skipped.counts).toMatchObject({ n50: 1, miss: 1 });
    expect(skipped.events.map((e) => [e.time, e.result])).toEqual([
      [1100, "n50"],
      [1100, "miss"],
    ]);
  });
  test("a released slider misses its remaining ticks, and the tail without breaking combo", () => {
    const released = (time: number) => {
      const f = perfectOsu(time);
      return time > 2600 && time < 4500 ? { ...f, keys: 0 } : f;
    };
    const sim = simulateOsu(header(0, frames(0, 4500, released), LAZER), map, { baseDifficulty: map.difficulty });
    expect(sim.statistics).toMatchObject({ great: 2, large_tick_hit: 1, large_tick_miss: 2 });
    expect(sim.statistics?.slider_tail_hit).toBeUndefined();
    expect(sim.events.find((e) => e.time >= 3000)?.combo).toBe(0);
  });
});

// Two fruits and a juice stream (fruit, droplet, tiny droplets, fruit).
const CATCH = `osu file format v14

[General]
Mode: 2

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
100,192,1000,1,0,0:0:0:0:
400,192,1600,1,0,0:0:0:0:
100,192,2000,5,0,L|380:192,1,280
`;
describe("osu!catch judgement simulation", () => {
  const map = parseOsu(CATCH),
    objects = catchObjects(map);
  /** The catcher sits under each object from 40 ms before it. */
  const follow = (time: number) => {
    const next = objects.find((o) => o.time >= time - 40) ?? objects[objects.length - 1];
    return { x: next.x, y: 0, keys: 0 };
  };
  test("the judging frame's catcher position decides edge catches", () => {
    const f = [
      { time: 990, x: 100, y: 0, keys: 0 },
      { time: 1000, x: 160, y: 0, keys: 0 },
      { time: 1017, x: 200, y: 0, keys: 0 },
    ];
    expect(catcherAt(f, 1000)).toBe(160);
    expect(catcherAt(f, 999.7)).toBe(160);
    // No frame within 4 ms: interpolated at the object's time.
    expect(catcherAt(f, 1008)).toBeCloseTo(160 + (40 * 8) / 17, 6);
    expect(halfCatchWidth(4)).toBeCloseTo(48.678, 3);
  });
  test("a clean lazer play scores 1,000,000", () => {
    const replay = header(2, frames(0, 3200, follow), LAZER);
    const kinds = objects.map((o) => o.kind);
    const fruits = kinds.filter((k) => k === "fruit").length,
      droplets = kinds.filter((k) => k === "droplet").length,
      tiny = kinds.filter((k) => k === "tiny").length;
    const statistics: Record<string, number> = { great: fruits, large_tick_hit: droplets, small_tick_hit: tiny };
    for (const k of Object.keys(statistics)) if (!statistics[k]) delete statistics[k];
    Object.assign(replay, {
      counts: { n300: fruits, n100: droplets, n50: tiny, geki: 0, katu: 0, miss: 0 },
      maxCombo: fruits + droplets,
      score: 1000000,
      lazer: lazerInfo(statistics, statistics, 1000000),
    });
    const sim = simulateCatch(replay, map, { baseDifficulty: map.difficulty });
    expect(sim.differences).toEqual({});
    expect(sim).toMatchObject({ verified: true, comboVerified: true, scoreVerified: true });
    expect(sim.events.every((e) => e.timed === false)).toBe(true);
  });
  test("a dropped fruit breaks combo; tiny droplets never do", () => {
    const dropped = (time: number) => (time > 1550 && time < 1650 ? { x: 0, y: 0, keys: 0 } : follow(time));
    const sim = simulateCatch(header(2, frames(0, 3200, dropped), LAZER), map, { baseDifficulty: map.difficulty });
    expect(sim.counts.miss).toBe(1);
    expect(sim.events.find((e) => e.time === 1600)).toMatchObject({ result: "miss", combo: 0 });
  });
  test("HR applies to the catcher width", () => {
    const hr = applyMods(map, [{ acronym: "HR" }]);
    expect(halfCatchWidth(hr.difficulty.cs)).toBeLessThan(halfCatchWidth(map.difficulty.cs));
  });
});

describe("scoring helpers", () => {
  test("lazer multipliers follow the score version and custom rates", () => {
    expect(lazerMultiplier(2, [{ acronym: "DT", settings: { speed_change: 1.25 } }], LAZER)).toBeCloseTo(1.04, 9);
    expect(lazerMultiplier(2, [{ acronym: "EZ" }], LAZER)).toBe(0.5);
    expect(lazerMultiplier(0, [{ acronym: "DT" }], LAZER)).toBeCloseTo(1.23, 9);
    expect(lazerMultiplier(0, [{ acronym: "DT" }], 30000016)).toBeCloseTo(1.1, 9);
    expect(lazerMultiplier(0, [{ acronym: "HD" }, { acronym: "HR" }], LAZER)).toBeCloseTo(1.04 * 1.09, 9);
  });
  test("legacy bits map to mods, lazer's own list wins", () => {
    const replay = header(0, [], STABLE);
    replay.mods = 8 | 16 | 64 | 512;
    expect(replayMods(replay).map((m) => m.acronym)).toEqual(["HD", "HR", "NC"]);
    replay.lazer = lazerInfo({}, {}, 0);
    replay.lazer.mods = [{ acronym: "DT", settings: { speed_change: 1.2 } }];
    expect(replayMods(replay)).toEqual(replay.lazer.mods);
  });
  test("taiko and mania keep their scaled-score behaviour", () => {
    const replay = header(0, [{ time: 1000, x: 1, y: 0, keys: 0 }], STABLE);
    Object.assign(replay, { mode: 3, counts: { n300: 0, n100: 0, n50: 0, geki: 1, katu: 0, miss: 0 }, maxCombo: 1 });
    const sim = simulate(replay, [{ time: 1000, column: 0 }], 8);
    expect(sim).toMatchObject({ verified: true, comboVerified: true, scoreVerified: false });
    expect(sim.events[0]).not.toHaveProperty("score");
    expect(stateAt(replay, sim, 1000).score).toBeNull();
  });
});

/** Optional: copied real osu!/catch replays (`manifest.json` of {file, md5}, `replays/`, `maps/`). */
const fixtures = process.env.OSU_CATCH_FIXTURES;
describe.skipIf(!fixtures)("copied real osu! and catch replays", () => {
  test("judgements reproduce the recorded counts", async () => {
    const manifest: { file: string; md5: string }[] = await Bun.file(`${fixtures}/manifest.json`).json();
    const tally: Record<string, { total: number; counts: number; combo: number; score: number }> = {};
    for (const entry of manifest) {
      const replay = await parseReplay(new Uint8Array(await Bun.file(`${fixtures}/replays/${entry.file}`).arrayBuffer()));
      const raw: Beatmap = parseOsu(await Bun.file(`${fixtures}/maps/${entry.md5}.osu`).text());
      const map = applyMods(raw, replayMods(replay));
      const options = { baseDifficulty: raw.difficulty };
      const sim = replay.mode === 0 ? simulateOsu(replay, map, options) : simulateCatch(replay, map, options);
      const row = (tally[`mode ${replay.mode}`] ??= { total: 0, counts: 0, combo: 0, score: 0 });
      row.total++;
      row.counts += sim.verified ? 1 : 0;
      row.combo += sim.comboVerified ? 1 : 0;
      row.score += sim.scoreVerified ? 1 : 0;
    }
    console.log(tally);
    for (const row of Object.values(tally)) expect(row.counts / row.total).toBeGreaterThan(0.85);
  }, 120000);
});
