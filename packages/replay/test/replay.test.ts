import { afterAll, describe, expect, test } from "bun:test";
import { parseOsu } from "../../osu-parse/src/index";
import {
  parseReplay,
  frameAt,
  columnKeys,
  healthAt,
  judgeReplay,
} from "../src/index";
afterAll(() => {
  globalThis.onmessage = null;
});
test("LZMA replay reader rejects truncated binary before decoding", async () => {
  await expect(parseReplay(new Uint8Array([3, 1]))).rejects.toThrow(
    "Truncated",
  );
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
    const { simulation } = judgeReplay(replay, map);
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
      const map = parseOsu(await Bun.file(`${corpus}/${id}.osu`).text());
      const result = judgeReplay(replay, map).simulation;
      expect(result.verified).toBe(true);
      expect(result.counts).toEqual(replay.counts);
    });
});
