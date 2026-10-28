import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { loadScope, loadSkin, maniaImageNames, maniaKeysFor } from "../src";
import { pathCandidates, validate } from "@vosu-tools/skin-spec";

// Bun has no createImageBitmap: blobs become fake bitmaps named by their text.
globalThis.createImageBitmap = (async (blob: Blob) => ({
  name: await blob.text(),
  width: 64,
  height: 64,
  close() {},
})) as unknown as typeof createImageBitmap;

const files: Record<string, string> = {
  "skin.ini": [
    "[General]",
    "Version: 2.7",
    "[Mania]",
    "Keys: 4",
    "NoteImage0L: four/body",
    "NoteImage1: hitcircle",
    "[Mania]",
    "Keys: 7",
    "NoteImage0L: seven/body",
    "StageLeft: seven/left",
  ].join("\n"),
  "hitcircle.png": "hitcircle",
  "four/body.png": "four-body",
  "seven/body-0.png": "seven-body-0",
  "seven/body-1.png": "seven-body-1",
  "seven/left.png": "seven-left",
  "mania-note1.png": "note1",
  "mania-key1.png": "key1",
};
const requests: string[] = [];
const resolve = async (name: string) => {
  requests.push(name);
  return name in files ? new Blob([files[name]]) : null;
};
const nameOf = (bitmap: ImageBitmap | undefined) =>
  (bitmap as unknown as { name: string } | undefined)?.name;

test("a stage's mania images: custom paths and the defaults they fall back to", async () => {
  const skin = await loadSkin(resolve, "keys", { maniaKeys: [] });
  const four = maniaImageNames(skin, 4),
    seven = maniaImageNames(skin, 7);
  expect(four.has("four/body")).toBe(true);
  expect(four.has("seven/body")).toBe(false);
  expect(seven.has("seven/body")).toBe(true);
  expect(seven.has("seven/left")).toBe(true);
  expect(seven.has("mania-stage-left")).toBe(false);
  // Defaults for columns without overrides.
  expect(four.has("mania-key1")).toBe(true);
  expect(four.has("mania-note1L")).toBe(true);
});

test("mania images are decoded per key count and shared across switches", async () => {
  requests.length = 0;
  const general = await loadSkin(resolve, "keys", { maniaKeys: [] });
  expect(general.assets.has("hitcircle")).toBe(true);
  expect(general.assets.has("mania-note1")).toBe(false);
  expect(requests.some((r) => r.startsWith("four/"))).toBe(false);
  const four = await loadScope(general, { maniaKeys: [4] });
  expect(nameOf(four.assets.get("four/body"))).toBe("four-body");
  expect(nameOf(four.assets.get("mania-note1"))).toBe("note1");
  expect(four.assets.has("seven/body")).toBe(false);
  // General images are the same bitmaps; the input skin is untouched.
  expect(four.assets.get("hitcircle")).toBe(general.assets.get("hitcircle"));
  expect(general.assets.has("four/body")).toBe(false);
  requests.length = 0;
  const seven = await loadScope(four, { maniaKeys: [7] });
  expect(seven.assets.has("four/body")).toBe(false);
  expect(seven.animations?.get("seven/body")).toEqual([
    "seven/body-0",
    "seven/body-1",
  ]);
  expect(nameOf(seven.assets.get("seven/left"))).toBe("seven-left");
  // Shared defaults are kept, not decoded again; a NoteImage naming a
  // general element never drops it.
  expect(seven.assets.get("mania-note1")).toBe(four.assets.get("mania-note1"));
  expect(requests).not.toContain("mania-note1.png");
  expect(requests).not.toContain("hitcircle.png");
  expect(seven.assets.get("hitcircle")).toBe(general.assets.get("hitcircle"));
  const none = await loadScope(seven, { maniaKeys: [] });
  expect([...none.assets.keys()].some((k) => k.startsWith("seven/"))).toBe(
    false,
  );
  expect(none.assets.has("hitcircle")).toBe(true);
});

test("without maniaKeys every key count is decoded, as before", async () => {
  const all = await loadSkin(resolve, "keys");
  expect(all.assets.has("four/body")).toBe(true);
  expect(all.assets.has("seven/body")).toBe(true);
});

test("renderer requests and ini diagnostics agree on case-folded PNGs and JPEG-only fields", async () => {
  const ini = "[General]\nVersion: 2.7\n[Mania]\nKeys: 4\nNoteImage0: upper\\case\nNoteImage1: jpeg-only\n";
  const names = ["UPPER/CASE@2x.PNG", "jpeg-only.jpg"];
  const assets = new Map([["skin.ini", ini], [names[0].toLowerCase(), "png"], [names[1], "jpeg"]]);
  const asked: string[] = [];
  const skin = await loadSkin(async (path) => {
    asked.push(path);
    const value = assets.get(path.replace(/\\/g, "/").toLowerCase());
    return value === undefined ? null : new Blob([value]);
  }, "path policy", { maniaKeys: [4], rulesets: [3] });
  expect(skin.assets.has("upper/case")).toBe(true);
  expect(skin.assets.has("jpeg-only")).toBe(false);
  expect(asked).toContain("upper/case@2x.png");
  expect(asked).not.toContain("jpeg-only.jpg");
  const missing = validate(ini, names).filter((issue) => issue.message.startsWith("Missing image"));
  expect(missing).toHaveLength(1);
  expect(missing[0].line).toBe(6);
  expect(pathCandidates(names)).toEqual(["UPPER/CASE"]);
});

test("maniaKeysFor follows CS, Difficulty Adjust and the cs override", () => {
  const map = (mode: number, cs: number) =>
    parseOsu(
      `osu file format v14\n[General]\nMode:${mode}\n[Difficulty]\nCircleSize:${cs}\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n`,
    );
  expect(maniaKeysFor(map(3, 7))).toEqual([7]);
  expect(maniaKeysFor(map(0, 7))).toEqual([]);
  expect(
    maniaKeysFor(map(3, 4), {
      mods: [{ acronym: "DA", settings: { circle_size: 6 } }],
    }),
  ).toEqual([6]);
  expect(maniaKeysFor(map(3, 4), { cs: 9 })).toEqual([9]);
});
