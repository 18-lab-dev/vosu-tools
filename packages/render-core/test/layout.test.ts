import { expect, test } from "bun:test";
import goldenResults from "./fixtures/layout-golden.json";
import layoutCases from "./fixtures/layout-cases.json";
import {
  compareLayout,
  placeLayout,
  withClassic,
  type LayoutCase,
  type LayoutResult,
} from "./layoutCompare";
import { goldenSkin, type GoldenSkin } from "./maniaCompare";

// Synthetic legacy skins and maps rendered by osu!lazer itself
// (test/layoutGolden.ts --write-fixtures): every drawable lazer takes from the
// skin must match render-core's scene, and render-core must draw nothing else.
const fixture = layoutCases as unknown as {
  skins: GoldenSkin[];
  maps: Record<string, string>;
  cases: LayoutCase[];
};
const results = goldenResults as unknown as LayoutResult[];

for (const [index, c] of fixture.cases.entries())
  test(`${c.name} matches osu!lazer's layout`, () => {
    const golden = fixture.skins.find((s) => s.name === c.skin)!,
      { skin, regions } = goldenSkin(golden),
      own = new Set(
        Object.keys(golden.files).map((f) =>
          f
            .replace(/\.png$/i, "")
            .replace(/@2x$/i, "")
            .replace(/-0$/, "")
            .toLowerCase(),
        ),
      );
    expect(results[index].name).toBe(c.name);
    // Lazer drew the case's skin elements at all.
    expect(results[index].items.length).toBeGreaterThan(5);
    const mismatches = compareLayout(
      c,
      results[index],
      placeLayout(c, fixture.maps[c.map], skin, withClassic(regions)),
      (asset) => own.has(asset),
    ).map((m) => `${m.reason} ${m.asset}`);
    expect(mismatches).toEqual([]);
  });
