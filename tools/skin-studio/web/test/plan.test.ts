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
  );
  expect(copied(plan, other.key).sort()).toEqual(
    ["default-0.png", "numbers/hit-0.png", "numbers/hit-1@2x.png"].sort(),
  );
  const ini = parseIni(plan.ini);
  expect(getValue(ini, "Fonts", "HitCirclePrefix")).toBe("numbers/hit");
  expect(getValue(ini, "Colours", "Combo1")).toBe("2,2,2");
  expect(getValue(ini, "Colours", "Combo2")).toBe("3,3,3");
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
  );
  const blocks = maniaBlocks(parseIni(plan.ini));
  expect(serializeIni([blocks.get(4)!])).toContain("NoteImage0: mania/note1");
  expect(serializeIni([blocks.get(7)!])).toContain("ColumnWidth: 30");
  expect(copied(plan, base.key)).not.toContain("base/note.png");
  expect(copied(plan, other.key)).not.toContain("mania/unused.png");
});

// A stage whose block names no images: the skin draws its default-named
// files (like the user's "Orchids Garden"), and the base has its own
// default-named key for its other key counts.
const plain: SkinData = {
  key: "/skins/Plain",
  name: "Plain",
  text: ["[General]", "Name: Plain", "[Mania]", "Keys: 4", "ColumnWidth: 60", ""].join("\n"),
  files: [
    "mania-key1.png",
    "mania-key1@2x.png",
    "mania-key1D.png",
    "mania-key2.png",
    "mania-key2D.png",
    "mania-note1.png",
    "mania-note1-0.png",
    "mania-note1-1@2x.png",
    "mania-note2.png",
    "mania-note1L.png",
    "LightingN-0.png",
    "mania-hit300.png",
  ],
};
const withKey: SkinData = {
  ...base,
  key: "/skins/WithKey",
  files: [...base.files, "mania-key1.png"],
};

test("a stage group carries the images its source finds under default names", () => {
  const pool = new Map([
    [withKey.key, withKey],
    [plain.key, plain],
  ]);
  const { plan, fallbacks } = compose(
    {
      name: "M",
      base: withKey.key,
      picks: { "mania-keys-4": { kind: "skin", key: plain.key } },
    },
    pool,
  );
  const block = serializeIni([maniaBlocks(parseIni(plan.ini)).get(4)!]);
  // Default names per column (4K: 1 2 2 1), in the source's spelling.
  for (const line of [
    "KeyImage0: skin-studio/4k/mania-key1",
    "KeyImage1: skin-studio/4k/mania-key2",
    "KeyImage2D: skin-studio/4k/mania-key2D",
    "NoteImage0: skin-studio/4k/mania-note1",
    "NoteImage1: skin-studio/4k/mania-note2",
    "NoteImage3L: skin-studio/4k/mania-note1L",
    "LightingN: skin-studio/4k/LightingN",
    "Hit300: skin-studio/4k/mania-hit300",
  ])
    expect(block).toContain(line);
  // Nothing to carry: those keys stay out.
  expect(block).not.toContain("NoteImage0H");
  const fromPlain = plan.sources.find((s) => s.skin === plain.key)!.files;
  expect(fromPlain).toContainEqual(["mania-key1@2x.png", "skin-studio/4k/mania-key1@2x.png"]);
  // Notes animate: their frames, not the plain image, are what the stage reads.
  expect(fromPlain).toContainEqual(["mania-note1-1@2x.png", "skin-studio/4k/mania-note1-1@2x.png"]);
  expect(fromPlain).not.toContainEqual(["mania-note1.png", "skin-studio/4k/mania-note1.png"]);
  // The base's own default-named key stays for its 7K stage.
  expect(copied(plan, withKey.key)).toContain("mania-key1.png");
  // Only the base's replaced 4K note is gone; no receptor or note falls back.
  expect(fallbacks.get("mania-keys-4")).toEqual(["base/note"]);
});

test("a stage group says which receptors and notes fall back to the built-in look", () => {
  const lacking: SkinData = {
    ...plain,
    files: plain.files.filter((f) => !/^mania-key\dD/.test(f)),
  };
  const { fallbacks } = compose(
    {
      name: "M",
      base: null,
      picks: { "mania-keys-4": { kind: "skin", key: lacking.key } },
    },
    new Map([[lacking.key, lacking]]),
  );
  expect(fallbacks.get("mania-keys-4")).toEqual([
    "KeyImage0D",
    "KeyImage1D",
    "KeyImage2D",
    "KeyImage3D",
  ]);
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
  );
  expect(plan.sources).toEqual([]);
  const ini = parseIni(plan.ini);
  expect(getValue(ini, "General", "Name")).toBe("Fresh");
  expect(getValue(ini, "General", "Version")).toBe("latest");
  expect(group("cursor").ini?.length).toBe(4);
});

const gameOver: SkinData = {
  key: "base",
  name: "base",
  files: [
    "skin.ini",
    "mania-stage-hint.png",
    "mania-stage-light@2x.png",
    "mania-hit300g-0.png",
    "lightingN.png",
  ],
  text: "[General]\nName: base\n[Mania]\nKeys: 4\nJudgementLine: 0\n",
};

test("blank hides every base file of a wildcard group, frames and @2x included", () => {
  const { plan } = compose(
    { name: "mix", base: "base", picks: { "mania-shared": { kind: "blank" } } },
    new Map([["base", gameOver]]),
  );
  const blanks = plan.blanks.map((b) => b.to.toLowerCase());
  for (const file of [
    "mania-stage-hint.png",
    "mania-stage-light@2x.png",
    "mania-hit300g-0.png",
    "lightingn.png",
  ])
    expect(blanks).toContain(file);
  const copied = plan.sources.flatMap((s) =>
    s.files.map((f) => (typeof f === "string" ? f : f[1])),
  );
  expect(copied.filter((f) => /^mania-/i.test(f))).toEqual([]);
  const block = maniaBlocks(parseIni(plan.ini)).get(4)!;
  expect(block.lines.some((l) => /^JudgementLine:\s*0$/.test(l.trim()))).toBe(
    true,
  );
});

test("a base file a kept skin.ini key names survives its group's pick", () => {
  const base: SkinData = {
    ...gameOver,
    files: [...gameOver.files, "mania-stage-bottom.png"],
    text:
      "[General]\nName: base\n[Mania]\nKeys: 4\nJudgementLine: 0\n" +
      "[Mania]\nKeys: 10\nStageHint: mania-stage-hint\n",
  };
  const arturia: SkinData = {
    key: "other",
    name: "other",
    files: ["skin.ini", "mania-stage-light.png"],
    text: "[General]\nName: other\n",
  };
  for (const pick of [
    { kind: "default" as const },
    { kind: "skin" as const, key: "other" },
  ]) {
    const { plan, fallbacks } = compose(
      { name: "mix", base: "base", picks: { "mania-shared": pick } },
      new Map([
        ["base", base],
        ["other", arturia],
      ]),
    );
    const from = (name: string) =>
      plan.sources.find((s) => s.files.includes(name))?.skin;
    // The 10K block still names the hint, so the base's file stays.
    expect(from("mania-stage-hint.png")).toBe("base");
    expect(
      maniaBlocks(parseIni(plan.ini))
        .get(10)!
        .lines.some((l) => /StageHint: mania-stage-hint/.test(l)),
    ).toBe(true);
    // Nothing names the bottom or the 300g frames: they fall back, and say so.
    expect(fallbacks.get("mania-shared")).toEqual(
      expect.arrayContaining(["mania-hit300g", "mania-stage-bottom"]),
    );
    expect(fallbacks.get("mania-shared")).not.toContain("mania-stage-hint");
  }
});
