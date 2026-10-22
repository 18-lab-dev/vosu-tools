import { test, expect } from "bun:test";
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
  expect(pathCandidates(files, true)).toContain("digits");
  expect(hasAsset("sub/note", files)).toBe(true);
  expect(hasAsset("digits", files, true)).toBe(true);
  expect(hasAsset("digits", files.slice(0, -2), true)).toBe(false);
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
