import { expect, test } from "bun:test";
import {
  compose,
  groupFiles,
  maniaGroup,
  type Plan,
  type SkinData,
} from "../src/plan";
import { elementMatches, frames, groups } from "../src/groups";
import { getValue, maniaBlocks, parseIni, serializeIni } from "../src/ini";

const base: SkinData = {
  key: "/skins/Base",
  name: "Base",
  text: [
    "// base skin",
    "[General]",
    "Name: Base",
    "Author: A",
    "Version: 2.7",
    "AnimationFramerate: 30",
    "",
    "[Colours]",
    "Combo1: 1,1,1",
    "SliderBorder: 10,10,10",
    "",
    "[Mania]",
    "Keys: 4",
    "NoteImage0: base/note",
    "",
    "[Mania]",
    "Keys: 7",
    "ColumnWidth: 30",
    "",
  ].join("\r\n"),
  files: [
    "hitcircle.png",
    "hitcircle@2x.png",
    "sliderb0.png",
    "sliderb1.png",
    "sliderfollowcircle.png",
    "cursor.png",
    "base/note.png",
    "skin.ini",
    "skin.ini.backup-x.bak",
    "normal-hitclap.wav",
  ],
};
const other: SkinData = {
  key: "/skins/Other",
  name: "Other",
  text: [
    "[General]",
    "Name: Other",
    "[Colours]",
    "Combo1: 2,2,2",
    "Combo2: 3,3,3",
    "SliderBorder: 200,0,0",
    "SliderTrackOverride: 5,5,5",
    "[Fonts]",
    "HitCirclePrefix: numbers/hit",
    "[Mania]",
    "Keys: 4",
    "NoteImage0: mania/note1",
    "KeyImage0: mania/key1",
    "",
  ].join("\n"),
  files: [
    "sliderb-0.png",
    "sliderb-1.png",
    "sliderb-2.png",
    "reversearrow@2x.png",
    "numbers/hit-0.png",
    "numbers/hit-1@2x.png",
    "default-0.png",
    "mania/note1.png",
    "mania/note1-0.png",
    "mania/note1-1.png",
    "mania/key1.png",
    "mania/unused.png",
    "soft-hitnormal.ogg",
  ],
};
const skins = new Map([
  [base.key, base],
  [other.key, other],
]);
const group = (id: string) => groups.find((g) => g.id === id)!;
const copied = (plan: Plan, skin: string) =>
  (plan.sources.find((s) => s.skin === skin)?.files ?? []).map((f) =>
    typeof f === "string" ? f : f[1],
  );

test("element matching covers @2x, frames and wildcards", () => {
  const anim = { name: "sliderb", anim: true };
  expect(elementMatches(anim, "SliderB12@2x.png")).toBe(true);
  expect(elementMatches(anim, "sliderb-nd.png")).toBe(false);
  expect(elementMatches({ name: "default-*" }, "default-comma.png")).toBe(true);
  expect(
    elementMatches({ name: "normal-*", audio: true }, "normal-hitclap.wav"),
  ).toBe(true);
  expect(
    elementMatches({ name: "normal-*", audio: true }, "normal-hitclap.png"),
  ).toBe(false);
  expect(elementMatches({ name: "cursor" }, "sub/cursor.png")).toBe(false);
  expect(frames(other.files, "sliderb")).toEqual([
    "sliderb-0.png",
    "sliderb-1.png",
    "sliderb-2.png",
  ]);
  expect(frames(base.files, "hitcircle")).toEqual([]);
});

test("a base plus one group swaps exactly that group's files and keys", () => {
  const { plan, counts } = compose(
    {
      name: "Proof Mix",
      base: base.key,
      picks: { sliders: { kind: "skin", key: other.key } },
    },
    skins,
    "stable",
  );
  const fromBase = copied(plan, base.key);
  expect(fromBase).toContain("hitcircle@2x.png");
  expect(fromBase).toContain("cursor.png");
  expect(fromBase).not.toContain("sliderb0.png");
  expect(fromBase).not.toContain("sliderfollowcircle.png");
  expect(fromBase).not.toContain("skin.ini");
  expect(fromBase.some((f) => f.endsWith(".bak"))).toBe(false);
  expect(copied(plan, other.key).sort()).toEqual(
    [
      "reversearrow@2x.png",
      "sliderb-0.png",
      "sliderb-1.png",
      "sliderb-2.png",
    ].sort(),
  );
  expect(counts.get(other.key)).toBe(4);
  const ini = parseIni(plan.ini);
  expect(getValue(ini, "General", "Name")).toBe("Proof Mix");
  expect(getValue(ini, "General", "Version")).toBe("2.7");
  expect(getValue(ini, "Colours", "SliderBorder")).toBe("200,0,0");
  expect(getValue(ini, "Colours", "SliderTrackOverride")).toBe("5,5,5");
  expect(getValue(ini, "Colours", "Combo1")).toBe("1,1,1");
  expect(plan.ini).toContain("// base skin");
});

test("fonts follow their skin.ini prefixes; combo colours move as a set", () => {
  const { plan } = compose(
    {
      name: "N",
      base: base.key,
      picks: {
        numbers: { kind: "skin", key: other.key },
        "combo-colours": { kind: "skin", key: other.key },
      },
    },
    skins,
    "osk",
  );
  expect(copied(plan, other.key).sort()).toEqual(
    ["default-0.png", "numbers/hit-0.png", "numbers/hit-1@2x.png"].sort(),
  );
  const ini = parseIni(plan.ini);
  expect(getValue(ini, "Fonts", "HitCirclePrefix")).toBe("numbers/hit");
  expect(getValue(ini, "Colours", "Combo1")).toBe("2,2,2");
  expect(getValue(ini, "Colours", "Combo2")).toBe("3,3,3");
  expect(plan.target).toBe("osk");
});

test("mania key-count groups replace one [Mania] block with its images", () => {
  expect(groupFiles(maniaGroup(4), other).sort()).toEqual(
    [
      "mania/key1.png",
      "mania/note1-0.png",
      "mania/note1-1.png",
      "mania/note1.png",
    ].sort(),
  );
  const { plan } = compose(
    {
      name: "M",
      base: base.key,
      picks: { "mania-keys-4": { kind: "skin", key: other.key } },
    },
    skins,
    "stable",
  );
  const blocks = maniaBlocks(parseIni(plan.ini));
  expect(serializeIni([blocks.get(4)!])).toContain("NoteImage0: mania/note1");
  expect(serializeIni([blocks.get(7)!])).toContain("ColumnWidth: 30");
  expect(copied(plan, base.key)).not.toContain("base/note.png");
  expect(copied(plan, other.key)).not.toContain("mania/unused.png");
});

test("default removes and blank hides a group", () => {
  const { plan } = compose(
    {
      name: "B",
      base: base.key,
      picks: {
        hitcircles: { kind: "default" },
        cursor: { kind: "blank" },
        hitsounds: { kind: "default" },
      },
    },
    skins,
    "stable",
  );
  const fromBase = copied(plan, base.key);
  expect(fromBase).not.toContain("hitcircle.png");
  expect(fromBase).not.toContain("cursor.png");
  expect(fromBase).not.toContain("normal-hitclap.wav");
  expect(plan.blanks).toContainEqual({ to: "cursor.png", kind: "png" });
  expect(plan.blanks.some((b) => b.to === "hitcircle.png")).toBe(false);
});

test("without a base the mix starts from a minimal skin.ini", () => {
  const { plan } = compose(
    {
      name: "Fresh",
      base: null,
      picks: { cursor: { kind: "skin", key: other.key } },
    },
    skins,
    "stable",
  );
  expect(plan.sources).toEqual([]);
  const ini = parseIni(plan.ini);
  expect(getValue(ini, "General", "Name")).toBe("Fresh");
  expect(getValue(ini, "General", "Version")).toBe("latest");
  expect(group("cursor").ini?.length).toBe(4);
});
