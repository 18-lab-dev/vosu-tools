import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { playableMap, simulateStableMania, type Replay } from "@vosu-tools/replay";
import { telemetry } from "../src/telemetry";
const map = parseOsu(
  "osu file format v14\n[General]\nMode:3\nAudioFilename:audio.mp3\n[Metadata]\nTitle:Timing test\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:",
);
function replay(): Replay {
  return {
    mode: 3,
    version: 20260412,
    beatmapHash: "a".repeat(32),
    player: "Player",
    replayHash: "b".repeat(32),
    counts: { n300: 0, n100: 0, n50: 0, geki: 1, katu: 0, miss: 0 },
    score: 1000000,
    maxCombo: 1,
    perfect: true,
    mods: 0,
    life: [
      { time: 0, health: 0.8 },
      { time: 2000, health: 0.4 },
    ],
    timestamp: 621355968000000000n,
    onlineId: 0n,
    frames: [
      { time: 0, x: 0, y: 0, keys: 0 },
      { time: 1005, x: 1, y: 0, keys: 0 },
    ],
    seed: null,
    rate: 1,
  };
}
function track(value: Replay) {
  return {
    replay: value,
    map,
    simulation: simulateStableMania(value, playableMap(value, map)),
  };
}
test("the v2 partial follows the judgement, key and HP clocks in vosu's shapes", () => {
  const source = track(replay()),
    before = telemetry(source, 999),
    after = telemetry(source, 1005);
  expect(before.play.hits.geki).toBe(0);
  expect(after.play.hits.geki).toBe(1);
  expect(after.play.accuracy).toBe(100);
  expect(after.state).toEqual({ number: 2, name: "play" });
  expect(after.keys.all[0]).toEqual({ name: "K1", isPressed: true, count: 1, pressedAt: 1005, releasedAt: null });
  expect(after.keys.k1).toEqual({ isPressed: true, count: 1 });
  expect(after.keys.all).toHaveLength(4);
  expect(after.play.healthBar.normal).toBeCloseTo(59.9);
  // Hit errors in map milliseconds; windows in real milliseconds.
  expect(after.play.hitErrorArray).toEqual([5]);
  expect(after.play.pressHitErrors).toEqual([5]);
  expect(after.play.releaseHitErrors).toEqual([]);
  expect(after.beatmap.stats.hitWindow).toEqual({ perfect: 16, great: 49, good: 82, ok: 112, meh: 136, miss: 173 });
  expect(after.play.mods).toEqual({ checksum: "", number: 0, name: "", array: [], rate: 1 });
  expect(after.play.rank.current).toBe("SS");
  expect(after.__render.wallMs).toBe(1005);
});
test("a simulation that does not reproduce the counts still gives overlays numbers", () => {
  const value = replay();
  value.counts.geki = 2;
  const result = telemetry(track(value), 1500);
  expect(result.__render.verified).toBe(false);
  expect(result.play.accuracy).toBe(100);
  expect(result.play.hits.geki).toBe(1);
  expect(result.play.combo.current).toBe(1);
});
test("rate mods put hit windows in real time and keys follow presses", () => {
  const value = replay();
  value.mods = 64;
  value.rate = 1.5;
  value.frames = [
    { time: 0, x: 0, y: 0, keys: 0 },
    { time: 990, x: 1, y: 0, keys: 0 },
    { time: 1100, x: 0, y: 0, keys: 0 },
    { time: 1200, x: 1, y: 0, keys: 0 },
  ];
  const result = telemetry(track(value), 1150);
  expect(result.play.mods.name).toBe("DT");
  expect(result.play.mods.rate).toBe(1.5);
  expect(result.beatmap.stats.hitWindow.great).toBe(49);
  expect(result.keys.all[0]).toEqual({ name: "K1", isPressed: false, count: 1, pressedAt: 990, releasedAt: 1100 });
  expect(telemetry(track(value), 1250).keys.all[0].count).toBe(2);
});
// Regression: vosu's hit error fields are in the play document (a hit error bar subscribing to
// `/play/pressHitErrors` drew nothing), and hold every error since the play began, not a window.
test("hit errors accumulate over the whole play in map milliseconds, early negative", () => {
  const notes = [1000, 1500, 2000, 2500, 3000];
  const presses = [990, 1512, 2000, 2470, 3030];
  const value = replay();
  value.counts = { n300: 0, n100: 0, n50: 0, geki: 5, katu: 0, miss: 0 };
  value.maxCombo = 5;
  value.frames = [{ time: 0, x: 0, y: 0, keys: 0 }];
  for (const time of presses) value.frames.push({ time, x: 1, y: 0, keys: 0 }, { time: time + 40, x: 0, y: 0, keys: 0 });
  const many = parseOsu(
    "osu file format v14\n[General]\nMode:3\nAudioFilename:audio.mp3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:0\n[HitObjects]\n" +
      notes.map((time) => `64,192,${time},1,0,0:0:0:0:`).join("\n"),
  );
  const source = { replay: value, map: many, simulation: simulateStableMania(value, playableMap(value, many)) };
  let previous: number[] = [];
  for (const [index, time] of presses.entries()) {
    const errors = telemetry(source, time).play.hitErrorArray;
    expect(errors).toHaveLength(index + 1);
    // Cumulative: every earlier error stays, in order.
    expect(errors.slice(0, previous.length)).toEqual(previous);
    expect(telemetry(source, time).play.pressHitErrors).toEqual(errors);
    previous = errors;
  }
  expect(previous).toEqual([-10, 12, 0, -30, 30]);
  expect(previous.every((error) => typeof error === "number" && Number.isFinite(error))).toBe(true);
  // DT: still map milliseconds (vosu does not divide by the clock rate; overlays do).
  value.mods = 64;
  value.rate = 1.5;
  const fast = { replay: value, map: many, simulation: simulateStableMania(value, playableMap(value, many)) };
  expect(telemetry(fast, 3100).play.hitErrorArray).toEqual([-10, 12, 0, -30, 30]);
});
