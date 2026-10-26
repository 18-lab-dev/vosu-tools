import { expect, test } from "bun:test";
import {
  convertRequest,
  exportStages,
  lookupFrames,
  mixKeyCounts,
  planFiles,
  supports,
  targetNote,
} from "../src/export-targets";
import { imageIndex } from "../src/mania";
import type { Plan } from "../src/plan";

const plan: Plan = {
  name: "Mix",
  overwrite: false,
  ini: [
    "[General]",
    "Name: Mix",
    "Version: 2.5",
    "",
    "[Mania]",
    "Keys: 4",
    "ColumnWidth: 40,40,40,40",
    "HitPosition: 380",
    "NoteImage0: notes/a",
    "KeyImage0: keys/k",
    "Colour1: 10,20,30,128",
    "ColourLight1: 0,0,0,0",
    "",
    "[Mania]",
    "Keys: 12",
    "",
  ].join("\r\n"),
  sources: [
    {
      skin: "/s",
      files: [
        "notes/a.png",
        "notes/a@2x.png",
        ["x/lightingN-0.png", "lightingN-0.png"],
        "lightingN-1@2x.png",
        "lightingN-1.png",
        "mania-note2.png",
        "keys/k.png",
      ],
    },
  ],
  blanks: [
    { to: "mania-hit0.png", kind: "png" },
    { to: "x.wav", kind: "wav" },
  ],
};

test("key counts come from the blocks, else lazer's 4K and 7K", () => {
  expect(mixKeyCounts(plan.ini)).toEqual([4, 12]);
  expect(mixKeyCounts("[General]\r\nName: X\r\n")).toEqual([4, 7]);
  expect([1, 10, 11].map((k) => supports("quaver", k))).toEqual([
    true,
    true,
    false,
  ]);
  expect([2, 3, 10, 11].map((k) => supports("etterna", k))).toEqual([
    false,
    true,
    true,
    false,
  ]);
});

test("notes say what each target skips", () => {
  expect(targetNote("quaver", [4, 12])).toContain("skips 12K");
  expect(targetNote("etterna", [1, 2])).toStartWith("No key count");
  expect(targetNote("etterna", [4, 7])).not.toContain("skips");
});

test("frames prefer @2x per frame, in order", () => {
  const files = planFiles(plan);
  expect(files).toContain("lightingN-0.png");
  expect(files).toContain("mania-hit0.png");
  expect(files).not.toContain("x.wav");
  const index = imageIndex(files);
  expect(lookupFrames(index, "lightingN", true)).toEqual([
    { path: "lightingN-0.png", hd: false },
    { path: "lightingN-1@2x.png", hd: true },
  ]);
  expect(lookupFrames(index, "notes/a", false)).toEqual([
    { path: "notes/a@2x.png", hd: true },
  ]);
});

test("stages carry lazer's resolved lookups and layout", () => {
  const [four, twelve] = exportStages(plan, [4, 12]);
  expect(four.columns).toHaveLength(4);
  expect(four.columns[0].width).toBeCloseTo(64);
  expect(four.hitPosition).toBeCloseTo((480 - 380) * 1.6);
  expect(four.columns[0].note).toEqual({
    frames: [{ path: "notes/a@2x.png", hd: true }],
  });
  // Column 2 (kind 2) finds mania-note2 under its default name; its head
  // and tail look up mania-note2H / 2T, which osu!'s built-in look has.
  const second = { frames: [{ path: "mania-note2.png", hd: false }] };
  expect(four.columns[1].note).toEqual(second);
  expect(four.columns[1].head).toEqual({ builtin: true });
  expect(four.columns[1].tail).toEqual({ builtin: true });
  // No key2 image: osu!'s built-in look.
  expect(four.columns[1].key).toEqual({ builtin: true });
  expect(four.columns[0].key).toEqual({
    frames: [{ path: "keys/k.png", hd: false }],
  });
  // Doubled background alpha; a zero-alpha light becomes opaque.
  expect(four.columns[0].colour).toEqual([10, 20, 30, 64]);
  expect(four.columns[0].light).toEqual([0, 0, 0, 255]);
  expect(four.lightingN).toEqual({
    frames: [
      { path: "lightingN-0.png", hd: false },
      { path: "lightingN-1@2x.png", hd: true },
    ],
  });
  expect(four.stageLeft).toBeNull();
  // A blank judgement is the mix's (invisible) image.
  expect(four.judgements.miss).toEqual({
    frames: [{ path: "mania-hit0.png", hd: false }],
  });
  expect(four.judgements.great).toEqual({ builtin: true });
  expect(twelve.columns).toHaveLength(12);
  const request = convertRequest(plan, "quaver");
  expect(request.target).toBe("quaver");
  expect(request.stages.map((s) => s.keys)).toEqual([4, 12]);
  expect(request.sources).toBe(plan.sources);
});
