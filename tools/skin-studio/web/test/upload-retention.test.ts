import { expect, test } from "bun:test";
import { History, type KeymodeDraft, type SlotImage } from "../src/keymodes";
import { sourceFileNames } from "../src/missing-sources";
import type { Recipe, SkinData } from "../src/plan";
import { UPLOADS, recipeUploadFiles, removeQuestion, uploadUsage } from "../src/uploads";

const original: SlotImage = { skin: UPLOADS, name: "key", files: [
  { from: "source/key.png", suffix: ".png" },
  { from: "source/key@2x.png", suffix: "@2x.png" },
  { from: "source/key-0.png", suffix: "-0.png" },
] };
const prior: SlotImage = { skin: UPLOADS, name: "prior", files: [{ from: "prior.png", suffix: ".png" }] };
const derived: SlotImage = { skin: UPLOADS, name: "key", files: [{ from: "derived/key.png", suffix: ".png" }] };
const captured: KeymodeDraft = {
  images: { KeyImage0: derived }, values: {},
  hit: { originals: { KeyImage0: { at: 432, width: 112, noteHeight: 112, slot: original, prior, had: true } } },
};
const catalog = [...original.files, ...prior.files, ...derived.files].map((file) => ({ name: file.from, size: 100 }));

test("resized upload originals and prior selections remain reachable in every key count", () => {
  const drafts = { "4": captured, "10": { images: { NoteImage9: prior }, values: {} } };
  const files = [...catalog, { name: "unused.png", size: 100 }];
  const usage = uploadUsage(files, drafts);
  expect(usage.used.map((file) => file.name)).toEqual(catalog.map((file) => file.name));
  expect(usage.history).toEqual([]);
  expect(usage.unused.map((file) => file.name)).toEqual(["unused.png"]);
  // Same dependency oracle as the audit repro, including hidden capture/prior files.
  const dependencies = sourceFileNames(drafts, UPLOADS);
  expect(usage.unused.filter((file) => dependencies.has(file.name))).toEqual([]);
});

test("every retained undo and redo snapshot protects its captures and images", () => {
  const usage = uploadUsage(catalog, { "7": { images: { NoteImage0: derived }, values: {} } }, [undefined, captured]);
  expect(usage.used.map((file) => file.name)).toEqual(["derived/key.png"]);
  expect(usage.history.map((file) => file.name)).toEqual([...original.files, ...prior.files].map((file) => file.from));
  expect(usage.unused).toEqual([]);
  const afterHistoryCleared = uploadUsage(catalog, {});
  expect(afterHistoryCleared.unused).toEqual(catalog);
});

test("normalise separators/case, but do not retain another skin's same-named files", () => {
  const other: KeymodeDraft = { images: { KeyImage0: { ...original, skin: "stable:other" } }, values: {} };
  const files = [{ name: "SOURCE\\KEY.PNG", size: 1 }, { name: ".used", size: 0 }];
  expect(uploadUsage(files, { "1": other }).unused).toEqual([files[0]]);
  expect(uploadUsage(files, { "1": captured }).used).toEqual([files[0]]);
});

const uploadSkin: SkinData = {
  key: UPLOADS, name: "Dropped files",
  text: "[General]\nName: Drops\n[Mania]\nKeys: 4\nKeyImage0: source/key\n",
  files: [...catalog.map((file) => file.name), "cursor.png", "hitcircle.png", "unused.png"],
};
const sources = new Map([[UPLOADS, uploadSkin]]);

test("base, group, stage and single-asset recipe dependencies are retained", () => {
  const empty: Recipe = { name: "Mix", base: null, picks: {} };
  const recipes: Recipe[] = [
    { ...empty, base: UPLOADS },
    { ...empty, picks: { cursor: { kind: "skin", key: UPLOADS } } },
    { ...empty, picks: { "mania-keys-4": { kind: "skin", key: UPLOADS } } },
    { ...empty, overrides: { "image:hitcircle": { skin: UPLOADS } } },
  ];
  const expected = ["unused.png", "cursor.png", "source/key.png", "hitcircle.png"];
  for (const [index, recipe] of recipes.entries()) {
    const references = recipeUploadFiles(recipe, sources)!;
    expect(references).toContain(expected[index]);
    const files = uploadSkin.files.map((name) => ({ name, size: 100 }));
    const live = uploadUsage(files, {}, [], { current: references });
    expect(live.used.map((file) => file.name)).toContain(expected[index]);
    const history = uploadUsage(files, {}, [], { history: references });
    expect(history.history.map((file) => file.name)).toContain(expected[index]);
    expect(history.unused.map((file) => file.name)).not.toContain(expected[index]);
  }
});

test("unknown upload recipe dependencies fail closed until the source loads", () => {
  expect(recipeUploadFiles({ name: "Mix", base: UPLOADS, picks: {} }, new Map())).toBeNull();
});

test("delete dialog distinguishes unreachable files and files kept only for undo", () => {
  const question = removeQuestion([{ name: "unused.png", size: 1024 }], 3);
  expect(question).toContain("Delete 1 dropped file (1 KB)");
  expect(question).toContain("1 unused · 3 kept for undo");
});

test("undo, redo and a new history branch retain exactly their reachable snapshots", () => {
  const history = new History<{ label: string; drafts: (KeymodeDraft | undefined)[] }>();
  history.push({ label: "Initial edit", drafts: [] });
  history.push({ label: "Uploaded receptor", drafts: [captured, undefined] });
  for (const move of ["undo", "redo", "undo"] as const) {
    history[move]();
    const usage = uploadUsage(catalog, {}, history.steps().flatMap((step) => step.drafts));
    expect(usage.history).toEqual(catalog);
    expect(usage.unused).toEqual([]);
  }
  history.push({ label: "Replace redo branch", drafts: [] });
  expect(uploadUsage(catalog, {}, history.steps().flatMap((step) => step.drafts)).unused).toEqual(catalog);
});

test("history eviction releases uploads only when the last retaining step is gone", () => {
  const history = new History<{ label: string; drafts: (KeymodeDraft | undefined)[] }>();
  history.push({ label: "Uploaded receptor", drafts: [captured] });
  for (let i = 0; i < 199; i++) history.push({ label: `Edit ${i}`, drafts: [] });
  expect(uploadUsage(catalog, {}, history.steps().flatMap((step) => step.drafts)).unused).toEqual([]);
  history.push({ label: "Evict oldest", drafts: [] });
  expect(uploadUsage(catalog, {}, history.steps().flatMap((step) => step.drafts)).unused).toEqual(catalog);
});
