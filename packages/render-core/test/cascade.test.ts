import { expect, test } from "bun:test";
import { parseOsu, parseSkinIni, scrollPosition } from "@vosu-tools/osu-parse";
import { compileScene } from "../src/scene";
import type { Skin, AtlasRegion } from "../src/skin";
const text =
  "osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,250,4,1,0,100,1,0\n[HitObjects]\n64,192,2000,128,0,6000:0:0:0:0:";
test("Stretch bodies stretch over the hold; every other NoteBodyStyle uses lazer's 32800-unit body", () => {
  const regions = new Map<string, AtlasRegion>([
    [
      "body",
      {
        u: 0,
        v: 0,
        w: 0.1,
        h: 0.1,
        width: 64,
        height: 64,
        first: 0,
        count: 1,
        fps: 20,
      },
    ],
  ]);
  for (const [version, style, motion] of [
    ["2.7", "0", 2],
    ["2.7", "Stretch", 2],
    ["2.7", "1", 14],
    ["2.7", "RepeatTop", 14],
    ["2.7", "RepeatBottom", 14],
    ["2.7", "RepeatTopAndBottom", 14],
    // Without NoteBodyStyle: Stretch below skin version 2.5, RepeatBottom from it.
    ["2.4", "", 2],
    ["2.5", "", 14],
  ] as const) {
    const skin: Skin = {
      name: "cascade",
      assets: new Map(),
      version: Number(version),
      sections: parseSkinIni(
        `[General]\nVersion:${version}\n[Mania]\nKeys:4\nNoteImage0L:body\n${style ? `NoteBodyStyle:${style}` : ""}`,
      ),
    };
    const scene = compileScene(parseOsu(text), {}, regions, skin);
    const bodies = Array.from(
      { length: scene.count },
      (_, i) => scene.data[i * 24 + 12],
    ).filter((kind) => kind === 2 || kind === 14);
    expect(bodies).toEqual([motion]);
  }
});
test("mania uses duration-weighted BPM normalization without discontinuities", () => {
  const map = parseOsu(text),
    scene = compileScene(map, {}, new Map());
  expect(scene.scrollBase).toBe(250);
  expect(scrollPosition(map.timing, 1000, "mania", scene.scrollBase)).toBe(500);
  expect(scrollPosition(map.timing, 2000, "mania", scene.scrollBase)).toBe(
    1500,
  );
  expect(scrollPosition(map.timing, 999, "mania", scene.scrollBase)).toBe(
    499.5,
  );
  // lazer: one time range (11485 / speed ms) moves notes from the stage top to
  // the default hit position, 402 legacy units.
  expect(scene.speed).toBeCloseTo((20 * 402) / 11485);
});
