import { afterAll, describe, expect, test } from "bun:test";
import { parseOsu } from "../../osu-parse/src/index";
import {
  parseFrames,
  parseReplay,
  frameAt,
  columnKeys,
  healthAt,
  simulate,
  type Replay,
} from "../src/index";
afterAll(() => {
  globalThis.onmessage = null;
});
const base: Replay = {
  mode: 3,
  version: 20260412,
  beatmapHash: "",
  player: "test",
  replayHash: "",
  counts: { n300: 0, n100: 0, n50: 0, geki: 1, katu: 0, miss: 0 },
  score: 0,
  maxCombo: 1,
  perfect: true,
  mods: 0,
  life: [],
  timestamp: 0n,
  onlineId: 0n,
  frames: [],
  seed: null,
  rate: 1,
  lazer: null,
};
test("LZMA replay reader rejects truncated binary before decoding", async () => {
  await expect(parseReplay(new Uint8Array([3, 1]))).rejects.toThrow(
    "Truncated",
  );
});
test("stable negative initial positioning frames and RNG seed", () => {
  const parsed = parseFrames(
    "0|256|-500|0,-1|256|-500|0,100|5|0|0,-12345|0|0|42,",
  );
  expect(parsed.seed).toBe(42);
  expect(parsed.frames.map((f) => f.time)).toEqual([-1, 0, 99]);
});
test("seek interpolates cursor but never anticipates a keypress", () => {
  const frames = [
    { time: 0, x: 0, y: 0, keys: 0 },
    { time: 100, x: 100, y: 200, keys: 1 },
  ];
  expect(frameAt({ mode: 0, frames }, 50)).toEqual({
    time: 50,
    x: 50,
    y: 100,
    keys: 0,
  });
  expect(frameAt({ mode: 3, frames }, 50).x).toBe(0);
  expect(frameAt({ mode: 0, frames }, -1).keys).toBe(0);
});
test("mania columns use x rather than standard key field", () => {
  expect(columnKeys({ time: 0, x: 5, y: 0, keys: 0 }, 4)).toEqual([
    true,
    false,
    true,
    false,
  ]);
});
test("HP comes from the stored graph, not fabricated drain", () => {
  expect(healthAt({ life: [] }, 10)).toBeNull();
  expect(
    healthAt(
      {
        life: [
          { time: 0, health: 1 },
          { time: 100, health: 0.5 },
        ],
      },
      50,
    ),
  ).toBe(0.75);
});
test("mania tap simulation verifies header counts and combo", () => {
  const replay = { ...base, frames: [{ time: 1000, x: 1, y: 0, keys: 0 }] };
  const result = simulate(replay, [{ time: 1000, column: 0 }], 8);
  expect(result.verified).toBe(true);
  expect(result.events[0].combo).toBe(1);
});
test("mania early-hit notelock lasts until the previous scheduled note time", () => {
  const replay = {
    ...base,
    counts: { ...base.counts, geki: 2 },
    frames: [
      { time: 990, x: 1, y: 0, keys: 0 },
      { time: 995, x: 0, y: 0, keys: 0 },
      { time: 998, x: 1, y: 0, keys: 0 },
      { time: 1001, x: 0, y: 0, keys: 0 },
      { time: 1099, x: 1, y: 0, keys: 0 },
    ],
  };
  const result = simulate(
    replay,
    [
      { time: 1000, column: 0 },
      { time: 1100, column: 0 },
    ],
    8,
  );
  expect(result.verified).toBe(true);
  expect(result.events.map((event) => event.offset)).toEqual([-10, -1]);
});
test("mania hold combined head and release errors", () => {
  const replay = {
    ...base,
    frames: [
      { time: 1005, x: 1, y: 0, keys: 0 },
      { time: 2010, x: 0, y: 0, keys: 0 },
    ],
  };
  const result = simulate(
    replay,
    [{ time: 1000, endTime: 2000, column: 0, kind: "hold" }],
    8,
  );
  expect(result.verified).toBe(true);
  expect(result.events[0].result).toBe("geki");
});
test("taiko drumrolls leave counts verified but not the combo", () => {
  const replay: Replay = {
    ...base,
    mode: 1,
    counts: { n300: 1, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 },
    maxCombo: 1,
    // Centre (key 1) pressed on the note, then released.
    frames: [
      { time: 1000, x: 0, y: 0, keys: 1 },
      { time: 1050, x: 0, y: 0, keys: 0 },
    ],
  };
  const result = simulate(
    replay,
    [
      { time: 1000, kind: "circle" },
      { time: 1500, endTime: 2000, kind: "slider" },
      { time: 2500, endTime: 3000, kind: "slider" },
    ],
    5,
  );
  expect(result.verified).toBe(true);
  expect(result.comboVerified).toBe(false);
  expect(result.warnings).toEqual(["Taiko drumroll/spinner bonus combo is not reconstructed"]);
});
test("mismatched simulation cannot claim verification", () => {
  const replay = { ...base, frames: [] };
  const result = simulate(replay, [{ time: 1000, column: 0 }], 8);
  expect(result.verified).toBe(false);
  expect(result.differences.miss).toEqual({ expected: 0, actual: 1 });
});
const fixture = process.env.REPLAY_FIXTURES;
describe.skipIf(!fixture)("copied real stable replays", () => {
  test("taiko LZMA frames and stored counts", async () => {
    const replay = await parseReplay(
      new Uint8Array(await Bun.file(`${fixture}/1.osr`).arrayBuffer()),
    );
    expect(replay.mode).toBe(1);
    expect(replay.counts.n300).toBe(1406);
    expect(replay.counts.n100).toBe(18);
    expect(replay.frames.length).toBeGreaterThan(1000);
    expect(replay.seed).not.toBeNull();
    const map = parseOsu(await Bun.file(`${fixture}/1.osu`).text());
    const simulation = simulate(
      replay,
      map.objects.map((object) => ({
        time: object.time,
        rim: !!(object.sound & 10),
        kind:
          object.type & 2 ? "slider" : object.type & 8 ? "spinner" : "circle",
        x: object.x,
        y: object.y,
      })),
      map.difficulty.od,
    );
    expect(simulation.verified).toBe(true);
    expect(simulation.counts.n300).toBe(replay.counts.n300);
    expect(simulation.counts.n100).toBe(replay.counts.n100);
    expect(simulation.counts.miss).toBe(replay.counts.miss);
  });
  test("mania LZMA frames and stored counts", async () => {
    const replay = await parseReplay(
      new Uint8Array(await Bun.file(`${fixture}/3.osr`).arrayBuffer()),
    );
    expect(replay.mode).toBe(3);
    expect(replay.counts.geki).toBe(1172);
    expect(replay.counts.miss).toBe(47);
    expect(replay.rate).toBe(1.5);
  });
});
const corpus = process.env.REPLAY_CORPUS;
describe.skipIf(!corpus)("real native mania parity regressions", () => {
  for (const id of [3, 6, 9, 10, 12, 15, 16])
    test(`stored judgement parity: corpus ${id}`, async () => {
      const replay = await parseReplay(
        new Uint8Array(await Bun.file(`${corpus}/${id}.osr`).arrayBuffer()),
      );
      const map = parseOsu(await Bun.file(`${corpus}/${id}.osu`).text()),
        columns = Math.round(map.difficulty.cs);
      const result = simulate(
        replay,
        map.objects.map((object) => ({
          time: object.time,
          endTime: object.type & 128 ? object.endTime : undefined,
          column: Math.min(columns - 1, Math.floor((object.x * columns) / 512)),
          kind: object.type & 128 ? "hold" : "circle",
        })),
        map.difficulty.od,
        columns,
      );
      expect(result.verified).toBe(true);
      expect(result.counts).toEqual(replay.counts);
    });
});
