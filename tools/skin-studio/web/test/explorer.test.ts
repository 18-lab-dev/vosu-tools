import { expect, test } from "bun:test";
import { assetId, fontPrefixes, inUnit, unitOf } from "../src/assets";
import { folders, rowUnits, rows, unitFileNames } from "../src/explorer-model";
import { parseIni } from "../src/ini";

const fonts = fontPrefixes(parseIni("[Fonts]\nHitCirclePrefix: numbers/hit\n"));
const files = [
  "skin.ini",
  "hitcircle.png",
  "hitcircle@2x.png",
  "sliderb0.png",
  "sliderb1@2x.png",
  "sliderb1.png",
  "followpoint-0.png",
  "followpoint-1.png",
  "followpoint-10.png",
  "followpoint-2.png",
  "numbers/hit-0.png",
  "numbers/hit-1@2x.png",
  "numbers/hit-comma.png",
  "score-3.png",
  "normal-hitclap.wav",
  "normal-hitclap.ogg",
  "mania/arrows/left.png",
  "mania/arrows/left@2x.png",
  "mania/key1.png",
  "readme.txt",
].map((name, i) => ({ name, size: 100 + i }));

test("every file's unit contains it, as the override path takes it", () => {
  for (const { name } of files) {
    const unit = unitOf(name, fonts);
    if (!unit) {
      expect(["skin.ini", "readme.txt"]).toContain(name);
      continue;
    }
    expect(inUnit(unit, name, fonts)).toBe(true);
  }
  expect(unitOf("numbers/hit-1@2x.png", fonts)).toEqual({
    kind: "font",
    name: "numbers/hit",
  });
  expect(unitOf("score-3.png", fonts)).toEqual({ kind: "font", name: "score" });
  expect(unitOf("sliderb1@2x.png", fonts)).toEqual({
    kind: "image",
    name: "sliderb",
  });
  expect(unitOf("followpoint-10.png", fonts)).toEqual({
    kind: "image",
    name: "followpoint",
  });
  expect(unitOf("mania/key1.png", fonts)).toEqual({
    kind: "image",
    name: "mania/key1",
  });
  expect(unitOf("Normal-HitClap.ogg", fonts)).toEqual({
    kind: "sound",
    name: "normal-hitclap",
  });
  // Without HitCirclePrefix: hitcircle, hitcircle-1 is a frame of hitcircle.
  expect(unitOf("hitcircle-1.png")).toEqual({
    kind: "image",
    name: "hitcircle",
  });
  expect(
    unitOf(
      "hitcircle-1.png",
      fontPrefixes(parseIni("[Fonts]\nHitCirclePrefix: hitcircle")),
    ),
  ).toEqual({
    kind: "font",
    name: "hitcircle",
  });
});

test("grouped rows carry @2x, frames and glyphs together", () => {
  const list = rows(files, fonts, { folder: null, query: "", grouped: true });
  const by = (id: string) => list.find((r) => r.id === id)!;
  expect(by("image:hitcircle").files).toEqual([
    "hitcircle@2x.png",
    "hitcircle.png",
  ]);
  expect(by("image:hitcircle").detail).toBe("@2x");
  expect(by("image:sliderb").detail).toBe("2 frames · @2x");
  expect(by("image:followpoint").files).toHaveLength(4);
  expect(by("image:followpoint").detail).toBe("4 frames");
  expect(by("font:numbers/hit")).toMatchObject({
    label: "hit-*",
    folder: "numbers",
    detail: "3 glyphs · @2x",
  });
  expect(by("sound:normal-hitclap").detail).toBe("ogg + wav");
  expect(by("image:mania/arrows/left")).toMatchObject({
    label: "left",
    folder: "mania/arrows",
  });
  expect(by("file:skin.ini").unit).toBeUndefined();
  expect(list.reduce((n, r) => n + r.files.length, 0)).toBe(files.length);
  // Root files first, numbers sorted naturally.
  expect(list[0].folder).toBe("");
});

test("flat rows, folders and filters", () => {
  const flat = rows(files, fonts, { folder: null, query: "", grouped: false });
  expect(flat).toHaveLength(files.length);
  expect(flat.find((r) => r.label === "followpoint-10.png")!.detail).toBe(
    "frame 10",
  );
  expect(flat.find((r) => r.label === "hit-1@2x.png")!.detail).toBe(
    "glyph · @2x",
  );
  const names = flat
    .filter((r) => r.label.startsWith("followpoint"))
    .map((r) => r.label);
  expect(names).toEqual([
    "followpoint-0.png",
    "followpoint-1.png",
    "followpoint-2.png",
    "followpoint-10.png",
  ]);

  const tree = folders(files);
  expect(tree.map((f) => [f.path, f.depth, f.count])).toEqual([
    ["", 0, 14],
    ["mania", 1, 1],
    ["mania/arrows", 2, 2],
    ["numbers", 1, 3],
  ]);
  const arrows = rows(files, fonts, {
    folder: "mania/arrows",
    query: "",
    grouped: true,
  });
  expect(arrows.map((r) => r.id)).toEqual(["image:mania/arrows/left"]);
  const search = rows(files, fonts, {
    folder: null,
    query: "CLAP",
    grouped: false,
  });
  expect(search.map((r) => r.label)).toEqual([
    "normal-hitclap.ogg",
    "normal-hitclap.wav",
  ]);
  // Two files of one unit selected: one unit to mix.
  expect(rowUnits(search).map(assetId)).toEqual(["sound:normal-hitclap"]);
});

test("a parent folder counts its subfolders' files too, and keeps its direct count", () => {
  const tree = folders(["Circles/Notes/a.png", "Circles/Notes/b.png", "Circles/Receptors/r.png", "x.png"].map((name) => ({ name, size: 1 })));
  const circles = tree.find((f) => f.path === "Circles")!;
  expect([circles.count, circles.total]).toEqual([0, 3]);
  expect(tree.find((f) => f.path === "Circles/Notes")!.total).toBe(2);
  expect(tree.find((f) => f.path === "")!.total).toBe(4);
});

test("Use names every file of the unit, even when one frame row is selected", () => {
  const files = ["hit300-0.png", "hit300-1.png", "hit300-0@2x.png", "hit100.png"].map((name) => ({ name, size: 1 }));
  const one = rows(files, new Set(), { grouped: false, folder: null, query: "hit300-1" });
  expect(one.length).toBe(1);
  expect(unitFileNames(rowUnits(one), files, new Set()).sort()).toEqual(["hit300-0.png", "hit300-0@2x.png", "hit300-1.png"]);
});
