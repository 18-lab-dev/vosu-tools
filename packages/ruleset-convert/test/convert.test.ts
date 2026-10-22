import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMods, parseOsu, timingAt } from "@vosu-tools/osu-parse";
import {
  catchObjects,
  convertBeatmap,
  isConvert,
  LegacyRandom,
  maniaKeys,
} from "../src/index";
import { compare, portOutput, type OracleOutput } from "./compare";
import { cases, fixtureName } from "./golden";

const fixtures = join(import.meta.dir, "fixtures");
const maps = readdirSync(fixtures).filter((name) => name.endsWith(".osu"));

// Expected outputs come from osu!lazer itself (test/reference via golden.ts --write-fixtures).
for (const map of maps)
  for (const { target, mods } of cases)
    test(`${map} → ${target}${mods.length ? ` +${mods.join(",")}` : ""} matches lazer`, () => {
      const expected = JSON.parse(
        readFileSync(join(fixtures, fixtureName(map, target, mods)), "utf8"),
      ) as OracleOutput;
      const actual = portOutput(
        readFileSync(join(fixtures, map), "utf8"),
        target,
        mods,
      );
      const result = compare(target, expected, actual);
      expect(result.mismatches).toEqual([]);
      expect(result.objects[0]).toBeGreaterThan(20);
    });

test("LegacyRandom reproduces stable's xorshift, including bit-buffered booleans", () => {
  // Reference values printed by osu.Game.Utils.LegacyRandom at 2026.1005.0-lazer.
  const random = new LegacyRandom(1337);
  expect([random.nextUInt(), random.nextUInt(), random.next()]).toEqual([
    274941776, 2661595948, 938046240,
  ]);
  const negative = new LegacyRandom(-5);
  expect([
    negative.nextInRange(-20, 20),
    negative.nextBelow(3),
    Number(negative.nextDouble().toFixed(6)),
    negative.nextBool(),
    negative.nextBool(),
  ]).toEqual([-14, 0, 0.435568, false, false]);
  const bits = new LegacyRandom(7);
  const word = new LegacyRandom(7).nextUInt();
  const flags = Array.from({ length: 32 }, () => bits.nextBool());
  expect(flags).toEqual(
    Array.from({ length: 32 }, (_, i) => ((word >>> i) & 1) === 1),
  );
});

const source = parseOsu(readFileSync(join(fixtures, "dense-v14.osu"), "utf8"));

test("only osu! maps played in another ruleset are converts", () => {
  expect(isConvert(source, 0)).toBe(false);
  expect(isConvert(source, 3)).toBe(true);
  expect(convertBeatmap(source, 0)).toBe(source);
  expect(convertBeatmap({ ...source, mode: 1 }, 3).mode).toBe(1);
});

test("mania converts carry lazer's key count, key mods and dual stages", () => {
  expect(maniaKeys(source)).toEqual({ columns: 7, stages: 1 });
  expect(maniaKeys(source, [{ acronym: "4K" }])).toEqual({
    columns: 4,
    stages: 1,
  });
  expect(maniaKeys(source, [{ acronym: "10K" }, { acronym: "DS" }])).toEqual({
    columns: 10,
    stages: 2,
  });
  const mania = convertBeatmap(source, 3, [{ acronym: "5K" }]);
  expect(mania.mode).toBe(3);
  expect(mania.general.Mode).toBe("3");
  expect(mania.difficulty.cs).toBe(5);
  const lanes = new Set(mania.objects.map((o) => Math.floor((o.x * 5) / 512)));
  expect([...lanes].every((lane) => lane >= 0 && lane < 5)).toBe(true);
  expect(mania.objects.some((o) => o.type & 128 && o.endTime > o.time)).toBe(
    true,
  );
  // osu! slider velocity never scrolls a mania convert.
  expect(
    mania.timing.every((t) => t.uninherited || t.beatLength === -100),
  ).toBe(true);
  expect(source.objects[0].type & 128).toBe(0);
});

test("taiko converts move slider velocity onto scroll speed at slider starts", () => {
  const taiko = convertBeatmap(source, 1);
  expect(taiko.mode).toBe(1);
  expect(taiko.objects.every((o) => [1, 2, 8].includes(o.type))).toBe(true);
  const firstSlowSlider = source.objects.find(
    (o) => o.type & 2 && o.time >= 8000,
  )!;
  // The 0.75× green line at 8 s only takes effect at the next slider.
  expect(timingAt(taiko.timing, 8000).sv).toBe(1);
  expect(timingAt(taiko.timing, firstSlowSlider.time).sv).toBeCloseTo(0.75, 9);
  expect(taiko.duration).toBeGreaterThan(0);
});

test("catch keeps the map and adds lazer's fruits, offsets and hyper-dashes", () => {
  const caught = convertBeatmap(source, 2);
  expect(caught.objects).toBe(source.objects);
  const plain = catchObjects(applyMods(caught, []));
  const hard = catchObjects(applyMods(caught, [{ acronym: "HR" }]));
  expect(plain.length).toBe(hard.length);
  expect(plain.some((o) => o.kind === "tiny")).toBe(true);
  expect(plain.some((o) => o.kind === "banana")).toBe(true);
  expect(hard.filter((o) => o.hyper).length).toBeGreaterThanOrEqual(
    plain.filter((o) => o.hyper).length,
  );
  expect(plain.every((o) => o.x >= 0 && o.x <= 512)).toBe(true);
});
