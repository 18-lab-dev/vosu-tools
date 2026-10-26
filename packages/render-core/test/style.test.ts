import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { withFallback } from "../src/builtin";
import { compileScene, type Scene } from "../src/scene";
import type { Skin } from "../src/skin";

const source =
  "osu file format v14\n[Difficulty]\nCircleSize:4\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,1000,1,0\n192,192,1500,2,4,B|256:100|400:192,2,280";
const bitmap = (width = 64) =>
  ({ width, height: width, close() {} }) as unknown as ImageBitmap;
const skin = (assets: string[], style?: Skin["style"]): Skin => ({
  name: "t",
  assets: new Map(assets.map((name) => [name, bitmap()])),
  sections: new Map(),
  style,
});
/** Instances by shape id (field 20 of the 24-float instance). */
const shapes = (data: Float32Array) => {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 24) out.push(data[i + 20]);
  return out;
};

test("skinned sliders use the client body profile; unskinned keep the flat look", () => {
  const map = parseOsu(source);
  const plain = compileScene(map, {}, new Map());
  expect(shapes(plain.data)).not.toContain(12);
  const legacy = compileScene(map, {}, new Map(), skin([]));
  const legacyShapes = shapes(legacy.data);
  expect(legacyShapes).toContain(12);
  expect(legacyShapes).not.toContain(2);
  // One capsule per path segment carrying the whole profile (shadow, border
  // and body; shape parameter: the border portion), drawn as slider bodies.
  const borders: number[] = [];
  for (let i = 0; i < legacy.count; i++)
    if (legacy.data[i * 24 + 20] === 12) borders.push(legacy.data[i * 24 + 21]);
  expect(borders.length).toBe(
    parseOsu(source).objects.reduce(
      (n, o) => n + (o.type & 2 ? o.path.length - 1 : 0),
      0,
    ),
  );
  expect(new Set(borders)).toEqual(new Set([0.1875]));
  const bodies = legacy.chunks.filter((c) => c.bodies);
  expect(bodies.reduce((n, c) => n + c.count, 0)).toBe(borders.length);
  for (const c of bodies)
    for (let i = c.first; i < c.first + c.count; i++)
      expect(legacy.data[i * 24 + 20]).toBe(12);
  // The profile code (legacy = 1, opacity 0.7) rides in the UV slot.
  const first = legacyShapes.indexOf(12);
  expect(legacy.data[first * 24 + 19]).toBeCloseTo(10.7, 5);
  const argon = compileScene(
    map,
    {},
    new Map(),
    skin([], {
      slider: { profile: "argon", radius: 0.862, border: 0.2, alpha: 0.98 },
    }),
  );
  const a = shapes(argon.data).indexOf(12);
  expect(argon.data[a * 24 + 19]).toBeCloseTo(30.98, 5);
});

test("beatmap colours can be switched off in favour of skin colours", () => {
  const map = parseOsu(
    source.replace("[HitObjects]", "[Colours]\nCombo1:10,20,30\n[HitObjects]"),
  );
  const colours = new Map([["Colours", [{ Combo1: "200,100,50" }]]]);
  const withSkin: Skin = { ...skin([]), sections: colours };
  /** Tints of all untextured disc instances (hit circles among them). */
  const tints = (s: Scene) => {
    const out: string[] = [];
    for (let i = 0; i < s.count; i++)
      if (s.data[i * 24 + 20] === 0)
        out.push(
          [...s.data.slice(i * 24 + 8, i * 24 + 11)]
            .map((v) => Math.round(v * 255))
            .join(","),
        );
    return out;
  };
  expect(tints(compileScene(map, {}, new Map(), withSkin))).toContain(
    "10,20,30",
  );
  const own = tints(
    compileScene(map, { beatmapColours: false }, new Map(), withSkin),
  );
  expect(own).toContain("200,100,50");
  expect(own).not.toContain("10,20,30");
});

test("withFallback lets the skin win and fills gaps from the fallback", () => {
  const own = skin(["hitcircle", "mania-note1"]),
    fallback = skin(["hitcircle", "approachcircle", "builtin-note"], {
      taiko: { centre: [1, 0, 0], rim: [0, 0, 1] },
      slider: { profile: "argon", radius: 1, border: 0.2, alpha: 1 },
    });
  fallback.sections.set("Mania", [{ Keys: "4" }]);
  const merged = withFallback(own, fallback);
  expect(merged.assets.get("hitcircle")).toBe(own.assets.get("hitcircle"));
  expect(merged.assets.get("approachcircle")).toBe(
    fallback.assets.get("approachcircle"),
  );
  // The skin has mania elements of its own, so the fallback stage stays out.
  expect(merged.sections.has("Mania")).toBe(false);
  // Taiko colours come from the fallback; the slider look stays the file skin's (legacy).
  expect(merged.style).toEqual({
    taiko: { centre: [1, 0, 0], rim: [0, 0, 1] },
  });
  const noMania = withFallback(skin(["hitcircle"]), fallback);
  expect(noMania.sections.get("Mania")).toEqual([{ Keys: "4" }]);
});
