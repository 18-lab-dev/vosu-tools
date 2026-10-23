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
test("synthetic v2 follows verified judgement and recorded key/HP clocks", () => {
  const source = track(replay()),
    before = telemetry(source, 999),
    after = telemetry(source, 1005);
  expect(before.play.hits?.geki).toBe(0);
  expect(after.play.hits?.geki).toBe(1);
  expect(after.play.accuracy).toBe(100);
  expect(after.keys[0].isPressed).toBe(true);
  expect(after.play.healthBar.normal).toBeCloseTo(0.599);
  expect(after.play.hitErrorArray).toEqual([5]);
  expect(after.__render.wallMs).toBe(1005);
  expect(after.play.pp.current).toBeNull();
});
test("mismatched scoring remains explicitly unknown", () => {
  const value = replay();
  value.counts.geki = 2;
  const result = telemetry(track(value), 1500);
  expect(result.__render.verified).toBe(false);
  expect(result.play.accuracy).toBeNull();
  expect(result.play.hits).toBeNull();
  expect(result.play.combo.current).toBeNull();
});
test("combo is independently gated by stored maximum", () => {
  const value = replay();
  value.maxCombo = 2;
  const result = telemetry(track(value), 1500);
  expect(result.__render.verified).toBe(true);
  expect(result.play.combo.current).toBeNull();
  expect(result.play.combo.max).toBeNull();
});
