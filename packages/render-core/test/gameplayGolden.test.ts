import { expect, test } from "bun:test";
import golden from "./fixtures/gameplay-golden.json";
import { CursorModel } from "../src/gameplay";
import type { InputFrame } from "../src/scene";
import { gameSpace, SPACE_SCALE } from "../src/taiko";
import { compareGameplay, GAMEPLAY_MAPS, GAMEPLAY_SKINS, lazerGameplayItems, type GameplayGolden } from "./gameplayCompare";
import { placeLayout, withClassic, type PlacedItem } from "./layoutCompare";
import { goldenSkin } from "./maniaCompare";

/** Recorded by test/gameplayGolden.ts from osu!lazer 2026.1005.0 under autoplay. */
const cases = golden as unknown as (GameplayGolden & { frames?: InputFrame[] })[];
const frames = new Map(cases.filter((c) => c.frames).map((c) => [c.ruleset, c.frames!]));
const skins = new Map(GAMEPLAY_SKINS.map((s) => [s.name, goldenSkin(s)]));

/** lazer's gameplay osu! playfield is 8 osu! pixels lower (render-core's `playfieldShift`). */
const SHIFT = 8 * SPACE_SCALE;

/** The skinned cursor's sprites at the case's time, in game space. */
function cursorItems(c: GameplayGolden, input: readonly InputFrame[]): PlacedItem[] {
  const { regions, skin } = skins.get(c.skin)!;
  const general = skin.sections.get("General")?.[0] ?? {},
    flag = (key: string) => (general[key] ?? "1").trim() !== "0";
  const model = new CursorModel(input, {
    size: (asset) => {
      const r = regions.get(asset);
      return r ? [r.width ?? 0, r.height ?? 0] : undefined;
    },
    centre: flag("CursorCentre"),
    rotate: flag("CursorRotate"),
    expand: flag("CursorExpand"),
    trailRotate: flag("CursorTrailRotate"),
  });
  const space = gameSpace(c.width / c.height);
  return model
    .sprites(c.time, 1, 511)
    .filter((s) => s.asset !== "cursortrail")
    .map((s, index) => ({
      index,
      asset: s.asset,
      centre: [(s.x - 256) * SPACE_SCALE + space.width / 2, (s.y - 192) * SPACE_SCALE + space.height / 2 + SHIFT],
      size: [Math.abs(s.w) * SPACE_SCALE, s.h * SPACE_SCALE],
      angle: (s.angle * 180) / Math.PI,
      colour: [1, 1, 1],
      alpha: s.alpha,
      motion: 35,
    }));
}

test("the golden covers taiko, catch and osu! with lazer's replays", () => {
  expect([...frames.keys()].sort()).toEqual(["catch", "osu", "taiko"]);
  expect(cases.reduce((n, c) => n + c.result.items.length, 0)).toBeGreaterThan(60);
});

for (const c of cases)
  test(`${c.name}: replay-driven gameplay matches osu!lazer`, () => {
    const input = frames.get(c.ruleset)!;
    const { skin, regions } = skins.get(c.skin)!;
    let ours: PlacedItem[];
    if (c.ruleset === "osu") ours = cursorItems(c, input);
    else {
      const placed = placeLayout(c, GAMEPLAY_MAPS[c.ruleset], skin, withClassic(regions), { input });
      ours = placed.filter(
        (p) =>
          p.motion === 35 &&
          (c.ruleset === "taiko" ? /^taiko-drum-/.test(p.asset) : /^fruit-/.test(p.asset)),
      );
    }
    // Plate objects stacked onto another move by lazer's unseeded RNG.
    const mismatches = compareGameplay(lazerGameplayItems(c.ruleset, c.result.items), ours, (asset) =>
      c.ruleset === "catch" && !/^fruit-catcher/.test(asset),
    ).map((m) => `${m.reason} ${m.asset} lazer ${JSON.stringify(m.lazer)} ours ${JSON.stringify(m.ours)}`);
    expect(mismatches).toEqual([]);
  });
