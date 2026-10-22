import { expect, test } from "bun:test";
import { parseOsu, parseSkinIni, scrollPosition } from "@vosu-tools/osu-parse";
import { compileScene } from "../src/scene";
import type { Skin, AtlasRegion } from "../src/skin";
const text =
  "osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,250,4,1,0,100,1,0\n[HitObjects]\n64,192,2000,128,0,6000:0:0:0:0:";
test("bottom-cascaded hold bodies are distinct from top cascade and stretching", () => {
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
  for (const [style, motion, tiled] of [
    [0, 2, false],
    [1, 2, true],
    [2, 14, true],
  ] as const) {
    const skin: Skin = {
      name: "cascade",
      assets: new Map(),
      sections: parseSkinIni(
        `[Mania]\nKeys:4\nNoteImage0L:body\nNoteBodyStyle:${style}`,
      ),
    };
    const scene = compileScene(parseOsu(text), {}, regions, skin);
    let body = -1;
    for (let i = 0; i < scene.count; i++)
      if (
        scene.data[i * 24 + 12] === motion &&
        scene.data[i * 24 + 5] > scene.data[i * 24 + 4]
      ) {
        body = i;
        break;
      }
    expect(body).toBeGreaterThanOrEqual(0);
    expect(scene.data[body * 24 + 23] < 0).toBe(tiled);
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
  expect(scene.speed).toBeCloseTo((20 * 480) / 11485);
});
