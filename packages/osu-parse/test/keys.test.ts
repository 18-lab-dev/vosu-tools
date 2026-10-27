import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyMods, maniaColumns, maniaKeyCount, parseOsu } from "../src";

/** The table the Rust crate `mania-keys` is tested against too. */
const table: { circleSize: number | string | null; keys: number | null }[] =
  JSON.parse(
    readFileSync(
      new URL("../../../crates/mania-keys/key-counts.json", import.meta.url),
      "utf8",
    ),
  );

test("maniaKeyCount matches the shared table", () => {
  expect(table.length).toBeGreaterThan(30);
  for (const { circleSize, keys } of table) {
    const size = circleSize === null ? undefined : Number(circleSize);
    if (keys === null) expect(() => maniaKeyCount(size), String(circleSize)).toThrow();
    else expect(maniaKeyCount(size), String(circleSize)).toBe(keys);
  }
});

const mania = (circleSize: string | null) =>
  parseOsu(
    `osu file format v14\n[General]\nMode: 3\n[Difficulty]\n${circleSize === null ? "" : `CircleSize:${circleSize}\n`}OverallDifficulty:8\n[HitObjects]\n0,192,1000,1,0,0:0:0:0:\n511,192,1500,1,0,0:0:0:0:\n`,
  );

test("maniaColumns: native maps from CircleSize, converts from the conversion", () => {
  expect(maniaColumns(mania("6.5"))).toBe(6);
  expect(maniaColumns(mania("7.5"))).toBe(8);
  expect(maniaColumns(mania("11"))).toBe(10);
  expect(maniaColumns(mania(null))).toBe(5);
  // A conversion's count (e.g. 10K with Dual Stages) is kept as it is.
  expect(maniaColumns({ ...mania("4"), maniaColumns: 20 })).toBe(20);
  // Mania mods use the same count: Mirror on 6.5 mirrors six columns.
  const mirrored = applyMods(mania("6.5"), [{ acronym: "MR" }]);
  expect(mirrored.objects.map((o) => Math.floor((o.x * 6) / 512))).toEqual([5, 0]);
});
