import { expect, test } from "bun:test";
import { parseSkinIni } from "@vosu-tools/osu-parse";
import goldenSkins from "./fixtures/mania-skins.json";
import golden from "./fixtures/mania-golden.json";
import {
  fallbackColumnIndex,
  maniaConfig,
  maniaLayout,
  type ImageSize,
} from "../src/mania";
import type { Skin } from "../src/skin";
import {
  compareCase,
  goldenSkin,
  type GoldenCase,
  type GoldenResult,
  type GoldenSkin,
} from "./maniaCompare";

const skinOf = (ini: string, version = 2.7): Skin => ({
  name: "test",
  assets: new Map(),
  sections: parseSkinIni(ini),
  version,
});
const sizes =
  (table: Record<string, [number, number]>): ImageSize =>
  (name) =>
    table[name] ? { width: table[name][0], height: table[name][1] } : undefined;

test("lazer places every legacy mania element where render-core does", () => {
  const skins = new Map(
    (goldenSkins.skins as unknown as GoldenSkin[]).map((skin) => [
      skin.name,
      goldenSkin(skin),
    ]),
  );
  const cases = goldenSkins.cases as GoldenCase[],
    results = golden as unknown as GoldenResult[];
  expect(results.map((r) => r.name)).toEqual(cases.map((c) => c.name));
  for (const [i, c] of cases.entries()) {
    const { skin, regions } = skins.get(c.skin)!;
    const result = results[i];
    // lazer drew something from the skin in every case.
    expect(result.items.filter((item) => item.kind).length).toBeGreaterThan(20);
    const mismatches = compareCase(c, result, skin, regions).map(
      (m) =>
        `${c.name}: ${m.reason} ${m.item ? `${m.item.kind} ${m.item.asset ?? m.item.type} column ${m.item.column}` : (m.nearest?.asset ?? "box")} expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.nearest?.rect)}`,
    );
    expect(mismatches).toEqual([]);
  }
});

test("the [Mania] decoder follows LegacyManiaSkinDecoder", () => {
  const config = maniaConfig(
    skinOf(
      "[Mania]\nHitPosition: 600\nKeys: 3\nColumnWidth: 10,x,20,30\nColumnSpacing: 4\nColumnLineWidth: 1,,3\nLightPosition: 450\nLightFramePerSecond: 0\nWidthForNoteHeightScale: 0\nNoteBodyStyle: RepeatTop\nNoteImage0: notes\\a.png\nKeyImage1D: keys/b@2x\nColour1: 1,2,3\nColour2: 1,2\n[Mania]\nKeys: 3\nColumnWidth: 99,99,99",
    ),
    3,
  );
  // Lines before Keys belong to it; HitPosition is clamped to 240-480.
  expect(config.hitPosition).toBeCloseTo(0);
  // Unparsable array entries read as zero; the first block for a key count wins.
  expect(config.columnWidth).toEqual([16, 0, 32]);
  expect(config.columnSpacing).toEqual([6.4, 0]);
  expect(config.columnLineWidth).toEqual([1, 0, 3, 2]);
  expect(config.lightPosition).toBeCloseTo(48);
  expect(config.lightFramePerSecond).toBe(24);
  // Zero WidthForNoteHeightScale means the narrowest column.
  expect(config.noteHeightWidth).toBe(0);
  expect(config.noteBodyStyle).toBe(2);
  expect(config.images.get("NoteImage0")).toBe("notes/a");
  expect(config.images.get("KeyImage1D")).toBe("keys/b");
  expect(config.colours.get("Colour1")).toEqual([1 / 255, 2 / 255, 3 / 255, 1]);
  expect(config.colours.has("Colour2")).toBe(false);
  // No section: lazer's LegacyManiaSkinConfiguration defaults.
  const defaults = maniaConfig(skinOf("[General]\nVersion: 2.4", 2.4), 2);
  expect(defaults.columnWidth).toEqual([48, 48]);
  expect(defaults.hitPosition).toBeCloseTo(124.8);
  expect(defaults.noteBodyStyle).toBe(0);
  expect(defaults.explosionScale).toEqual([1, 1]);
  expect(maniaConfig(skinOf("", 2.5), 2).noteBodyStyle).toBe(3);
});

test("fallback column images alternate from the stage edges with a special centre", () => {
  expect(
    Array.from({ length: 4 }, (_, i) => fallbackColumnIndex(4, i)),
  ).toEqual(["1", "2", "2", "1"]);
  expect(
    Array.from({ length: 7 }, (_, i) => fallbackColumnIndex(7, i)),
  ).toEqual(["1", "2", "1", "S", "1", "2", "1"]);
});

test("keys keep their image height at column width; notes scale by WidthForNoteHeightScale", () => {
  const layout = maniaLayout(
    maniaConfig(
      skinOf(
        "[Mania]\nKeys: 2\nColumnWidth: 70,40\nWidthForNoteHeightScale: 50\nKeyImage0: ring\nNoteImage0: note\nNoteImage1: note",
      ),
      2,
    ),
    sizes({ ring: [75, 187.5], note: [150, 146] }),
  );
  const [first, second] = layout.columns;
  // The receptor is stretched across the column but keeps its height, as in the game.
  expect(first.key).toMatchObject({
    width: 112,
    height: 187.5,
    y: 768 - 187.5,
  });
  // Note heights come from the shared WidthForNoteHeightScale, not each column's width.
  expect(first.note!.height).toBeCloseTo((146 * 80) / 150);
  expect(second.note!.height).toBeCloseTo((146 * 80) / 150);
  expect(second.key).toBeUndefined();
});
