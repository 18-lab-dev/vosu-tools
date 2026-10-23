import { expect, test } from "bun:test";
import { compose, type Plan, type SkinData } from "../src/plan";
import { fontOf, fontPrefixes, inUnit, unitFiles } from "../src/assets";
import { entries, getValue, maniaBlocks, parseIni } from "../src/ini";

const skin = (key: string, text: string, files: string[]): SkinData => ({
  key,
  name: key,
  text: text.split("\n").join("\r\n"),
  files,
});
const base = skin(
  "/Base",
  [
    "[General]",
    "Name: Base",
    "Version: 2.7",
    "AnimationFramerate: 10",
    "[Fonts]",
    "HitCirclePrefix: fonts/base",
    "HitCircleOverlap: 3",
    "[Mania]",
    "Keys: 4",
    "NoteImage0: mania/basenote",
    "NoteImage1: mania/basenote",
    "KeyImage0: mania/basekey",
  ].join("\n"),
  [
    "hitcircle.png",
    "hitcircle@2x.png",
    "approachcircle.png",
    "hit300-0.png",
    "hit300-1.png",
    "sliderb0.png",
    "sliderb1.png",
    "sliderb-nd.png",
    "fonts/base-0.png",
    "fonts/base-1.png",
    "mania/basenote.png",
    "mania/basekey.png",
    "mania-note1.png",
    "normal-hitclap.wav",
  ],
);
const group = skin("/Group", ["[General]", "Name: Group"].join("\n"), [
  "hitcircle.png",
  "approachcircle.png",
  "hitcircleoverlay.png",
]);
const asset = skin(
  "/Asset",
  [
    "[General]",
    "Name: Asset",
    "AnimationFramerate: 30",
    "[Fonts]",
    "HitCirclePrefix: numbers/hit",
    "HitCircleOverlap: -4",
    "[Mania]",
    "Keys: 4",
    "NoteImage1: notes/pretty",
    "[Mania]",
    "Keys: 7",
    "NoteImage3: notes/pretty",
  ].join("\n"),
  [
    "hitcircle@2x.png",
    "hit300-0@2x.png",
    "hit300-1@2x.png",
    "hit300-2@2x.png",
    "sliderb0.png",
    "sliderb1.png",
    "sliderb2.png",
    "numbers/hit-0.png",
    "numbers/hit-1.png",
    "numbers/hit-comma.png",
    "notes/pretty.png",
    "notes/pretty@2x.png",
    "mania-note1.png",
    "default-0.png",
    "default-1.png",
    "normal-hitclap.ogg",
  ],
);
const skins = new Map([base, group, asset].map((s) => [s.key, s]));
const files = (plan: Plan, key: string) =>
  (plan.sources.find((s) => s.skin === key)?.files ?? []).map((f) =>
    typeof f === "string" ? f : f[1],
  );

test("units cover @2x, frames and glyphs, nothing else", () => {
  const image = { kind: "image", name: "hit300" } as const;
  expect(inUnit(image, "hit300-2@2x.png")).toBe(true);
  expect(inUnit(image, "hit300g.png")).toBe(false);
  expect(inUnit(image, "hit300.wav")).toBe(false);
  const sliderb = { kind: "image", name: "sliderb" } as const;
  expect(inUnit(sliderb, "SliderB12@2x.png")).toBe(true);
  expect(inUnit(sliderb, "sliderb-nd.png")).toBe(false);
  const middle = { kind: "image", name: "spinner-middle" } as const;
  expect(inUnit(middle, "spinner-middle2.png")).toBe(false);
  expect(
    inUnit({ kind: "font", name: "numbers/hit" }, "numbers/hit-comma.png"),
  ).toBe(true);
  expect(
    inUnit({ kind: "sound", name: "normal-hitclap" }, "normal-hitclap.ogg"),
  ).toBe(true);
  expect(fontOf("score-percent@2x.png")).toBe("score");
  expect(fontOf("hit300.png")).toBeUndefined();
});

test("an override beats the group pick, which beats the base", () => {
  const { plan, notes } = compose(
    {
      name: "Mix",
      base: base.key,
      picks: { hitcircles: { kind: "skin", key: group.key } },
      overrides: { "image:hitcircle": { skin: asset.key } },
    },
    skins,
  );
  // The asset replaces every variant of the base's and the group's hitcircle.
  expect(files(plan, asset.key)).toEqual(["hitcircle@2x.png"]);
  expect(files(plan, group.key).sort()).toEqual([
    "approachcircle.png",
    "hitcircleoverlay.png",
  ]);
  expect(files(plan, base.key)).not.toContain("hitcircle.png");
  expect(files(plan, base.key)).not.toContain("hitcircle@2x.png");
  expect(files(plan, base.key)).not.toContain("approachcircle.png");
  expect(notes.get("image:hitcircle")).toMatchObject({
    group: "hitcircles",
    files: 1,
    carried: [],
    unreferenced: false,
  });
});

test("an override on a blank or default group still brings the asset", () => {
  const { plan } = compose(
    {
      name: "Mix",
      base: base.key,
      picks: { judgements: { kind: "blank" } },
      overrides: { "image:hit300": { skin: asset.key } },
    },
    skins,
  );
  expect(files(plan, asset.key).sort()).toEqual([
    "hit300-0@2x.png",
    "hit300-1@2x.png",
    "hit300-2@2x.png",
  ]);
  expect(
    plan.blanks.some((b) => b.to.toLowerCase().startsWith("hit300.")),
  ).toBe(false);
  expect(plan.blanks.some((b) => b.to === "hit100.png")).toBe(true);
});

test("animations offer the frame rate; accepting it changes [General]", () => {
  const recipe = {
    name: "Mix",
    base: base.key,
    picks: {},
    overrides: { "image:sliderb": { skin: asset.key } },
  };
  const offered = compose(recipe, skins);
  const note = offered.notes.get("image:sliderb")!;
  expect(note.offers).toEqual([
    {
      id: "framerate",
      label: "Frame rate",
      changes: ["[General] AnimationFramerate: 30"],
      applied: false,
    },
  ]);
  expect(
    getValue(parseIni(offered.plan.ini), "General", "AnimationFramerate"),
  ).toBe("10");
  // Only the sliderb frames move; sliderb-nd is another element.
  expect(files(offered.plan, asset.key).sort()).toEqual([
    "sliderb0.png",
    "sliderb1.png",
    "sliderb2.png",
  ]);
  expect(files(offered.plan, base.key)).toContain("sliderb-nd.png");
  const accepted = compose(
    {
      ...recipe,
      overrides: { "image:sliderb": { skin: asset.key, carry: ["framerate"] } },
    },
    skins,
  );
  expect(
    getValue(parseIni(accepted.plan.ini), "General", "AnimationFramerate"),
  ).toBe("30");
  expect(accepted.notes.get("image:sliderb")!.offers[0].applied).toBe(true);
});

test("a font carries its prefix key and offers its overlap", () => {
  const recipe = {
    name: "Mix",
    base: base.key,
    picks: {},
    overrides: { "font:numbers/hit": { skin: asset.key } },
  };
  const { plan, notes } = compose(recipe, skins);
  const ini = parseIni(plan.ini);
  expect(getValue(ini, "Fonts", "HitCirclePrefix")).toBe("numbers/hit");
  expect(getValue(ini, "Fonts", "HitCircleOverlap")).toBe("3");
  expect(files(plan, asset.key).sort()).toEqual([
    "numbers/hit-0.png",
    "numbers/hit-1.png",
    "numbers/hit-comma.png",
  ]);
  const note = notes.get("font:numbers/hit")!;
  expect(note.group).toBe("numbers");
  expect(note.carried).toEqual(["[Fonts] HitCirclePrefix: numbers/hit"]);
  expect(note.offers.map((o) => [o.id, o.changes])).toEqual([
    ["overlap", ["[Fonts] HitCircleOverlap: -4"]],
  ]);
  const accepted = compose(
    {
      ...recipe,
      overrides: {
        "font:numbers/hit": { skin: asset.key, carry: ["overlap"] },
      },
    },
    skins,
  );
  expect(
    getValue(parseIni(accepted.plan.ini), "Fonts", "HitCircleOverlap"),
  ).toBe("-4");
});

test("a mania image brings the [Mania] keys that name it, per key count, only where needed", () => {
  const { plan, notes } = compose(
    {
      name: "Mix",
      base: base.key,
      picks: {},
      overrides: { "image:notes/pretty": { skin: asset.key } },
    },
    skins,
  );
  const blocks = maniaBlocks(parseIni(plan.ini));
  // 4K: only the column the asset skin draws with it; the base's other keys stay.
  const four = blocks.get(4)!;
  expect(entries([four], "Mania", "NoteImage1")[0].value).toBe("notes/pretty");
  expect(entries([four], "Mania", "NoteImage0")[0].value).toBe(
    "mania/basenote",
  );
  expect(entries([four], "Mania", "KeyImage0")[0].value).toBe("mania/basekey");
  // 7K had no block in the base: one is created with just that key.
  const seven = blocks.get(7)!;
  expect(
    entries([seven], "Mania", /.*/).map((e) => `${e.key}: ${e.value}`),
  ).toEqual(["Keys: 7", "NoteImage3: notes/pretty"]);
  expect(files(plan, asset.key).sort()).toEqual([
    "notes/pretty.png",
    "notes/pretty@2x.png",
  ]);
  const note = notes.get("image:notes/pretty")!;
  expect(note.group).toBe("mania-keys-4");
  expect(note.carried).toEqual([
    "[Mania 4K] NoteImage1: notes/pretty",
    "[Mania 7K] NoteImage3: notes/pretty",
  ]);
  expect(note.offers).toEqual([]);
});

test("nothing is carried when the mix already names the asset", () => {
  const same = skin(
    "/Same",
    ["[Mania]", "Keys: 4", "NoteImage0: mania/basenote"].join("\n"),
    ["mania/basenote.png"],
  );
  const { plan, notes } = compose(
    {
      name: "Mix",
      base: base.key,
      picks: {},
      overrides: { "image:mania/basenote": { skin: same.key } },
    },
    new Map([...skins, [same.key, same]]),
  );
  expect(notes.get("image:mania/basenote")!.carried).toEqual([]);
  expect(files(plan, same.key)).toEqual(["mania/basenote.png"]);
  expect(plan.ini).toBe(
    compose({ name: "Mix", base: base.key, picks: {} }, skins).plan.ini,
  );
});

test("a default-named mania image offers to clear the mix keys that name other images", () => {
  const recipe = {
    name: "Mix",
    base: base.key,
    picks: {},
    overrides: { "image:mania-note1": { skin: asset.key } },
  };
  const { notes, plan } = compose(recipe, skins);
  const offer = notes.get("image:mania-note1")!.offers[0];
  // The asset skin names NoteImage1 itself, so only NoteImage0 is in the way.
  expect(offer).toEqual({
    id: "clear",
    label: "Clear 1 key",
    changes: ["-[Mania 4K] NoteImage0"],
    applied: false,
  });
  expect(files(plan, asset.key)).toEqual(["mania-note1.png"]);
  const accepted = compose(
    {
      ...recipe,
      overrides: { "image:mania-note1": { skin: asset.key, carry: ["clear"] } },
    },
    skins,
  );
  const four = maniaBlocks(parseIni(accepted.plan.ini)).get(4)!;
  expect(entries([four], "Mania", "NoteImage0")).toEqual([]);
  expect(entries([four], "Mania", "NoteImage1")[0].value).toBe(
    "mania/basenote",
  );
});

test("a default font under a custom mix prefix offers to clear the prefix", () => {
  const { notes } = compose(
    {
      name: "Mix",
      base: base.key,
      picks: {},
      overrides: { "font:default": { skin: asset.key } },
    },
    skins,
  );
  // The asset skin's own HitCirclePrefix names another font, so nothing is carried.
  const note = notes.get("font:default")!;
  expect(note.carried).toEqual([]);
  expect(note.offers).toEqual([]);
  const plain = skin("/Plain", "[General]\nName: Plain", [
    "default-0.png",
    "default-1.png",
  ]);
  const second = compose(
    {
      name: "Mix",
      base: base.key,
      picks: {},
      overrides: { "font:default": { skin: plain.key } },
    },
    new Map([...skins, [plain.key, plain]]),
  );
  expect(
    second.notes.get("font:default")!.offers.map((o) => o.changes),
  ).toEqual([["-[Fonts] HitCirclePrefix"]]);
});

test("sounds replace every extension of their name; custom files are flagged unreferenced", () => {
  const { plan, notes } = compose(
    {
      name: "Mix",
      base: base.key,
      picks: {},
      overrides: {
        "sound:normal-hitclap": { skin: asset.key },
        "image:numbers/hit-comma": { skin: asset.key },
      },
    },
    skins,
  );
  expect(files(plan, asset.key)).toContain("normal-hitclap.ogg");
  expect(files(plan, base.key)).not.toContain("normal-hitclap.wav");
  expect(notes.get("sound:normal-hitclap")).toMatchObject({
    group: "hitsounds",
    unreferenced: false,
  });
  expect(notes.get("image:numbers/hit-comma")!.unreferenced).toBe(true);
});

test("glyphs of a skin's font prefix are not frames of the element with that name", () => {
  const skin = parseIni("[Fonts]\nHitCirclePrefix: hitcircle\n");
  const files = [
    "hitcircle.png",
    "hitcircle@2x.png",
    "hitcircle-1.png",
    "hitcircle-2@2x.png",
  ];
  const ref = { kind: "image" as const, name: "hitcircle" };
  expect(unitFiles(ref, files, fontPrefixes(skin))).toEqual([
    "hitcircle.png",
    "hitcircle@2x.png",
  ]);
  expect(unitFiles(ref, files, fontPrefixes(parseIni("")))).toEqual(files);
});
