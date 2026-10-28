import { expect, test } from "bun:test";
import { maniaValue } from "@vosu-tools/skin-spec";
import { HitPanel, type DeriveOp, type HitHost } from "../src/hit-panel";
import { assignSlots, stageImages, type KeymodeDraft } from "../src/keymodes";
import { imageIndex } from "../src/mania";
import { compose, type SkinData } from "../src/plan";

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

function harness(draft: KeymodeDraft, skin: SkinData) {
  const operations: { skin: string; name: string; op: DeriveOp }[] = [];
  const sizes = new Map<string, { width: number; height: number }>();
  const errors: string[] = [];
  const mix = () => compose({ name: "Mix", base: skin.key, picks: {}, keymodes: { "5": draft } }, new Map([[skin.key, skin]])).plan;
  const files = () => new Map(mix().sources.flatMap((source) => source.files.map((file) => {
    const [from, to] = typeof file === "string" ? [file, file] : file;
    return [to.toLowerCase(), { skin: source.skin, from, to }] as const;
  })));
  const host: HitHost = {
    keys: () => 5, mixText: () => mix().ini, mixFiles: files,
    mixIndex: () => imageIndex([...files().keys()]),
    resolved: () => stageImages(mix().ini, [...files().keys()], 5), draft: () => draft,
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
  return { panel, operations, errors, mix };
}

test("5K legacy captures rebase all receptors before 60→62→60 instead of resurrecting old selections", async () => {
  const { draft, skin } = fixture();
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

test("repeating 60 repairs a stale capture baseline, then repeating it again is a no-op", async () => {
  const { draft, skin } = fixture();
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
