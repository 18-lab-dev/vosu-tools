import { expect, test } from "bun:test";
import { parseSkinIni, parseOsu, applyMods } from "../src";
test("skin parser keeps repeated Mania blocks and unknown commands", () => {
  const skin = parseSkinIni(
    "\uFEFF[Mania]\r\nKeys: 4\r\nColumnWidth: 40,40,40,40\r\n[Mania]\nKeys: 7\nNoteImage0: custom/note\n[Colours]\nCombo1: 255,128,0\nMystery: retained",
  );
  expect(skin.get("Mania")?.map((s) => s.Keys)).toEqual(["4", "7"]);
  expect(skin.get("Mania")?.[1].NoteImage0).toBe("custom/note");
  expect(skin.get("Colours")?.[0].Mystery).toBe("retained");
});
test("mania HR and EZ never change key count", () => {
  const m = parseOsu(
    "[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0",
  );
  for (const acronym of ["HR", "EZ"])
    expect(applyMods(m, [{ acronym }]).difficulty.cs).toBe(4);
});
test("even repeat slider endpoint stacks at start rather than curve tail", () => {
  const m = parseOsu(
    "osu file format v14\n[Difficulty]\nApproachRate:5\nSliderMultiplier:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,100,1000,2,0,L|200:100,2,100\n100,100,2050,1,0",
  );
  expect(m.objects[0].endTime).toBe(2000);
  expect(m.objects[1].stack).toBe(-1);
});

test("values lose trailing // comments like lazer's decoder", () => {
  const sections = parseSkinIni(
    "[Colours]\nCombo1: 255,255,255 // #FFFFFF\nSliderBall: 2,170,255//blue\n// a comment line\n[General]\nName: plain\n",
  );
  expect(sections.get("Colours")?.[0]).toMatchObject({
    Combo1: "255,255,255",
    SliderBall: "2,170,255",
  });
  expect(sections.get("General")?.[0]?.Name).toBe("plain");
});
