import { describe, expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { judgeReplay, playableMap, stateAt, type Replay } from "@vosu-tools/replay";
import { layoutCells, place, worldToOutput, VIEW } from "../src/layout";
import {
  DEFAULT_OVERLAP,
  MAX_OVERLAP,
  OVERLAP_COLOURS,
  OverlapAudio,
  focusLayers,
  overlapColour,
  overlapEligibility,
  overlapJudgements,
  overlapMods,
  overlapOptions,
  overlapTint,
  type OverlapPlayer,
} from "../src/overlap";
import { legendRow, playerLabels, scoreAt, scoreCurve, type Track } from "../src/studio";
import { autoplayFrames } from "./autoplay";

const player = (name: string, overrides: Partial<OverlapPlayer> = {}): OverlapPlayer => ({
  mode: 0,
  beatmapHash: "a".repeat(32),
  mods: 0,
  lazer: null,
  player: name,
  ...overrides,
});
const lazer = (mods: { acronym: string; settings?: Record<string, unknown> }[]) => ({
  mods,
  statistics: {},
  maximumStatistics: {},
  clientVersion: "2026.1005.0-lazer",
  totalScoreWithoutMods: null,
});
// Legacy mod bits.
const HD = 8,
  HR = 16,
  DT = 64,
  NC = 512 | 64,
  EZ = 2;

describe("overlap eligibility", () => {
  test("one map, speed and playfield: eligible", () => {
    expect(overlapEligibility([player("A"), player("B")])).toEqual({ ok: true, mods: [], notes: [] });
  });
  test("needs 2 to 8 osu! replays", () => {
    expect(overlapEligibility([player("A")])).toMatchObject({ ok: false, reason: "Overlap needs at least 2 replays" });
    const nine = Array.from({ length: 9 }, (_, i) => player(`P${i}`));
    expect(overlapEligibility(nine)).toMatchObject({ ok: false, reason: expect.stringContaining(`at most ${MAX_OVERLAP}`) });
    expect(overlapEligibility(nine.slice(0, 8)).ok).toBe(true);
    expect(overlapEligibility([player("A"), player("B", { mode: 3 })])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("osu! only; B"),
    });
  });
  test("the beatmap MD5 must match", () => {
    expect(overlapEligibility([player("A"), player("B", { beatmapHash: "b".repeat(32) })])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("B played a different one (MD5)"),
    });
  });
  test("the clock rate must match; DT and NC at 1.5× mix", () => {
    expect(overlapEligibility([player("A", { mods: DT }), player("B", { mods: NC })]).ok).toBe(true);
    expect(overlapEligibility([player("A", { mods: DT }), player("B")])).toMatchObject({
      ok: false,
      reason: "Overlap needs one speed; A plays at 1.5×, B at 1×",
    });
    const custom = player("C", { lazer: lazer([{ acronym: "DT", settings: { speed_change: 1.4 } }]) });
    expect(overlapEligibility([player("A", { mods: DT }), custom]).ok).toBe(false);
    const same = player("D", { lazer: lazer([{ acronym: "NC", settings: { speed_change: 1.5 } }]) });
    expect(overlapEligibility([player("A", { mods: DT }), same]).ok).toBe(true);
  });
  test("playfield mods must match, with their settings", () => {
    expect(overlapEligibility([player("A", { mods: HR }), player("B")])).toMatchObject({
      ok: false,
      reason: "Overlap needs the same playfield mods; A has HR, B no mods",
    });
    expect(overlapEligibility([player("A", { mods: HR }), player("B", { mods: HR | HD })]).ok).toBe(true);
    const da = (cs: number) => player(`DA${cs}`, { lazer: lazer([{ acronym: "DA", settings: { circle_size: cs } }]) });
    expect(overlapEligibility([da(5), da(5)]).ok).toBe(true);
    expect(overlapEligibility([da(5), da(6)])).toMatchObject({ ok: false, reason: expect.stringContaining("DA(circle_size=5)") });
    // Easy's extra lives move nothing.
    const ez = (retries: number) => player(`EZ${retries}`, { lazer: lazer([{ acronym: "EZ", settings: { retries } }]) });
    expect(overlapEligibility([ez(2), ez(3)]).ok).toBe(true);
    expect(overlapEligibility([player("A", { mods: EZ }), ez(2)]).ok).toBe(true);
    const mirror = player("M", { lazer: lazer([{ acronym: "MR" }]) });
    expect(overlapEligibility([player("A"), mirror]).ok).toBe(false);
  });
  test("visual mods may differ: drawn only when everyone has them, and noted", () => {
    const mixed = overlapEligibility([player("A", { mods: HD }), player("B")]);
    expect(mixed).toEqual({ ok: true, mods: [], notes: ["Not every player has HD: objects are drawn without it"] });
    expect(overlapMods([player("A", { mods: HD | HR }), player("B", { mods: HR })], 0)).toEqual([{ acronym: "HR" }]);
    const both = [player("A", { mods: HD }), player("B", { mods: HD })];
    expect(overlapEligibility(both)).toEqual({ ok: true, mods: ["HD"], notes: [] });
    expect(overlapMods(both, 1)).toEqual([{ acronym: "HD" }]);
  });
});

describe("overlap colours", () => {
  test("player i always gets colour i, all eight distinct", () => {
    expect(new Set(OVERLAP_COLOURS).size).toBe(MAX_OVERLAP);
    expect(Array.from({ length: 8 }, (_, i) => overlapColour(i))).toEqual([...OVERLAP_COLOURS]);
    expect(overlapColour(3)).toBe(overlapColour(3));
    expect(overlapTint(0)).toEqual([0xe6 / 255, 0x9f / 255, 0]);
    expect(overlapTint(1)).toEqual([0x56 / 255, 0xb4 / 255, 0xe9 / 255]);
  });
  test("duplicate names are numbered", () => {
    const tracks = ["Amy", "Bo", "Amy"].map((name) => ({ replay: { player: name } as Replay }));
    expect(playerLabels(tracks)).toEqual(["Amy (1)", "Bo", "Amy (3)"]);
  });
});

describe("overlap judgements", () => {
  const event = (time: number, result: string) => ({ time, result, note: 0, x: 0, y: 0, combo: 0 });
  const players = [
    [event(100, "great"), event(300, "miss")],
    [event(200, "miss"), event(250, "ok")],
  ];
  test("misses only by default, each in its player's colour, in time order", () => {
    expect(DEFAULT_OVERLAP.judgements).toBe("misses");
    expect(overlapJudgements(players, "misses")).toEqual([
      { ...event(200, "miss"), tint: overlapTint(1) },
      { ...event(300, "miss"), tint: overlapTint(0) },
    ]);
  });
  test("all or none", () => {
    expect(overlapJudgements(players, "all").map((e) => [e.time, e.tint])).toEqual([
      [100, overlapTint(0)],
      [200, overlapTint(1)],
      [250, overlapTint(1)],
      [300, overlapTint(0)],
    ]);
    expect(overlapJudgements(players, "none")).toEqual([]);
    expect(overlapJudgements([null, undefined], "all")).toEqual([]);
  });
});

describe("overlap options and overlays", () => {
  test("untrusted options fall back to defaults", () => {
    expect(overlapOptions(undefined, 3)).toEqual(DEFAULT_OVERLAP);
    expect(overlapOptions({ focus: 2, judgements: "all", names: false, health: true }, 3)).toEqual({
      focus: 2,
      judgements: "all",
      names: false,
      health: true,
    });
    expect(overlapOptions({ focus: 3, judgements: "hits", names: "yes" }, 3)).toEqual(DEFAULT_OVERLAP);
  });
  test("overlays follow the focus player once", () => {
    const layers = [
      { folder: "all", tracks: null },
      { folder: "second", tracks: [1] },
      { folder: "first", tracks: [0, 2] },
    ];
    expect(focusLayers(layers, 0)).toEqual([
      { folder: "all", tracks: [0] },
      { folder: "first", tracks: [0] },
    ]);
    expect(focusLayers(layers, 1).map((layer) => layer.folder)).toEqual(["all", "second"]);
  });
});

describe("overlap placement", () => {
  test("every player's cell is the whole frame", () => {
    expect(layoutCells(3, 1920, 1080, "overlap")).toEqual(Array(3).fill({ x: 0, y: 0, width: 1920, height: 1080 }));
  });
  test("world points land where render-core draws them", () => {
    const cell = { x: 0, y: 0, width: 1920, height: 1080 },
      transform = { x: 0.1, y: -0.05, scale: 0.8 };
    const { box } = place(cell, VIEW, transform);
    // The view's corners map to the placed box; osu! gameplay is 8 units lower.
    const topLeft = worldToOutput(cell, VIEW, transform, -64, -48);
    expect(topLeft.x).toBeCloseTo(box.x, 6);
    expect(topLeft.y).toBeCloseTo(box.y, 6);
    const centre = worldToOutput(cell, VIEW, transform, 256, 192, 8);
    expect(centre.x).toBeCloseTo(box.x + box.width / 2, 6);
    expect(centre.y).toBeCloseTo(box.y + box.height / 2 + 8 * centre.scale, 6);
  });
});

describe("overlap legend", () => {
  const raw = parseOsu(
    [
      "osu file format v14",
      "[General]",
      "Mode:0",
      "AudioFilename:audio.mp3",
      "[Difficulty]",
      "HPDrainRate:5",
      "CircleSize:4",
      "OverallDifficulty:8",
      "ApproachRate:9",
      "SliderMultiplier:1.4",
      "SliderTickRate:1",
      "[TimingPoints]",
      "0,500,4,2,0,100,1,0",
      "[HitObjects]",
      "100,100,1000,1,0,0:0:0:0:",
      "300,100,1500,1,0,0:0:0:0:",
      "300,300,2000,2,0,L|400:300,1,100",
      "100,300,3000,1,0,0:0:0:0:",
      "256,192,3500,1,0,0:0:0:0:",
    ].join("\n"),
  );
  const map = playableMap({ mode: 0, mods: 0, lazer: null }, raw);
  /** A replay of the map with `aim`, its header counts from the simulation. */
  function played(name: string, dx: number, lateMs: number) {
    const replay: Replay = {
      mode: 0,
      version: 20240212,
      beatmapHash: "a".repeat(32),
      player: name,
      replayHash: "b".repeat(32),
      counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 },
      score: 0,
      maxCombo: 0,
      perfect: false,
      mods: 0,
      life: [],
      timestamp: 0n,
      onlineId: 0n,
      frames: autoplayFrames(map, { player: name, dx, dy: 0, lateMs }),
      seed: 0,
      rate: 1,
      lazer: null,
    };
    const first = judgeReplay(replay, raw).simulation;
    replay.counts = { ...first.counts };
    replay.maxCombo = Math.max(...first.events.map((e) => e.combo ?? 0));
    replay.score = first.events.at(-1)?.score ?? 0;
    const simulation = judgeReplay(replay, raw).simulation;
    return { replay, simulation, score: simulation.verified ? scoreCurve(simulation, replay.score) : null } as unknown as Track;
  }
  const clean = played("Clean", 0, 0),
    off = played("Off", 80, 30);
  test("the fixtures judge as aimed: clean hits all, far off misses", () => {
    expect(clean.simulation!.verified).toBe(true);
    expect(clean.simulation!.counts.miss).toBe(0);
    expect(off.simulation!.verified).toBe(true);
    expect(off.simulation!.counts.miss).toBeGreaterThan(0);
  });
  test("legend values are each player's simulation at that time", () => {
    for (const track of [clean, off])
      for (const time of [500, 1200, 2100, 3200, 4000]) {
        const state = stateAt(track.replay, track.simulation!, time);
        expect(legendRow(track, time)).toEqual({
          name: track.replay.player,
          accuracy: state.accuracy,
          combo: state.combo,
          score: scoreAt(track.score!, time),
          misses: state.counts.miss,
        });
      }
    expect(legendRow(off, 4000).misses).toBe(off.simulation!.counts.miss);
  });
  test("an unverified simulation shows no values", () => {
    const unverified = { ...clean, simulation: { ...clean.simulation!, verified: false } } as Track;
    expect(legendRow(unverified, 4000)).toEqual({ name: "Clean", accuracy: null, combo: null, score: null, misses: null });
  });
});

describe("overlap audio", () => {
  const tracks = () => ["a", "b", "c"].map((id) => ({ id, settings: {} as Record<string, number> }));
  const mutes = (list: { settings: Record<string, number> }[]) => list.map((t) => t.settings["audio.mute"]);
  test("the focus player's hitsounds only, by default", () => {
    const audio = new OverlapAudio(),
      list = tracks();
    expect(audio.apply(list, 0)).toBe(true);
    expect(mutes(list)).toEqual([0, 1, 1]);
    expect(audio.apply(list, 0)).toBe(false);
  });
  test("a player's own toggle stays until the focus changes; leaving restores", () => {
    const audio = new OverlapAudio(),
      list = tracks();
    list[1].settings["audio.mute"] = 1;
    list[2].settings["audio.mute"] = 0;
    audio.apply(list, 0);
    list[2].settings["audio.mute"] = 0; // heard on request
    audio.apply(list, 0);
    expect(mutes(list)).toEqual([0, 1, 0]);
    audio.apply(list, 1);
    expect(mutes(list)).toEqual([1, 0, 1]);
    // A track added during the overlap starts muted.
    const added = [...list, { id: "d", settings: {} as Record<string, number> }];
    audio.apply(added, 1);
    expect(mutes(added)).toEqual([1, 0, 1, 1]);
    expect(audio.apply(added, null)).toBe(true);
    // Every track gets its own value back (unset ones: heard).
    expect(mutes(added)).toEqual([0, 1, 0, 0]);
  });
});
