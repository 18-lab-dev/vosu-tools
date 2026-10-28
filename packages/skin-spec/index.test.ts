import { test, expect, spyOn } from "bun:test";
import {
  parse,
  serialize,
  setValue,
  validate,
  pathCandidates,
  hasAsset,
  resolve,
  spec,
} from "./index";
test("lossless BOM CRLF comments unknown ordering and repeated sections", () => {
  const text =
    "\uFEFF// skin\r\n[General]\r\nFutureKey: custom\r\n; comment\r\n[Mania]\r\nKeys: 4\r\n[Mania]\r\nKeys: 7";
  const doc = parse(text);
  expect(serialize(doc)).toBe(text);
  expect(doc.lines.filter((l) => l.key === "Keys").map((l) => l.block)).toEqual(
    [2, 3],
  );
  expect(serialize(setValue(doc, 3, "changed"))).toContain(
    "FutureKey: changed\r\n; comment",
  );
});
test("wiki command coverage and corrected research facts", () => {
  expect(spec.length).toBe(105);
  expect(resolve("Mania", "NoteImage0H")?.type).toBe("image");
  expect(resolve("Mania", "StageLeft")?.type).toBe("image");
  expect(resolve("General", "CursorTrailRotate")).toBeDefined();
  expect(resolve("Mania", "Keys")?.enum).not.toContain("11");
});
test("numeric colour enum version and list validation", () => {
  const text =
    "[General]\nVersion: 2.4\nCursorRotate: 2\nAnimationFramerate: -1\n[Colours]\nCombo1: 256,0,0\n[Mania]\nKeys: 4\nColumnWidth: 30,30\nColumnLineWidth: 1,1,1,1,1\nNoteBodyStyle: 1\nNoteImage4: absent\n";
  const errors = validate(text, []);
  expect(errors.some((d) => d.line === 3)).toBe(true);
  expect(errors.some((d) => d.line === 4)).toBe(false);
  expect(errors.some((d) => d.line === 6)).toBe(true);
  expect(errors.some((d) => d.line === 9)).toBe(true);
  expect(errors.some((d) => d.line === 10)).toBe(false);
  expect(
    errors.some((d) => d.line === 11 && d.message.includes("Version")),
  ).toBe(true);
  expect(errors.some((d) => d.line === 12 && d.message.includes("index"))).toBe(
    true,
  );
});
test("mania blocks independent count and omitted version is legacy", () => {
  const text =
    "[Mania]\nKeys: 4\nColumnWidth: 1,2,3,4\n[Mania]\nKeys: 7\nColumnWidth: 1,2,3,4\nKeyFlipWhenUpsideDown: 1\n";
  expect(
    validate(text).filter((d) => d.message.includes("Expected 7")).length,
  ).toBe(1);
  expect(validate(text).some((d) => d.message.includes("Version 2.5"))).toBe(
    true,
  );
});
test("asset completion high resolution animations and font digits", () => {
  const files = [
    "sub/note-0@2x.png",
    "sub/note-1.png",
    ...Array.from({ length: 10 }, (_, i) => `digits-${i}@2x.png`),
    "audio.wav",
  ];
  expect(pathCandidates(files)).toContain("sub/note");
  expect(pathCandidates(files, "prefix")).toContain("digits");
  expect(hasAsset("sub/note", files)).toBe(true);
  expect(hasAsset("digits", files, "prefix")).toBe(true);
  expect(hasAsset("digits", files.slice(0, -2), "prefix")).toBe(false);
  expect(hasAsset("../note", files)).toBe(false);
  expect(
    validate("[Mania]\nKeys: 4\nNoteImage0: missing\n", files).some((d) =>
      d.message.startsWith("Missing image"),
    ),
  ).toBe(true);
});
test("non-image files cannot satisfy image references", () => {
  expect(hasAsset("audio.wav", ["audio.wav"])).toBe(false);
});
test("inline comments validate like the client without changing raw text", () => {
  const text = "\uFEFF[General]\r\nVersion: latest // skin version\r\n[Mania]\r\nKeys: 4 // columns\r\nColumnWidth: 40,40,40,40 // widths\r\nNoteImage0: sub/note // keep this comment\r\n";
  expect(validate(text, ["sub/note-0@2x.png"])).toEqual([]);
  expect(serialize(parse(text))).toBe(text);
});
test("legacy image fields match case, HD and first frames, but never JPEG-only files", () => {
  const files = ["Circles\\Notes\\Baby Pink@2x.PNG", "animated-0@2x.png", "only.jpg"];
  expect(validate("[Mania]\nKeys: 4\nNoteImage0: circles/notes/baby pink\n", files)).toEqual([]);
  expect(validate("[Mania]\nKeys: 4\nNoteImage0: animated\n", files)).toEqual([]);
  expect(validate("[Mania]\nKeys: 4\nKeyImage0: animated\n", files).some((d) => d.message.startsWith("Missing image"))).toBe(true);
  expect(validate("[Mania]\nKeys: 4\nNoteImage0: only\n", files).some((d) => d.message.startsWith("Missing image"))).toBe(true);
  expect(hasAsset("only", files)).toBe(false);
  expect(pathCandidates(files)).not.toContain("only");
  expect(pathCandidates(files)).toContain("Circles/Notes/Baby Pink");
  expect(hasAsset("arrow.left", ["arrow.left.png"], "texture")).toBe(true);
  expect(hasAsset("note@2X.PNG", ["Note@2x.png"], "texture")).toBe(true);
  expect(pathCandidates(["a-0.png", "a-1.png"], "animation")).toEqual(["a"]);
  expect(pathCandidates(["a-0.png"], "texture")).not.toContain("a");
});

import {
  addManiaBlock,
  columnKeys,
  imagePathValue,
  maniaKeyCounts,
  maniaLists,
  maniaValue,
  setManiaValue,
} from "./index";

test("per-column [Mania] keys and list lengths for each key count", () => {
  const images = (column: number) =>
    columnKeys(column)
      .filter((k) => k.type === "image")
      .map((k) => k.key);
  expect(images(0)).toEqual([
    "KeyImage0",
    "KeyImage0D",
    "NoteImage0",
    "NoteImage0H",
    "NoteImage0L",
    "NoteImage0T",
  ]);
  expect(images(6).at(-1)).toBe("NoteImage6T");
  // Colours count from 1 (osu! wiki: Colour#, ColourLight#).
  const colours = columnKeys(0).filter((k) => k.pattern.startsWith("Colour"));
  expect(colours.map((k) => [k.key, k.type])).toEqual([
    ["Colour1", "rgba"],
    ["ColourLight1", "rgb"],
  ]);
  for (const keys of [1, 4, 7, 10, 18]) {
    const lengths = Object.fromEntries(
      maniaLists(keys).map((s) => [s.key, s.length]),
    );
    expect(lengths).toEqual({
      ColumnSpacing: keys - 1,
      ColumnWidth: keys,
      ColumnLineWidth: keys + 1,
      LightingNWidth: keys,
      LightingLWidth: keys,
    });
  }
});

const skinIni =
  "\uFEFF// mine\r\n[General]\r\nName: X\r\n\r\n[Mania]\r\n    Keys: 4\r\n    NoteImage0: old // keep me?\r\n    ColumnWidth: 40\r\n\r\n[Mania]\r\nKeys: 4\r\nNoteImage0: ignored\r\n";

test("[Mania] values read as osu! reads them", () => {
  expect(maniaValue(skinIni, 4, "NoteImage0")).toBe("old");
  expect(maniaValue(skinIni, 7, "NoteImage0")).toBeUndefined();
  expect(maniaValue(skinIni, 4, "KeyImage0")).toBeUndefined();
  expect(maniaKeyCounts(parse(skinIni))).toEqual([4]);
  // The last occurrence in a block wins.
  expect(maniaValue("[Mania]\nKeys: 7\nKeyImage0: a\nKeyImage0: b\n", 7, "KeyImage0")).toBe("b");
});

test("repeated Mania scalar lookups share one bounded, private text parse", () => {
  const source = "; shared scalar lookup fixture\n[Mania]\nKeys: 4\nNoteImage0: first\nNoteImage0: last // comment\n";
  const parses = spyOn(String.prototype, "matchAll");
  try {
    for (let i = 0; i < 60; i++) expect(maniaValue(source, 4, "NoteImage0")).toBe("last");
    expect(parses).toHaveBeenCalledTimes(1);
    const edited = source.replace("last // comment", "edited");
    expect(maniaValue(edited, 4, "NoteImage0")).toBe("edited");
    expect(maniaValue(source, 4, "NoteImage0")).toBe("last");
    expect(parses).toHaveBeenCalledTimes(3);
  } finally {
    parses.mockRestore();
  }
  const outside = parse(source);
  outside.lines.findLast((line) => line.key === "NoteImage0")!.value = "outside mutation";
  expect(maniaValue(source, 4, "NoteImage0")).toBe("last");
});

test("setting [Mania] values keeps everything else byte for byte", () => {
  const set = setManiaValue(skinIni, 4, "NoteImage0", "skin-studio/4k/note");
  expect(set).toBe(skinIni.replace("NoteImage0: old // keep me?", "NoteImage0: skin-studio/4k/note"));
  // A new key follows the block's last entry, indented like it.
  const added = setManiaValue(skinIni, 4, "KeyImage1D", "keys/down");
  expect(added).toBe(skinIni.replace("ColumnWidth: 40\r\n", "ColumnWidth: 40\r\n    KeyImage1D: keys/down\r\n"));
  expect(maniaValue(added, 4, "KeyImage1D")).toBe("keys/down");
  // Removing restores the text; the second 4K block is never touched.
  expect(setManiaValue(added, 4, "KeyImage1D", undefined)).toBe(skinIni);
  expect(setManiaValue(skinIni, 4, "Absent", undefined)).toBe(skinIni);
  // A missing block is appended in the file's line endings.
  const seven = setManiaValue(skinIni, 7, "NoteImage3", "n");
  expect(seven).toBe(skinIni + "\r\n[Mania]\r\nKeys: 7\r\nNoteImage3: n\r\n");
  expect(maniaKeyCounts(parse(seven))).toEqual([4, 7]);
  // LF files, a last line without a newline, duplicates.
  expect(setManiaValue("[Mania]\nKeys: 7\nKeyImage0: a\nKeyImage0: b", 7, "KeyImage0", "c")).toBe(
    "[Mania]\nKeys: 7\nKeyImage0: c\n",
  );
  expect(setManiaValue("[Mania]\nKeys: 7", 7, "KeyImage0", "c")).toBe("[Mania]\nKeys: 7\nKeyImage0: c");
  expect(setManiaValue("[Mania]\nKeys: 7\nKeyImage0: c", 7, "KeyImage0", undefined)).toBe("[Mania]\nKeys: 7");
  expect(() => setManiaValue(skinIni, 4, "Keys", "5")).toThrow();
  expect(() => setManiaValue(skinIni, 4, "NoteImage0", "a\nb")).toThrow();
});

test("image paths become skin.ini values: relative, forward slashes, no extension", () => {
  expect(imagePathValue("skin-studio\\7k\\note@2x.PNG")).toBe("skin-studio/7k/note");
  expect(imagePathValue("./Circles/Baby Pink.jpg")).toBe("Circles/Baby Pink");
  expect(imagePathValue("arrow.left.png")).toBe("arrow.left");
  expect(imagePathValue("note-0.png")).toBe("note-0");
  for (const bad of ["../x.png", "/etc/x.png", "C:\\x.png", "a//b.png", "a/./b.png", "sound.wav", "", "@2x.png"])
    expect(imagePathValue(bad)).toBeUndefined();
});

test("a key count's block is added once, in the file's line endings", () => {
  expect(addManiaBlock("[General]\nName: X", 7)).toBe("[General]\nName: X\n\n[Mania]\nKeys: 7\n");
  expect(addManiaBlock(skinIni, 4)).toBe(skinIni);
  expect(addManiaBlock("", 4)).toBe("[Mania]\r\nKeys: 4\r\n");
});

test("a second Keys in one [Mania] section starts the next block, as lazer reads it", () => {
  // A header typo ("[Mania" is not a header): lazer's decoder still starts a
  // 10K configuration at its Keys line; the 9K one keeps the lines before it.
  const text = "[Mania]\nKeys: 9\nNoteImage0: a\n[Mania\nKeys: 10\nColumnWidth: 44\n";
  const doc = parse(text);
  expect(maniaKeyCounts(doc)).toEqual([9, 10]);
  expect(maniaValue(text, 9, "NoteImage0")).toBe("a");
  expect(maniaValue(text, 9, "ColumnWidth")).toBeUndefined();
  expect(maniaValue(text, 10, "ColumnWidth")).toBe("44");
  expect(maniaValue(text, 10, "NoteImage0")).toBeUndefined();
  expect(serialize(doc)).toBe(text);
});

test("missing image diagnostics identify the referenced filename", () => {
  const diagnostics = validate("[Mania]\nKeys: 4\nStageRight: mania/stage/70/stageright\nNoteImage0: missing-note\n", []);
  expect(diagnostics.some((d) => d.message.includes("Missing image: mania/stage/70/stageright"))).toBe(true);
  expect(diagnostics.some((d) => d.message.includes("Missing image: missing-note"))).toBe(true);
});
