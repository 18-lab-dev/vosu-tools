import { expect, test } from "bun:test";
import { maniaValue } from "@vosu-tools/skin-spec";
import { compose, inPlaceRemovals, type Recipe, type SkinData } from "../src/plan";

const ini = (lines: string[]) => [...lines, ""].join("\r\n");
const other: SkinData = {
  key: "/Skins/Other",
  name: "Other",
  text: ini(["[General]", "Name: Other"]),
  files: ["skin.ini", "circle.png", "circle@2x.png"],
};
const circle = { skin: other.key, name: "circle", files: [{ from: "circle.png", suffix: ".png" }, { from: "circle@2x.png", suffix: "@2x.png" }] };
const inPlace = (base: SkinData, keymodes: Recipe["keymodes"]): Recipe => ({ name: "", base: base.key, picks: {}, inPlace: true, keymodes });
const outputs = (plan: ReturnType<typeof compose>["plan"]) =>
  plan.sources.flatMap((s) => s.files.map((f) => (typeof f === "string" ? `${s.skin}:${f}` : `${s.skin}:${f[0]}->${f[1]}`)));
const manifest = (plan: ReturnType<typeof compose>["plan"], keys: number) =>
  JSON.parse(plan.texts.find((t) => t.to === `mania/${keys}k/.skin-studio.json`)?.text ?? "null");

test("images made for a key count go to mania/<N>k with an ownership manifest", () => {
  const base: SkinData = { key: "/Skins/A", name: "A", text: ini(["[General]", "Name: A", "[Mania]", "Keys: 7"]), files: ["skin.ini"] };
  const { plan } = compose(inPlace(base, { "7": { images: { KeyImage0: circle }, values: {} } }), new Map([[base.key, base], [other.key, other]]));
  expect(maniaValue(plan.ini, 7, "KeyImage0")).toBe("mania/7k/circle");
  expect(outputs(plan)).toEqual(["/Skins/Other:circle.png->mania/7k/circle.png", "/Skins/Other:circle@2x.png->mania/7k/circle@2x.png"]);
  expect(manifest(plan, 7).files).toEqual(["circle.png", "circle@2x.png"]);
});

test("a file the skin already has in mania/7k is never replaced", () => {
  const base: SkinData = {
    key: "/Skins/A",
    name: "A",
    text: ini(["[General]", "Name: A", "[Mania]", "Keys: 7", "NoteImage0: mania/7k/circle"]),
    files: ["skin.ini", "mania/7k/circle.png"],
  };
  const { plan } = compose(inPlace(base, { "7": { images: { KeyImage0: circle }, values: {} } }), new Map([[base.key, base], [other.key, other]]));
  expect(maniaValue(plan.ini, 7, "KeyImage0")).toBe("mania/7k/circle (2)");
  expect(maniaValue(plan.ini, 7, "NoteImage0")).toBe("mania/7k/circle");
  expect(outputs(plan)).toContain("/Skins/A:mania/7k/circle.png");
  // The skin's own file is not Skin studio's: not listed, never removed.
  expect(manifest(plan, 7).files).toEqual(["circle (2).png", "circle (2)@2x.png"]);
  expect(inPlaceRemovals(plan, base)).toEqual([]);
});

test("a re-apply replaces only Skin studio's files: unused ones go, foreign ones stay", () => {
  const base: SkinData = {
    key: "/Skins/A",
    name: "A",
    text: ini(["[General]", "Name: A", "[Mania]", "Keys: 7", "KeyImage0: mania/7k/circle", "KeyImage1: mania/7k/kept", "NoteImage0: mania/7k/theirs"]),
    files: ["skin.ini", "mania/7k/circle.png", "mania/7k/kept.png", "mania/7k/theirs.png", "mania/7k/unused-theirs.png", "mania/7k/.skin-studio.json"],
    owned: ["mania/7k/circle.png", "mania/7k/kept.png"],
  };
  // KeyImage0 now uses another image: Skin studio's old copy is unused.
  const { plan } = compose(inPlace(base, { "7": { images: { KeyImage0: { value: "mania/7k/theirs" } }, values: {} } }), new Map([[base.key, base]]));
  expect(inPlaceRemovals(plan, base)).toEqual(["mania/7k/circle.png"]);
  expect(manifest(plan, 7).files).toEqual(["kept.png"]);
  // The skin's own unused file stays.
  expect(outputs(plan)).toContain("/Skins/A:mania/7k/unused-theirs.png");
});

test("earlier skin-studio/<N>k copies move to mania/<N>k; only Skin studio's go", () => {
  const base: SkinData = {
    key: "/Skins/A",
    name: "A",
    text: ini(["[General]", "Name: A", "[Mania]", "Keys: 4", "KeyImage0: skin-studio/4k/key", "KeyImage1: skin-studio/4k/key"]),
    files: ["skin.ini", "skin-studio/4k/key.png", "skin-studio/4k/key@2x.png", "skin-studio/4k/stale.png", "skin-studio-credits.txt"],
    owned: ["skin-studio/4k/key.png", "skin-studio/4k/key@2x.png", "skin-studio/4k/stale.png"],
  };
  const { plan } = compose(inPlace(base, {}), new Map([[base.key, base]]));
  expect(maniaValue(plan.ini, 4, "KeyImage0")).toBe("mania/4k/key");
  expect(maniaValue(plan.ini, 4, "KeyImage1")).toBe("mania/4k/key");
  expect(outputs(plan).sort()).toEqual([
    "/Skins/A:skin-studio/4k/key.png->mania/4k/key.png",
    "/Skins/A:skin-studio/4k/key@2x.png->mania/4k/key@2x.png",
  ]);
  expect(manifest(plan, 4).files).toEqual(["key.png", "key@2x.png"]);
  expect(inPlaceRemovals(plan, base).sort()).toEqual(["skin-studio/4k/key.png", "skin-studio/4k/key@2x.png", "skin-studio/4k/stale.png"]);
});

test("columns sharing a default image share one copy in mania/<N>k", () => {
  const base: SkinData = { key: "/Skins/A", name: "A", text: ini(["[General]", "Name: A"]), files: ["skin.ini", "mania/7k/mania-key2.png"] };
  const source: SkinData = {
    key: "/Skins/B",
    name: "B",
    text: ini(["[General]", "Name: B", "[Mania]", "Keys: 7"]),
    files: ["skin.ini", "mania-key1.png", "mania-key2.png", "mania-keyS.png"],
  };
  const { plan } = compose(
    { name: "", base: base.key, picks: { "mania-keys-7": { kind: "skin", key: source.key } }, inPlace: true },
    new Map([[base.key, base], [source.key, source]]),
  );
  expect(maniaValue(plan.ini, 7, "KeyImage0")).toBe("mania/7k/mania-key1");
  expect(maniaValue(plan.ini, 7, "KeyImage6")).toBe("mania/7k/mania-key1");
  // The skin's own mania/7k/mania-key2.png is never replaced.
  expect(maniaValue(plan.ini, 7, "KeyImage1")).toBe("mania/7k/mania-key2 (2)");
  expect(outputs(plan).filter((o) => o.startsWith("/Skins/B:")).sort()).toEqual([
    "/Skins/B:mania-key1.png->mania/7k/mania-key1.png",
    "/Skins/B:mania-key2.png->mania/7k/mania-key2 (2).png",
    "/Skins/B:mania-keyS.png->mania/7k/mania-keyS.png",
  ]);
});
