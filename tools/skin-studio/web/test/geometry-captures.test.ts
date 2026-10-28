import { expect, test } from "bun:test";
import { maniaValue } from "@vosu-tools/skin-spec";
import { HitPanel, type DeriveOp, type HitHost } from "../src/hit-panel";
import { applyStageCopy, applyToAll, assignImageSlots, assignSlots, copyStage, defaultPattern, mirror, resetStageGeometry, stageImages, type KeymodeDraft } from "../src/keymodes";
import { imageIndex } from "../src/mania";
import { assignGroupPick, compose, type Recipe, type SkinData } from "../src/plan";

// The private recipe's shape, not its names, IDs or image bytes: four old
// receptor captures, no first-column capture, and five newer value selections.
function fixture() {
  const files = ["new/key.png", "new/key@2x.png", "new/down.png", "new/down@2x.png"];
  const text = ["[General]", "Version: 2.7", "[Mania]", "Keys: 5", "ColumnWidth: 60,60,60,60,60", "HitPosition: 480",
    ...Array.from({ length: 5 }, (_, c) => [`KeyImage${c}: new/key`, `KeyImage${c}D: new/down`]).flat(), ""].join("\n");
  const skin: SkinData = { key: "base", name: "Base", text, files };
  const draft: KeymodeDraft = { images: {}, values: { ColumnWidth: "60,60,60,60,60", HitPosition: "480" }, hit: { originals: {} } };
  for (let c = 0; c < 5; c++) for (const suffix of ["", "D"]) {
    const key = `KeyImage${c}${suffix}`, name = suffix ? "down" : "key";
    draft.images[key] = { value: `new/${name}` };
    if (c) draft.hit!.originals[key] = {
      at: 432, width: 96, noteHeight: 96, had: true, prior: { value: `old/${name}` },
      slot: { skin: "old", name: `old/${name}`, files: [
        { from: `old/${name}.png`, suffix: ".png" }, { from: `old/${name}@2x.png`, suffix: "@2x.png" },
      ] },
    };
  }
  return { draft, skin };
}

function harness(draft: KeymodeDraft, skin: SkinData, keys = 5, dimensions = new Map<string, { width: number; height: number }>()) {
  const operations: { skin: string; name: string; op: DeriveOp }[] = [];
  const sizes = new Map(dimensions);
  const errors: string[] = [];
  const mix = () => compose({ name: "Mix", base: skin.key, picks: {}, keymodes: { [String(keys)]: draft } }, new Map([[skin.key, skin]])).plan;
  const files = () => new Map(mix().sources.flatMap((source) => source.files.map((file) => {
    const [from, to] = typeof file === "string" ? [file, file] : file;
    return [to.toLowerCase(), { skin: source.skin, from, to }] as const;
  })));
  const host: HitHost = {
    keys: () => keys, mixText: () => mix().ini, mixFiles: files,
    mixIndex: () => imageIndex([...files().keys()]),
    resolved: () => stageImages(mix().ini, [...files().keys()], keys), draft: () => draft,
    generation: () => 0,
    change: (_label, mutate) => mutate(draft),
    rows: async (_skin, name) => ({ ...(sizes.get(name) ?? (/@2x\.png$/.test(name) ? { width: 192, height: 347 } : { width: 96, height: 174 })), top: 0, bottom: 0 }),
    derive: async (source, requests) => requests.map(({ name, op }) => {
      operations.push({ skin: source, name, op });
      const stored = `${operations.length}/key.png`;
      if ("resize" in op) sizes.set(stored, op.resize);
      return { from: name, stored, lost: 0 };
    }),
    lastPlay: async () => { throw new Error("Not a calibration test"); },
    speed: () => null, setSpeed: () => {}, canWrite: () => true, state: () => {}, error: (message) => { if (message) errors.push(message); },
  };
  const panel = new HitPanel(host);
  // Geometry is exercised; no document is needed to redraw the controls.
  panel.render = () => {};
  return { host, panel, operations, errors, mix };
}

for (const moveReceptors of [true, false]) test(`5K legacy captures rebase before 60→62→60 (move receptors ${moveReceptors})`, async () => {
  const { draft, skin } = fixture();
  draft.moveReceptors = moveReceptors;
  const { panel, operations, errors, mix } = harness(draft, skin);
  await panel.setWidths([0], "62", "Set column 1 width");
  expect(errors).toEqual([]);
  expect(maniaValue(mix().ini, 5, "HitPosition")).toBe("480");
  expect(Object.values(draft.hit!.originals).every((original) => original.at === 480 && original.slot.skin === "base")).toBe(true);
  expect(operations.every((operation) => operation.skin === "base")).toBe(true);
  await panel.setWidths([0], "60", "Set column 1 width");
  expect(draft.hit).toBeUndefined();
  for (let c = 0; c < 5; c++) {
    expect(draft.images[`KeyImage${c}`]).toEqual({ value: "new/key" });
    expect(draft.images[`KeyImage${c}D`]).toEqual({ value: "new/down" });
  }
  expect(maniaValue(mix().ini, 5, "HitPosition")).toBe("480");
});

for (const moveReceptors of [true, false]) test(`repeating 60 repairs stale captures then becomes a no-op (move receptors ${moveReceptors})`, async () => {
  const { draft, skin } = fixture();
  draft.moveReceptors = moveReceptors;
  const { panel, operations, errors } = harness(draft, skin);
  await panel.setWidths([0, 1, 2, 3, 4], "60", "Apply width to all columns");
  expect(errors).toEqual([]);
  expect(draft.hit).toBeUndefined();
  expect(operations).toEqual([]);
  expect(panel.lastRegeometry?.images).toBe(0);
  await panel.setWidths([0], "60", "Repeat width");
  expect(panel.lastRegeometry).toBeNull();
});

test("legacy mixed HitPosition epochs rebase even when current values match captured priors", async () => {
  const { draft, skin } = fixture();
  draft.hit!.moved = -7;
  draft.hit!.detached = 13;
  for (const [key, original] of Object.entries(draft.hit!.originals)) {
    const name = key.endsWith("D") ? "down" : "key";
    original.prior = structuredClone(draft.images[key]);
    original.slot = { skin: "base", name: `new/${name}`, files: [
      { from: `new/${name}.png`, suffix: ".png" }, { from: `new/${name}@2x.png`, suffix: "@2x.png" },
    ] };
  }
  draft.hit!.originals.KeyImage0 = {
    ...structuredClone(draft.hit!.originals.KeyImage1), at: 480,
    prior: { value: "new/key" }, slot: { skin: "base", name: "new/key", files: [
      { from: "new/key.png", suffix: ".png" }, { from: "new/key@2x.png", suffix: "@2x.png" },
    ] },
  };
  const { panel, errors, mix } = harness(draft, skin);
  await panel.setWidths([0], "62", "Set column 1 width");
  expect(errors).toEqual([]);
  expect(maniaValue(mix().ini, 5, "HitPosition")).toBe("480");
  expect(Object.values(draft.hit!.originals).every((original) => original.at === 480)).toBe(true);
});

test("a new base source rebases captures even when the selected value text did not change", async () => {
  const { draft, skin } = fixture();
  for (const [key, original] of Object.entries(draft.hit!.originals)) original.prior = structuredClone(draft.images[key]);
  const { panel, errors, mix } = harness(draft, skin);
  await panel.setWidths([0], "62", "Set column 1 width");
  expect(errors).toEqual([]);
  expect(maniaValue(mix().ini, 5, "HitPosition")).toBe("480");
  expect(Object.values(draft.hit!.originals).every((original) => original.slot.skin === "base")).toBe(true);
});

test("an explicit receptor selection starts one shared geometry baseline without changing other images", () => {
  const { draft } = fixture();
  const peer = structuredClone(draft.images.KeyImage1);
  assignSlots(draft, ["KeyImage0"], { value: "replacement" });
  expect(draft.hit).toBeUndefined();
  expect(draft.images.KeyImage1).toEqual(peer);
  expect(draft.images.KeyImage0).toEqual({ value: "replacement" });
});

function tenFixture(moveReceptors: boolean, explicitHeight?: string) {
  const text = ["[General]", "Version: 2.7", "[Mania]", "Keys: 10", `ColumnWidth: ${Array(10).fill(64).join(",")}`,
    "HitPosition: 447", "NoteBodyStyle: 0", ...(explicitHeight === undefined ? [] : [`WidthForNoteHeightScale: ${explicitHeight}`]),
    ...Array.from({ length: 10 }, (_, c) => [
      `KeyImage${c}: key`, `KeyImage${c}D: down`, `NoteImage${c}: note`, `NoteImage${c}H: note`, `NoteImage${c}T: tail`,
    ]).flat(), ""].join("\n");
  const skin: SkinData = { key: "stage", name: "Stage", text, files: ["key.png", "down.png", "note.png", "tail.png"] };
  const draft: KeymodeDraft = { images: {}, values: {}, moveReceptors };
  const dimensions = new Map([
    ["key.png", { width: 100, height: 300 }], ["down.png", { width: 100, height: 300 }],
    ["note.png", { width: 100, height: 100 }], ["tail.png", { width: 100, height: 100 }],
  ]);
  return { skin, draft, dimensions };
}

for (const moveReceptors of [true, false]) test(`10K one-column resize leaves all other images untouched and round trips (move receptors ${moveReceptors})`, async () => {
  const { skin, draft, dimensions } = tenFixture(moveReceptors);
  const { panel, operations, errors, mix } = harness(draft, skin, 10, dimensions);
  await panel.setWidths([0], "40", "Set column 1 width");
  expect(errors).toEqual([]);
  expect(maniaValue(mix().ini, 10, "WidthForNoteHeightScale")).toBe("64");
  expect(draft.autoNoteHeight).toBe("64");
  for (let c = 1; c < 10; c++)
    for (const suffix of ["", "D"]) expect(draft.images[`KeyImage${c}${suffix}`]).toBeUndefined();
  for (let c = 1; c < 10; c++)
    for (const suffix of ["", "H", "T"]) expect(draft.images[`NoteImage${c}${suffix}`]).toBeUndefined();
  expect(operations.every(({ op }) => !("shift" in op))).toBe(true);
  expect(draft.images.KeyImage0).toBeDefined();
  await panel.setWidths([0], "64", "Restore column 1 width");
  expect(errors).toEqual([]);
  expect(draft.images).toEqual({});
  expect(draft.hit).toBeUndefined();
  expect(draft.autoNoteHeight).toBeUndefined();
  expect(maniaValue(mix().ini, 10, "WidthForNoteHeightScale")).toBeUndefined();
  expect(maniaValue(mix().ini, 10, "HitPosition")).toBe("447");
});

for (const moveReceptors of [true, false]) test(`explicit note-height reference is never rewritten (move receptors ${moveReceptors})`, async () => {
  const { skin, draft, dimensions } = tenFixture(moveReceptors, "32.50");
  const { panel, errors, mix } = harness(draft, skin, 10, dimensions);
  await panel.setWidths([0], "40", "Narrow column");
  await panel.setWidths(Array.from({ length: 10 }, (_, c) => c), "40", "Narrow all");
  await panel.setWidths(Array.from({ length: 10 }, (_, c) => c), "64", "Restore all");
  expect(errors).toEqual([]);
  expect(draft.values.WidthForNoteHeightScale).toBeUndefined();
  expect(draft.autoNoteHeight).toBeUndefined();
  expect(maniaValue(mix().ini, 10, "WidthForNoteHeightScale")).toBe("32.50");
});

test("stage copies and every bulk image assignment discard old captures, not other image selections", () => {
  for (const apply of [
    (draft: KeymodeDraft) => applyStageCopy(draft, { images: { KeyImage0: { value: "new/key" } }, values: { HitPosition: "447" } }),
    (draft: KeymodeDraft) => assignImageSlots(draft, { KeyImage0: { value: "new/key" }, KeyImage0D: { value: "new/down" } }),
  ]) {
    const { draft } = fixture();
    draft.hit!.moved = -22.4;
    draft.hit!.detached = 12;
    const peer = structuredClone(draft.images.KeyImage1);
    apply(draft);
    expect(draft.hit).toBeUndefined();
    expect(draft.images.KeyImage1).toEqual(peer);
  }
});

test("changing a stage group invalidates only that count's captures, not on unrelated or unchanged picks", () => {
  const first = fixture().draft, second = fixture().draft;
  const recipe: Recipe = { name: "Mix", base: "base", picks: {}, keymodes: { "5": first, "10": second } };
  assignGroupPick(recipe, "catch-fruits", { kind: "skin", key: "other" });
  expect(first.hit).toBeDefined();
  assignGroupPick(recipe, "mania-keys-10", { kind: "skin", key: "stage" });
  expect(second.hit).toBeUndefined();
  expect(first.hit).toBeDefined();
  second.hit = structuredClone(first.hit);
  assignGroupPick(recipe, "mania-keys-10", { kind: "skin", key: "stage" });
  expect(second.hit).toBeDefined();
});

for (const moveReceptors of [true, false]) test(`old blank priors offer original-stage reset, preserving toggles and non-geometry values (${moveReceptors})`, async () => {
  const { skin, draft, dimensions } = tenFixture(moveReceptors);
  skin.files.push("_blank.png");
  draft.hit = { originals: {}, moved: -22.4, detached: 12 };
  draft.values.ColumnWidth = Array(10).fill(40).join(",");
  draft.values.HitPosition = "450";
  draft.values.Colour2 = "12,12,12";
  for (let c = 0; c < 10; c++) for (const suffix of ["", "D"]) {
    const key = `KeyImage${c}${suffix}`;
    draft.images[key] = { value: "_blank" };
    draft.hit.originals[key] = { at: 455, width: 102.4, noteHeight: 102.4, had: true, prior: { value: "_blank" },
      slot: { skin: "old", name: "_blank", files: [{ from: "_blank.png", suffix: ".png" }] } };
  }
  const { panel, mix } = harness(draft, skin, 10, dimensions);
  expect(panel.needsOriginalStageReset).toBe(true);
  const original = copyStage(10, 10, (key) => {
    const r = stageImages(skin.text, skin.files, 10).find((image) => image.key === key);
    return r?.drawn && !r.drawn.builtin
      ? { skin: skin.key, name: r.drawn.name, files: [{ from: `${r.drawn.name}.png`, suffix: ".png" }] }
      : null;
  }, (key) => maniaValue(skin.text, 10, key), true);
  resetStageGeometry(draft, original);
  expect(panel.needsOriginalStageReset).toBe(false);
  expect(draft.hit).toBeUndefined();
  expect(draft.moveReceptors).toBe(moveReceptors);
  expect(draft.values.Colour2).toBe("12,12,12");
  expect(maniaValue(mix().ini, 10, "ColumnWidth")).toBe(Array(10).fill(64).join(","));
  expect(maniaValue(mix().ini, 10, "HitPosition")).toBe("447");
  for (let c = 0; c < 10; c++) expect(draft.images[`KeyImage${c}`]).toEqual({
    skin: "stage", name: "key", files: [{ from: "key.png", suffix: ".png" }],
  });
});

test("an awaited derive cannot overwrite a newer manual selection", async () => {
  const { draft, skin } = fixture();
  delete draft.hit;
  const { host, panel, errors } = harness(draft, skin);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const derive = host.derive;
  host.derive = async (source, requests) => { entered.resolve(); await release.promise; return derive(source, requests); };
  let current = draft;
  host.draft = () => current;
  host.change = (_label, mutate) => mutate(current);
  const pending = panel.setWidths([0], "62", "Set column 1 width");
  await entered.promise;
  current = structuredClone(draft);
  current.images.KeyImage0 = { value: "manual-new-selection" };
  release.resolve();
  await pending;
  expect(current.images.KeyImage0).toEqual({ value: "manual-new-selection" });
  expect(current.values.ColumnWidth).toBe("60,60,60,60,60");
  expect(errors).toContain("The draft changed while geometry was being derived; the stale result was not applied.");
});

test("an awaited derive commits to its captured key count after a rail change", async () => {
  const { draft, skin } = fixture();
  delete draft.hit;
  const { host, panel, errors } = harness(draft, skin);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const derive = host.derive;
  host.derive = async (source, requests) => { entered.resolve(); await release.promise; return derive(source, requests); };
  const peer: KeymodeDraft = { images: {}, values: {} };
  let shown = 5;
  host.keys = () => shown;
  host.draft = (keys = shown) => keys === 5 ? draft : peer;
  host.change = (_label, mutate, keys = shown) => mutate(keys === 5 ? draft : peer);
  const pending = panel.setWidths([0], "62", "Set column 1 width");
  await entered.promise;
  shown = 10;
  release.resolve();
  await pending;
  expect(errors).toEqual([]);
  expect(draft.values.ColumnWidth).toBe("62,60,60,60,60");
  expect(peer).toEqual({ images: {}, values: {} });
});

test("a clear -> undo ABA invalidates an awaited resize even when the same draft object returns", async () => {
  const { draft, skin } = fixture();
  delete draft.hit;
  const { host, panel, errors } = harness(draft, skin);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const derive = host.derive;
  host.derive = async (source, requests) => { entered.resolve(); await release.promise; return derive(source, requests); };
  let generation = 0;
  host.generation = () => generation;
  const pending = panel.setWidths([0], "62", "Set column 1 width");
  await entered.promise;
  const prior = draft.images.KeyImage0;
  draft.images.KeyImage0 = null;
  generation++;
  draft.images.KeyImage0 = prior;
  generation++;
  release.resolve();
  await pending;
  expect(draft.values.ColumnWidth).toBe("60,60,60,60,60");
  expect(draft.hit).toBeUndefined();
  expect(errors).toContain("The draft changed while geometry was being derived; the stale result was not applied.");
});

for (let keys = 1; keys <= 10; keys++) {
  const seeded = (): KeymodeDraft => {
    const images = Object.fromEntries(Array.from({ length: keys }, (_, c) => [`KeyImage${c}`, {
      skin: "source", name: `key${c}`, files: [{ from: `key${c}.png`, suffix: ".png" }],
    }]));
    return { images, values: {}, hit: { moved: -12, detached: 8, originals: Object.fromEntries(Object.entries(images).map(([key, slot]) =>
      [key, { at: 432, width: 64, noteHeight: 64, slot, had: false }])) } };
  };
  for (const op of ["mirror", "pattern", "all", "assign", "copy"]) test(`${keys}K ${op} establishes a coherent shared capture epoch`, () => {
    const draft = seeded();
    const image = (key: string) => draft.images[key] ?? null;
    if (op === "mirror") assignImageSlots(draft, mirror(keys, image));
    else if (op === "pattern") assignImageSlots(draft, defaultPattern(keys, image));
    else if (op === "all") assignImageSlots(draft, applyToAll(keys, "KeyImage#", 0, image));
    else if (op === "assign") assignSlots(draft, ["KeyImage0"], { value: "new" });
    else applyStageCopy(draft, copyStage(keys, keys, image, () => undefined));
    expect(draft.hit).toBeUndefined();
  });
}
