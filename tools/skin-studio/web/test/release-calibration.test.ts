import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { judgeReplay, maniaHitWindows, replayRate, stableManiaWindows, type Replay } from "@vosu-tools/replay";
import { MIN_HITS, offsets } from "../src/calibrate";

type Client = "stable" | "lazer";
function play(client: Client, releases: number[], mods: { acronym: string; settings?: Record<string, unknown> }[] = []) {
  const objects = releases.map((_, i) => `64,192,${1000 + i * 7000},128,0,${5000 + i * 7000}:0:0:0:0:`);
  const raw = parseOsu(`osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[TimingPoints]\n0,500,4,2,0,100,1,0\n[HitObjects]\n${objects.join("\n")}\n`);
  const frames = releases.flatMap((offset, i) => [
    { time: 1000 + i * 7000, x: 1, y: 0, keys: 0 },
    { time: 5000 + i * 7000 + offset, x: 0, y: 0, keys: 0 },
  ]);
  frames.push({ time: 10000 + releases.length * 7000, x: 0, y: 0, keys: 0 });
  const bits = mods.reduce((bits, mod) => bits | ({ HR: 16, EZ: 2, DT: 64, HT: 256, SV2: 1 << 29 }[mod.acronym] ?? 0), 0);
  const replay: Replay = {
    mode: 3, version: client === "stable" ? 20260101 : 30000019,
    beatmapHash: "", player: "test", replayHash: "", counts: { geki: 0, n300: 0, katu: 0, n100: 0, n50: 0, miss: 0 },
    score: 0, maxCombo: 0, perfect: false, mods: bits, life: [], timestamp: 0n, onlineId: 0n,
    frames, seed: null, rate: 1,
    lazer: client === "lazer" ? { mods, statistics: {}, maximumStatistics: {}, clientVersion: "2026.1005.0-lazer", totalScoreWithoutMods: null } : null,
  };
  const { map, simulation } = judgeReplay(replay, raw);
  return { simulation, offsets: offsets(simulation, map, "release", { client, speed: 24 }, replayRate(replay)) };
}

for (const client of ["stable", "lazer"] as const) {
  test(`${client}: very early long-LN drops do not change release mean, spread or distance`, () => {
    const good = Array.from({ length: 60 }, (_, i) => i % 2 ? 12 : 8);
    const baseline = play(client, good).offsets;
    const result = play(client, [...good, -3000, -2500, -2000]).offsets;
    expect(result).toMatchObject({ count: 60, total: 63, excluded: 3, veryLate: 0, mean: 10 });
    expect(result.spread).toBe(baseline.spread);
    expect(result.distance).toBe(baseline.distance);
  });
  test(`${client}: excluding drops can leave too few releases to calibrate`, () => {
    const result = play(client, [...Array(49).fill(10), -3000, -2500]).offsets;
    expect(result.count).toBeLessThan(MIN_HITS);
    expect(result).toMatchObject({ total: 51, excluded: 2 });
  });
}

test("stable ScoreV1 keeps very late held releases, explicitly counted", () => {
  const result = play("stable", [10, 1000]).offsets;
  expect(result).toMatchObject({ count: 2, total: 2, excluded: 0, veryLate: 1, mean: 505 });
});

test("stable ScoreV1 early meh edge is inclusive; a drop just outside is excluded", () => {
  const edge = stableManiaWindows(8)[4];
  expect(play("stable", [-edge, -edge - 0.01]).offsets).toMatchObject({ count: 1, total: 2, excluded: 1, mean: -edge });
});

test("stable ScoreV2 uses its asymmetric release windows, inclusive at both edges", () => {
  const windows = stableManiaWindows(8, { scoreV2: true });
  const early = windows[4] * 1.5, late = windows[3] * 1.5;
  expect(play("stable", [-early, late, -early - 0.01, late + 0.01, -3000, 1000], [{ acronym: "SV2" }]).offsets)
    .toMatchObject({ count: 2, total: 6, excluded: 4, mean: (late - early) / 2 });
});

for (const classic of [false, true]) for (const scoreV2 of [false, true]) {
  test(`lazer CL=${classic}, SV2=${scoreV2}: inclusive lenient tail edge, not the miss window`, () => {
    const mods = [...(classic ? [{ acronym: "CL" }] : []), ...(scoreV2 ? [{ acronym: "SV2" }] : [])];
    const edge = maniaHitWindows(8, { classic, scoreV2 })[4] * 1.5;
    expect(play("lazer", [-edge, edge, -edge - 0.01, edge + 0.01, -3000, 1000], mods).offsets)
      .toMatchObject({ count: 2, total: 6, excluded: 4, mean: 0 });
  });
}

test("HR and rate mods use the judge's map-time release window, then real-ms mean", () => {
  const edge = maniaHitWindows(8, { difficulty: 1.4, rate: 1.5 })[4] * 1.5;
  const result = play("lazer", [-edge, edge + 0.01], [{ acronym: "HR" }, { acronym: "DT" }]).offsets;
  expect(result).toMatchObject({ count: 1, total: 2, excluded: 1, mean: -edge / 1.5 });
  const stableEdge = stableManiaWindows(8, { hardRock: true })[4] * 1.5;
  expect(play("stable", [-stableEdge, -stableEdge - 0.01], [{ acronym: "HR" }, { acronym: "DT" }]).offsets)
    .toMatchObject({ count: 1, total: 2, excluded: 1, mean: -stableEdge / 1.5 });
});
