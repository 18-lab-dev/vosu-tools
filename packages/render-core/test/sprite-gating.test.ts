import { test, expect } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { compileScene } from "../src/scene";
import type { Skin, AtlasRegion } from "../src/skin";
const region = (first: number): AtlasRegion => ({
  u: 0,
  v: 0,
  w: 0.1,
  h: 0.1,
  width: 128,
  height: 128,
  first,
  count: 1,
  fps: 60,
});
test("a skinned taiko hit position replaces rather than duplicates its geometric fallback", () => {
  const map = parseOsu("[General]\nMode:1\n[HitObjects]\n256,192,1000,1,0"),
    scene = compileScene(map, {}, new Map([["approachcircle", region(99)]]));
  let count = 0;
  for (let i = 0; i < scene.count; i++)
    if (scene.data[i * 24 + 20] === 10 && scene.data[i * 24 + 21] === 99)
      count++;
  expect(count).toBe(1);
});
test("modern spinner images suppress legacy sprites only at the supported skin version", () => {
  const map = parseOsu("[HitObjects]\n256,192,1000,8,0,3000"),
    regions = new Map([
      ["spinner-circle", region(10)],
      ["spinner-bottom", region(20)],
      ["spinner-top", region(21)],
      ["spinner-approachcircle", region(30)],
    ]);
  for (const version of [1, 2.7]) {
    const skin: Skin = {
        name: "spinner",
        version,
        assets: new Map(),
        sections: new Map(),
      },
      scene = compileScene(map, {}, regions, skin),
      ids = [];
    for (let i = 0; i < scene.count; i++)
      if (scene.data[i * 24 + 20] === 10) ids.push(scene.data[i * 24 + 21]);
    expect(ids.includes(10)).toBe(version === 1);
    expect(ids.includes(20)).toBe(version >= 2);
    expect(ids.includes(30)).toBe(version === 1);
  }
});
