import { describe, expect, test } from "bun:test";
import { missingSources, recoverSource, sourceFileNames } from "../src/missing-sources";
import { History, type KeymodeDraft, type SlotImage } from "../src/keymodes";
import { UPLOADS } from "../src/uploads";
const original: SlotImage = { skin: "lazer:A", sourceName: "Skin A", sourceHash: "hash", name: "key", files: [{ from: "key.png", suffix: ".png" }] };
const draft = (): KeymodeDraft => ({ images: { KeyImage0: { ...structuredClone(original), skin: UPLOADS, files: [{ from: "derived/key.png", suffix: ".png" }] } }, values: { ColumnWidth: "40,40,40,40" }, hit: { originals: { KeyImage0: { at: 402, width: 48, slot: structuredClone(original), prior: structuredClone(original), had: true } } } });
describe("missing draft sources", () => {
  test("overlap filenames include hidden originals and prior slots once, case-insensitively", () => {
    const d = draft(); (d.hit!.originals.KeyImage0.prior as SlotImage).files[0].from = "KEY.PNG";
    expect([...sourceFileNames({ "4": d, "7": draft() }, "lazer:A")]).toEqual(["key.png"]);
    expect([...sourceFileNames({ "4": d }, UPLOADS)]).toEqual(["derived/key.png"]);
  });
  test("includes geometry-only references, deduplicates slots, names and counts", () => {
    expect(missingSources({ "4": draft(), "7": draft() }, new Set())).toEqual([{ key: "lazer:A", name: "Skin A", hash: "hash", slots: 2, counts: [4, 7] }]);
    expect(missingSources({ "4": draft() }, new Set(["lazer:A"]))).toEqual([]);
  });
  test("old drafts use the identifier rather than guessing a name", () => {
    const d = draft(); delete d.hit!.originals.KeyImage0.slot.sourceName;
    expect(missingSources({ "4": d }, new Set())[0].name).toBe("lazer:A");
  });
  test("remap changes originals and prior, preserving retained images", () => {
    const d = draft(); recoverSource(d, "lazer:A", { kind: "remap", key: "lazer:B", name: "Skin B", hash: "other" });
    expect(d.hit!.originals.KeyImage0.slot.skin).toBe("lazer:B");
    expect((d.hit!.originals.KeyImage0.prior as SlotImage).skin).toBe("lazer:B");
    expect((d.images.KeyImage0 as SlotImage).skin).toBe(UPLOADS);
    expect(missingSources({ "4": d }, new Set(["lazer:B"]))).toEqual([]);
  });
  test("keep drops old geometry, preserving current images and values", () => {
    const d = draft(); const images = structuredClone(d.images); recoverSource(d, "lazer:A", { kind: "keep" });
    expect(d.hit).toBeUndefined(); expect(d.images).toEqual(images); expect(d.values.ColumnWidth).toBe("40,40,40,40");
  });
  test("keep refuses when original images were never copied", () => {
    const d = draft(); d.images.KeyImage0 = structuredClone(original);
    expect(() => recoverSource(d, "lazer:A", { kind: "keep" })).toThrow("no retained derived image");
  });
  test("remove returns affected slots to base and preserves unrelated slots", () => {
    const d = draft(); d.images.NoteImage0 = { value: "note" }; recoverSource(d, "lazer:A", { kind: "remove" });
    expect(d.images).toEqual({ NoteImage0: { value: "note" } }); expect(d.hit).toBeUndefined();
  });
  for (const kind of ["keep", "remove", "remap"] as const) test(`${kind} round trips through undo and redo`, () => {
    const before = draft(), after = structuredClone(before); recoverSource(after, "lazer:A", kind === "remap" ? { kind, key: "lazer:B", name: "Skin A" } : { kind });
    const history = new History(); history.push({ keys: 4, before, after, label: kind });
    expect(history.undo()?.before).toEqual(before); expect(history.redo()?.after).toEqual(after);
  });
});
