import { expect, test } from "bun:test";
import { maniaConfig } from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { maniaValue } from "@vosu-tools/skin-spec";
import {
  History,
  applyToAll,
  assignSlots,
  copyStage,
  defaultPattern,
  imageUnit,
  mirror,
  remapColumns,
  stageImages,
  stageStatus,
  touchedKeys,
  type KeymodeDraft,
  type Slot,
} from "../src/keymodes";
import { compose, hasEdits, inPlaceRemovals, type SkinData } from "../src/plan";
import {
  MAX_UPLOAD_BYTES,
  UPLOADS,
  checkDrop,
  droppedName,
  formatBytes,
  removeQuestion,
  uploadUsage,
} from "../src/uploads";

const keysSkin: SkinData = {
  key: "/skins/Keys",
  name: "Keys",
  text: "[General]\nName: Keys\n",
  files: ["mania-key1.png", "mania-key1@2x.png", "up/key.png"],
};
const notesSkin: SkinData = {
  key: "/skins/Notes",
  name: "Notes",
  text: "[General]\nName: Notes\n[Mania]\nKeys: 4\nNoteImage0: arrows/left\n",
  files: ["arrows/left-0.png", "arrows/left-1.png", "arrows/left-0@2x.png", "arrows/left.png"],
};
const skins = new Map([
  [keysSkin.key, keysSkin],
  [notesSkin.key, notesSkin],
]);

test("an image unit carries its @2x and frames with their suffixes", () => {
  expect(imageUnit(notesSkin.files, "Arrows/Left")).toEqual([
    { from: "arrows/left.png", suffix: ".png" },
    { from: "arrows/left-0.png", suffix: "-0.png" },
    { from: "arrows/left-0@2x.png", suffix: "-0@2x.png" },
    { from: "arrows/left-1.png", suffix: "-1.png" },
  ]);
  expect(imageUnit(notesSkin.files, "nothing")).toEqual([]);
});

test("a 7K draft from two skins writes keys and copies files under mania/7k", () => {
  const key = { skin: keysSkin.key, name: "mania-key1", files: imageUnit(keysSkin.files, "mania-key1") };
  const note = { skin: notesSkin.key, name: "arrows/left", files: imageUnit(notesSkin.files, "arrows/left") };
  // Another image with the same file name gets "(2)", never "-2" (a frame).
  const other = { skin: notesSkin.key, name: "up/key", files: [{ from: "up/key.png", suffix: ".png" }] };
  const { plan } = compose(
    {
      name: "Mix",
      base: null,
      picks: {},
      keymodes: {
        "7": {
          images: { KeyImage0: key, KeyImage6: key, NoteImage0: note, KeyImage1: other, KeyImage2: { value: "mania/7k/key" }, NoteImage3: null },
          values: { ColumnWidth: "40,40,40,50,40,40,40", Colour4: "10,20,30,255" },
        },
      },
    },
    skins,
  );
  const ini = plan.ini;
  expect(maniaValue(ini, 7, "KeyImage0")).toBe("mania/7k/mania-key1");
  expect(maniaValue(ini, 7, "KeyImage6")).toBe("mania/7k/mania-key1");
  expect(maniaValue(ini, 7, "NoteImage0")).toBe("mania/7k/left");
  expect(maniaValue(ini, 7, "KeyImage1")).toBe("mania/7k/key");
  expect(maniaValue(ini, 7, "ColumnWidth")).toBe("40,40,40,50,40,40,40");
  expect(maniaValue(ini, 7, "NoteImage3")).toBeUndefined();
  const files = plan.sources.flatMap((s) => s.files.map((f) => [s.skin, ...(typeof f === "string" ? [f, f] : f)]));
  expect(files).toContainEqual([keysSkin.key, "mania-key1@2x.png", "mania/7k/mania-key1@2x.png"]);
  expect(files).toContainEqual([notesSkin.key, "arrows/left-0@2x.png", "mania/7k/left-0@2x.png"]);
  expect(files).toContainEqual([notesSkin.key, "up/key.png", "mania/7k/key.png"]);
  // One copy for two columns.
  expect(files.filter((f) => f[2] === "mania/7k/mania-key1.png")).toHaveLength(1);
  // The values read back through render-core as the renderer reads them.
  const config = maniaConfig(readSkinIni(ini), 7);
  expect(config.images.get("NoteImage0")).toBe("mania/7k/left");
  expect(config.columnWidth[3]).toBeCloseTo(50 * 1.6);
  // And the stage resolves the copies from the mix's files.
  const out = plan.sources.flatMap((s) => s.files.map((f) => (typeof f === "string" ? f : f[1])));
  const by = new Map(stageImages(ini, out, 7).map((r) => [r.key, r]));
  expect(by.get("KeyImage0")!.source).toBe("skin.ini");
  expect(by.get("NoteImage0")!.drawn?.name).toBe("mania/7k/left");
  expect(by.get("KeyImage3")!.source).toBe("built-in");
});

test("5K derived receptors with the same display name retain each column's files", () => {
  const images: Record<string, Slot> = {};
  for (let column = 0; column < 5; column++)
    images[`KeyImage${column}`] = {
      skin: UPLOADS, name: "kd_left1",
      files: [{ from: `${column === 0 ? "source" : "scaled"}/kd_left1@2x.png`, suffix: "@2x.png" }],
    };
  const { plan } = compose({
    name: "Mix", base: null, picks: {},
    keymodes: { "5": { images, values: { ColumnWidth: "60,60,60,60,60", HitPosition: "455" } } },
  }, skins);
  const destinations = plan.sources.flatMap((s) => s.files.map((f) => typeof f === "string" ? [f, f] : f));
  for (let column = 0; column < 5; column++) {
    const name = maniaValue(plan.ini, 5, `KeyImage${column}`);
    expect(destinations.find((f) => f[1] === `${name}@2x.png`)?.[0])
      .toBe(`${column === 0 ? "source" : "scaled"}/kd_left1@2x.png`);
  }
  expect(new Set(destinations.map((f) => f[1])).size).toBe(2);
});

test("mixed-source derived images cannot alias by their shared basename", () => {
  const images = Object.fromEntries(["a", "b", "c", "d", "e"].map((source, column) => [
    `KeyImage${column}`, { skin: UPLOADS, name: "key", files: [{ from: `${source}/key.png`, suffix: ".png" }] },
  ]));
  const { plan } = compose({ name: "Mix", base: null, picks: {}, keymodes: { "5": { images, values: {} } } }, skins);
  expect(new Set(Array.from({ length: 5 }, (_, c) => maniaValue(plan.ini, 5, `KeyImage${c}`))).size).toBe(5);
  expect(plan.sources.flatMap((s) => s.files)).toHaveLength(5);
});

test("5K and 7K derived copies and HitPosition remain scoped to their key count", () => {
  const keymodes: Record<string, KeymodeDraft> = {};
  for (const count of [5, 7]) keymodes[count] = {
    images: Object.fromEntries(Array.from({ length: count }, (_, column) => [
      `KeyImage${column}`, { skin: UPLOADS, name: "kd_left1", files: [
        { from: `${count}k-${column}/kd_left1@2x.png`, suffix: "@2x.png" },
      ] },
    ])),
    values: { ColumnWidth: Array(count).fill(count === 5 ? "60" : "80").join(","), HitPosition: count === 5 ? "455" : "440" },
  };
  const { plan } = compose({ name: "Mix", base: null, picks: {}, keymodes }, skins);
  const files = plan.sources.flatMap((source) => source.files);
  for (const count of [5, 7]) {
    expect(maniaValue(plan.ini, count, "HitPosition")).toBe(count === 5 ? "455" : "440");
    for (let column = 0; column < count; column++) {
      const name = maniaValue(plan.ini, count, `KeyImage${column}`);
      expect(name).toStartWith(`mania/${count}k/`);
      expect(files).toContainEqual([`${count}k-${column}/kd_left1@2x.png`, `${name}@2x.png`]);
    }
  }
});

test("a stage taken copies the default-named images it draws, and an added count gets a block", () => {
  const { plan } = compose({ name: "M", base: null, picks: {}, keymodes: { "5": { images: {}, values: {} } } }, skins);
  expect(plan.ini).toContain("[Mania]\r\nKeys: 5");
});

const current: (map: Record<string, string>) => (key: string) => Slot = (map) => (key) =>
  map[key] ? { value: map[key] } : null;

test("bulk actions: apply to all, mirror, osu! pattern", () => {
  const now = current({ NoteImage0: "a", NoteImage1: "b", NoteImage2: "c", KeyImage0: "k" });
  expect(Object.keys(applyToAll(4, "NoteImage#", 1, now))).toEqual(["NoteImage0", "NoteImage2", "NoteImage3"]);
  expect(applyToAll(4, "NoteImage#", 1, now).NoteImage3).toEqual({ value: "b" });
  const mirrored = mirror(7, now);
  expect(mirrored.NoteImage6).toEqual({ value: "a" });
  expect(mirrored.NoteImage5).toEqual({ value: "b" });
  expect(mirrored.NoteImage4).toEqual({ value: "c" });
  expect(mirrored.NoteImage3).toBeUndefined();
  expect(mirrored.KeyImage6).toEqual({ value: "k" });
  // 7K kinds 1 2 1 S 1 2 1: column 3 is S and keeps its own.
  const pattern = defaultPattern(7, now);
  expect(pattern.NoteImage2).toEqual({ value: "a" });
  expect(pattern.NoteImage5).toEqual({ value: "b" });
  expect(pattern.NoteImage3).toBeUndefined();
});

test("copying a key count remaps columns by kind and position", () => {
  expect(remapColumns(7, 4)).toEqual([0, 1, 0, 1, 3, 2, 3]);
  expect(remapColumns(4, 7)).toEqual([0, 1, 5, 6]);
  expect(remapColumns(4, 4)).toEqual([0, 1, 2, 3]);
  const copied = copyStage(
    7,
    4,
    (key) => ({ value: key }),
    (key) => ({ ColumnWidth: "10,20,30,40", ColumnLineWidth: "1,2,3,4,5", Colour1: "1,1,1" })[key],
  );
  expect(copied.images.KeyImage6).toEqual({ value: "KeyImage3" });
  expect(copied.images.StageHint).toEqual({ value: "StageHint" });
  expect(copied.values.ColumnWidth).toBe("10,20,10,20,40,30,40");
  expect(copied.values.ColumnLineWidth).toBe("1,2,1,2,4,3,4,5");
  expect(copied.values.Colour1).toBe("1,1,1");
  expect(copied.values.Colour2).toBeNull();
});

test("status, touched keys and undo history", () => {
  const text = "[Mania]\nKeys: 4\n";
  expect(stageStatus(stageImages(text, [], 4))).toBe("fallback");
  expect(stageStatus(stageImages("[Mania]\nKeys: 4\nNoteImage0: gone\n", [], 4))).toBe("missing");
  const all = ["1", "2", "S"].flatMap((f) =>
    ["key", "keyD", "note", "noteH", "noteL", "noteT"].map((kind) =>
      `mania-${kind.replace(/^(key|note)/, `$1${f}`)}.png`,
    ),
  );
  expect(stageStatus(stageImages(text, all, 4))).toBe("complete");
  expect(
    touchedKeys({ images: { A: null }, values: {} }, { images: { B: null }, values: { C: "1" } }).sort(),
  ).toEqual(["A", "B", "C"]);
  const history = new History();
  history.push({ keys: 4, before: undefined, after: { images: {}, values: {} }, label: "Add 4K" });
  history.push({ keys: 4, before: { images: {}, values: {} }, after: { images: { A: null }, values: {} }, label: "Clear" });
  expect(history.undo()?.label).toBe("Clear");
  expect(history.next).toEqual({ undo: "Add 4K", redo: "Clear" });
  expect(history.redo()?.after?.images).toEqual({ A: null });
  history.undo();
  history.push({ keys: 4, before: undefined, after: undefined, label: "Other" });
  expect(history.canRedo).toBe(false);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

test("dropped files: names, types, sizes, @2x pairs and frame sequences", () => {
  expect(droppedName("../evil.png")).toEqual({ error: "../evil.png: a file name, not a path" });
  expect(droppedName("C:\\x.png")).toHaveProperty("error");
  expect(droppedName("notes.txt")).toHaveProperty("error");
  expect(droppedName("a:b?.png")).toEqual({ name: "a_b_.png" });
  expect(droppedName("CON.png")).toEqual({ name: "CON_.png" });
  const { images, errors } = checkDrop([
    { name: "note.png", size: 10, head: PNG },
    { name: "note@2x.png", size: 10, head: PNG },
    { name: "hold-0.png", size: 10, head: PNG },
    { name: "hold-1.jpg", size: 10, head: JPEG },
    { name: "fake.png", size: 10, head: JPEG },
    { name: "huge.png", size: MAX_UPLOAD_BYTES + 1, head: PNG },
    { name: "empty.png", size: 0, head: PNG },
    { name: "readme.txt", size: 3, head: new Uint8Array(8) },
    { name: "../up.png", size: 10, head: PNG },
  ]);
  expect(images).toEqual([
    { name: "note", files: [{ index: 0, name: "note.png", suffix: ".png" }, { index: 1, name: "note@2x.png", suffix: "@2x.png" }] },
    { name: "hold", files: [{ index: 2, name: "hold-0.png", suffix: "-0.png" }, { index: 3, name: "hold-1.jpg", suffix: "-1.jpg" }] },
  ]);
  expect(errors).toHaveLength(5);
  expect(errors.join()).toContain("fake.png is not a PNG");
  expect(errors.join()).toContain("at most 1 MiB");
  const gap = checkDrop([
    { name: "x-0.png", size: 1, head: PNG },
    { name: "x-2.png", size: 1, head: PNG },
  ]);
  expect(gap.images).toEqual([]);
  expect(gap.errors[0]).toContain("no -1");
});

test("names that differ only in case are one file: the second is refused", () => {
  const { images, errors } = checkDrop([
    { name: "Key.png", size: 1, head: PNG },
    { name: "key.PNG", size: 1, head: PNG },
  ]);
  expect(images.map((i) => i.name)).toEqual(["Key"]);
  expect(errors).toEqual(["key.PNG: same name as Key.png apart from case"]);
});

test("dropped files: a referenced upload is kept, only unused ones are offered", () => {
  const files = [
    { name: "00000000000000aa/key.png", size: 2048 },
    { name: "00000000000000aa/key@2x.png", size: 4096 },
    { name: "00000000000000aa/old.png", size: 1024 },
    { name: "00000000000000bb/.used", size: 0 },
  ];
  const keymodes = {
    "7": {
      images: {
        KeyImage0: { skin: UPLOADS, name: "key", files: [{ from: "00000000000000aa/key.png", suffix: ".png" }, { from: "00000000000000AA/key@2x.png", suffix: "@2x.png" }] },
        KeyImage1: { skin: "/skins/Other", name: "old", files: [{ from: "00000000000000aa/old.png", suffix: ".png" }] },
        NoteImage0: null,
      },
      values: {},
    },
  };
  const { used, unused } = uploadUsage(files, keymodes);
  expect(used.map((f) => f.name)).toEqual(["00000000000000aa/key.png", "00000000000000aa/key@2x.png"]);
  // The same path in another skin is no reference; markers are no files.
  expect(unused.map((f) => f.name)).toEqual(["00000000000000aa/old.png"]);
  const question = removeQuestion(unused);
  expect(question).toContain("Delete 1 dropped file (1 KB)");
  expect(question).toContain("Other open Skin studio tabs or saved drafts in other browsers may still use these");
  expect(formatBytes(3 * 1048576)).toBe("3.0 MB");
});

test("one image for several selected slots is one undo step", () => {
  const history = new History();
  const before = { images: { KeyImage0: { value: "old/key" } }, values: {} } as KeymodeDraft;
  const after = structuredClone(before);
  const slot = { skin: "stable:/Skins/A", name: "mania/circle", files: [{ from: "mania/circle.png", suffix: ".png" }] };
  assignSlots(after, ["KeyImage0", "NoteImage3", "StageHint"], slot);
  history.push({ keys: 7, before, after, label: "Set 3 slots to circle.png" });
  expect(Object.keys(after.images).sort()).toEqual(["KeyImage0", "NoteImage3", "StageHint"]);
  // Each slot gets its own copy, so later edits of one never change another.
  expect(after.images.NoteImage3).not.toBe(after.images.StageHint);
  const undone = history.undo()!;
  expect(undone.before).toEqual({ images: { KeyImage0: { value: "old/key" } }, values: {} });
  expect(history.canUndo).toBe(false);
  expect(history.redo()!.after.images.StageHint).toEqual(slot);
  // Clearing several slots is one step too.
  const cleared = structuredClone(after);
  assignSlots(cleared, ["KeyImage0", "StageHint"], null);
  expect(cleared.images).toEqual({ KeyImage0: null, NoteImage3: slot, StageHint: null });
});

test("an in-place draft removes only the skin's own files the plan dropped", () => {
  const base: SkinData = {
    key: "/Skins/A",
    name: "A",
    text: "[General]\nName: A\n",
    files: ["skin.ini", "hitcircle.png", "mania-key1.png", "old.bak", "skin-studio-credits.txt", "mania-note1.png"],
  };
  const plan = {
    name: "A",
    overwrite: false,
    ini: base.text,
    sources: [{ skin: base.key, files: ["hitcircle.png", "mania-note1.png"] }],
    blanks: [{ to: "mania-key1.png", kind: "png" as const }],
    texts: [] as { to: string; text: string }[],
  };
  // The blanked key is replaced, not removed; backups and credits are not the draft's.
  expect(inPlaceRemovals(plan, base)).toEqual([]);
  plan.blanks = [];
  expect(inPlaceRemovals(plan, base)).toEqual(["mania-key1.png"]);
});

test("a draft with nothing in it has no edits", () => {
  expect(hasEdits({ name: "", base: "a", picks: {} })).toBe(false);
  expect(hasEdits({ name: "", base: "a", picks: {}, keymodes: {} })).toBe(false);
  expect(hasEdits({ name: "", base: "a", picks: {}, ini: "x" })).toBe(true);
  expect(hasEdits({ name: "", base: "a", picks: {}, keymodes: { "7": { images: {}, values: {} } } })).toBe(true);
});

test("an in-place recipe leaves [General] as the skin has it", () => {
  const skin: SkinData = { key: "/Skins/A", name: "A", text: "[General]\r\nName: Arturia\r\n\r\n[Mania]\r\nKeys: 4\r\n", files: ["skin.ini"] };
  const { plan } = compose({ name: "", base: skin.key, picks: {}, inPlace: true }, new Map([[skin.key, skin]]));
  expect(plan.ini).toContain("Name: Arturia");
  expect(plan.ini).not.toContain("Version");
});
