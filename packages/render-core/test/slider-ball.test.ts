import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { compileScene } from "../src/scene";
import { FOLLOW_CIRCLE, SLIDER_BALL } from "../src/osu";
import { goldenSkin } from "./maniaCompare";
import { sliderMap } from "./sliderBodyGolden";

test("the slider ball and follow circle never skip a frame between path pieces", () => {
  // One instance per path segment (and follow-circle event), half-open:
  // lazer shows the ball at every time, including exactly on a tick.
  const { skin, regions } = goldenSkin({
    name: "ball",
    ini: "[General]\nVersion: 2.7\n",
    files: { "sliderb.png": [128, 128], "sliderfollowcircle.png": [256, 256] },
  });
  const map = parseOsu(sliderMap(4)),
    long = map.objects.at(-1)!,
    scene = compileScene(map, {}, regions, skin);
  for (const [asset, motion] of [
    ["sliderb", SLIDER_BALL],
    ["sliderfollowcircle", FOLLOW_CIRCLE],
  ] as const) {
    const entry = regions.get(asset)!.first,
      lives: [number, number][] = [];
    for (let i = 0; i < scene.count; i++) {
      const d = scene.data.subarray(i * 24, i * 24 + 24);
      if (
        d[12] === motion &&
        d[21] === entry &&
        d[4] >= long.time &&
        d[4] < long.endTime
      )
        lives.push([d[6], d[7]]);
    }
    expect(lives.length).toBeGreaterThan(100);
    const alive = (time: number) => {
      const t = Math.fround(time);
      return lives.filter(([from, until]) => from <= t && t <= until).length;
    };
    for (const [from, until] of lives)
      for (const t of [from - 0.25, from, from + 0.25, until])
        if (t > long.time && t < long.endTime)
          expect([asset, t, alive(t)]).toEqual([asset, t, 1]);
    // Exactly on a tick (a follow-circle pop): lazer 2026.1005.0 draws both.
    for (const tick of long.ticks)
      expect(alive(long.time + tick * long.span)).toBe(1);
  }
});
