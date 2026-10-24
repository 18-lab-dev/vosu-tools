import { legacyBool } from "../src/osu";
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
test("a skinned taiko hit target replaces rather than duplicates its geometric fallback", () => {
  // lazer uses the legacy hit target (approach circle + big circle) only when
  // the skin has taikobigcircle.
  const map = parseOsu("[General]\nMode:1\n[HitObjects]\n256,192,1000,1,0"),
    scene = compileScene(
      map,
      {},
      new Map([
        ["approachcircle", region(99)],
        ["taikobigcircle", region(98)],
      ]),
    );
  const sprites = new Map<number, number>();
  let fallbacks = 0;
  for (let i = 0; i < scene.count; i++) {
    const d = scene.data.subarray(i * 24, i * 24 + 24);
    if (d[20] === 10) sprites.set(d[21], (sprites.get(d[21]) ?? 0) + 1);
    if (d[20] === 1 && d[12] === 0) fallbacks++;
  }
  expect(sprites.get(99)).toBe(1);
  expect(fallbacks).toBe(0);
});
test("spinners pick lazer's legacy style from the skin's own images, at any version", () => {
  // OsuLegacySkinTransformer: spinner-top without spinner-background is the
  // new style (whose approach circle needs the skin's own spinner-top);
  // spinner-background is the old style.
  const map = parseOsu("[HitObjects]\n256,192,1000,8,0,3000");
  const drawn = (names: string[], fallback: string[] = []) => {
    const regions = new Map(names.map((name, i) => [name, region(10 + i)]));
    const skin: Skin = {
      name: "spinner",
      version: 1,
      assets: new Map(),
      sections: new Map(),
      fallback: new Set(fallback),
    };
    const scene = compileScene(map, {}, regions, skin),
      ids = new Set<string>();
    for (let i = 0; i < scene.count; i++)
      if (scene.data[i * 24 + 20] === 10)
        ids.add(names[scene.data[i * 24 + 21] - 10]);
    return [...ids].sort();
  };
  const modern = [
    "spinner-circle",
    "spinner-bottom",
    "spinner-top",
    "spinner-approachcircle",
  ];
  expect(drawn(modern)).toEqual([
    "spinner-approachcircle",
    "spinner-bottom",
    "spinner-top",
  ]);
  expect(drawn([...modern, "spinner-background"])).toEqual([
    "spinner-approachcircle",
    "spinner-background",
    "spinner-circle",
  ]);
  // A skin with neither takes the built-in look's style, and only a skin's
  // own spinner-top brings the approach circle.
  expect(drawn(modern, ["spinner-top", "spinner-bottom"])).toEqual([
    "spinner-bottom",
    "spinner-top",
  ]);
  expect(
    drawn(["spinner-circle", "spinner-approachcircle"], ["spinner-circle"]),
  ).toEqual(["spinner-approachcircle", "spinner-circle"]);
});

test("skin.ini booleans read like lazer's LegacySkin", () => {
  expect(["1", "36", "true", "True", " 2 "].map(legacyBool)).toEqual([true, true, true, true, true]);
  expect(["0", "false", "FALSE"].map(legacyBool)).toEqual([false, false, false]);
  expect([undefined, "", "yes"].map(legacyBool)).toEqual([undefined, undefined, undefined]);
});
