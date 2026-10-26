import { expect, test } from "bun:test";
import fixture from "./fixtures/slider-bodies.json";
import { goldenSkin } from "./maniaCompare";
import { compareBodies, type SliderBodyCase } from "./sliderBodyCompare";

/**
 * Slider bodies rendered by osu!lazer 2026.1005.0 (test/sliderBodyGolden.ts):
 * tight S curves and loops tighter than the body, at CS 4 and 6, with a legacy
 * skin's slider colours and with the classic skin, fully shown, snaking in
 * while fading in (60 % of the path at 30 % alpha) and snaking out halfway
 * through the last span. render-core must show the same part of the path at
 * the same alpha (lazer cuts the path, it never fades parts of it) and colour
 * every pixel by its nearest segment like osu!framework's Path: no arcs where
 * segment capsules overlap, the same inner cusps, border and gradient.
 */
const cases = fixture.cases as unknown as SliderBodyCase[];
const maps = fixture.maps as Record<string, string>;
const skins = fixture.skins as Record<string, string | null>;

test("the golden covers tight curves and loops at two circle sizes", () => {
  expect(cases.length).toBe(72);
  expect(cases.filter((c) => c.name.includes("-snaking-")).length).toBe(48);
  expect(new Set(cases.map((c) => c.map))).toEqual(new Set(["cs4", "cs6"]));
  for (const c of cases) expect(c.paths.length).toBe(1);
});

for (const c of cases)
  test(`${c.name}: slider body matches osu!lazer's`, () => {
    const ini = skins[c.skin];
    const { skin } = goldenSkin({
      name: c.skin,
      ini: ini ?? undefined,
      files: {},
    });
    const result = compareBodies(c, maps[c.map], skin);
    expect(result.pixels).toBeGreaterThan(2000);
    // Sub-pixel differences at the border's edges only.
    expect(result.mean).toBeLessThan(1);
    expect(result.over8).toBeLessThan(0.01);
    expect(result.max).toBeLessThan(16);
  });
