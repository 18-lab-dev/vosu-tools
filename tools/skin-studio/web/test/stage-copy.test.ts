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

test("copy from takes only the chosen rows, as one new selection", () => {
  const slot = (name: string) => ({ skin: "source", name, files: [{ from: `${name}.png`, suffix: ".png" }] });
  const copied = copyStage(4, 4, (key) => slot(key), (key) => ({ HitPosition: "450", ColumnWidth: "40,40,40,40", Colour1: "1,2,3,255" })[key]);
  const mine = () => ({ value: "mine" });
  const start = (): KeymodeDraft => ({
    images: { KeyImage0: mine(), NoteImage0: mine(), NoteImage0H: mine(), StageLeft: mine() },
    values: { HitPosition: "402", ColumnWidth: "60,60,60,60" },
    autoNoteHeight: "50",
    hit: { originals: { KeyImage0: { at: 402, slot: slot("old"), had: false } } },
  });
  const rows = (rows: "all" | "keys" | "notes" | "values") => {
    const draft = start();
    applyStageCopy(draft, copied, rows);
    return draft;
  };
  const keys = rows("keys");
  expect(Object.keys(keys.images).filter((k) => (keys.images[k] as { name?: string }).name).sort()).toEqual(["KeyImage0", "KeyImage0D", "KeyImage1", "KeyImage1D", "KeyImage2", "KeyImage2D", "KeyImage3", "KeyImage3D"]);
  expect(keys.images.NoteImage0).toEqual(mine());
  expect(keys.images.StageLeft).toEqual(mine());
  expect(keys.values).toEqual({ HitPosition: "402", ColumnWidth: "60,60,60,60" });
  expect(keys.autoNoteHeight).toBe("50");
  expect(keys.hit).toBeUndefined();

  const notes = rows("notes");
  expect(notes.images.KeyImage0).toEqual(mine());
  for (const suffix of ["", "H", "L", "T"]) for (let c = 0; c < 4; c++)
    expect(notes.images[`NoteImage${c}${suffix}`]).toEqual(slot(`NoteImage${c}${suffix}`));
  expect(notes.images.StageLeft).toEqual(mine());
  expect(notes.values.HitPosition).toBe("402");

  const values = rows("values");
  expect(values.images).toEqual(start().images);
  expect(values.values.HitPosition).toBe("450");
  expect(values.values.ColumnWidth).toBe("40,40,40,40");
  expect(values.autoNoteHeight).toBeUndefined();
  expect(values.hit).toBeUndefined();

  // All is today's copy.
  const all = rows("all"), before = start();
  applyStageCopy(before, copied);
  expect(all).toEqual(before);
  expect(all.images.StageLeft).toEqual(slot("StageLeft"));
});
