import { expect, test } from "bun:test";
import golden from "./fixtures/judgement-golden.json";
import {
  autoplayEvents,
  compareJudgements,
  JUDGEMENT_MAPS,
  JUDGEMENT_SKIN,
  type JudgementCase,
} from "./judgementCompare";
import { placeLayout, withClassic, type LayoutResult } from "./layoutCompare";
import { goldenSkin } from "./maniaCompare";
import { CATCH_EXPLOSION_SIZES } from "../src/judgements";

/** Recorded by test/judgementGolden.ts from osu!lazer 2026.1005.0 under autoplay. */
const cases = golden as unknown as (JudgementCase & { result: LayoutResult })[];
// render-core draws catch's classic explosions itself (a built-in fallback
// for every skin); here they are plain regions of the same size.
const { skin, regions } = goldenSkin({
  ...JUDGEMENT_SKIN,
  files: {
    ...JUDGEMENT_SKIN.files,
    ...Object.fromEntries(Object.entries(CATCH_EXPLOSION_SIZES).map(([name, size]) => [`${name}.png`, [...size]])),
  },
});
/**
 * lazer's gameplay shifts the osu! playfield 8 osu! pixels down
 * (`OsuPlayfieldAdjustmentContainer.PlayfieldShift`, 12.8 game-space units);
 * render-core's scene centres it. That moves objects and judgements alike, so
 * the judgement comparison removes it.
 */
const unshift = (c: JudgementCase & { result: LayoutResult }): LayoutResult =>
  c.ruleset !== "osu"
    ? c.result
    : { ...c.result, items: c.result.items.map((i) => ({ ...i, quad: i.quad.map((v, k) => (k % 2 ? v - 12.8 : v)) })) };

test("the golden covers every ruleset", () => {
  expect(new Set(cases.map((c) => c.ruleset))).toEqual(new Set(["osu", "taiko", "catch", "mania"]));
  expect(cases.reduce((n, c) => n + c.result.items.length, 0)).toBeGreaterThan(20);
});

for (const c of cases)
  test(`${c.name}: judgements match osu!lazer`, () => {
    const placed = placeLayout(c, JUDGEMENT_MAPS[c.ruleset], skin, withClassic(regions), {
      judgements: autoplayEvents(c.ruleset),
    });
    const mismatches = compareJudgements(unshift(c), placed).map(
      (m) => `${m.reason} ${m.asset} lazer ${JSON.stringify(m.lazer)} ours ${JSON.stringify(m.ours)}`,
    );
    expect(mismatches).toEqual([]);
  });
