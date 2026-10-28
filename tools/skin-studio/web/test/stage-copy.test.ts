import { expect, test } from "bun:test";
import { columnKeys, spec } from "@vosu-tools/skin-spec";
import { applyStageCopy, copyStage, remapColumns, type KeymodeDraft } from "../src/keymodes";

test("copy key count includes every schema stage value, not just widths and colours", () => {
  const source: Record<string, string> = {
    HitPosition: "450", WidthForNoteHeightScale: "90", NoteBodyStyle: "1",
    ColumnStart: "200", ColumnRight: "400", LightPosition: "455", ScorePosition: "200",
    UpsideDown: "1", ColumnWidth: "40,50,60,70", ColumnSpacing: "1,2,3",
    ColumnLineWidth: "1,2,3,4,5", NoteBodyStyle0: "2", NoteFlipWhenUpsideDown0T: "0",
  };
  const copied = copyStage(7, 4, () => null, (key) => source[key]);
  for (const field of spec.filter((field) => field.section === "Mania" && field.key !== "Keys" && field.type !== "image" && !field.key.includes("#") && field.columns === undefined))
    expect(copied.values[field.key]).toBe(source[field.key] ?? null);
  expect(copied.values.ColumnSpacing).toBe("1,2,1,2,,3");
  expect(copied.values.ColumnLineWidth).toBe("1,2,1,2,4,3,4,5");
  expect(copied.values.Keys).toBeUndefined();
  const mapping = remapColumns(7, 4);
  for (let c = 0; c < 7; c++) for (const field of columnKeys(c).filter((field) => field.type !== "image"))
    expect(copied.values[field.key]).toBe(source[field.pattern.replace("#", String(mapping[c] + (field.indexBase ?? 0)))] ?? null);
});

for (const moveReceptors of [false, true]) test(`stage copy preserves receptor preference and invalidates obsolete captures (${moveReceptors})`, () => {
  const slot = { skin: "source", name: "key", files: [{ from: "key.png", suffix: ".png" }] };
  const target: KeymodeDraft = { images: {}, values: {}, moveReceptors, keepProportions: false,
    hit: { originals: { KeyImage0: { at: 432, slot, had: false } } } };
  applyStageCopy(target, copyStage(4, 4, () => slot, (key) => key === "HitPosition" ? "450" : undefined));
  expect(target.values.HitPosition).toBe("450");
  expect(target.moveReceptors).toBe(moveReceptors);
  expect(target.keepProportions).toBe(false);
  expect(target.hit).toBeUndefined();
});
