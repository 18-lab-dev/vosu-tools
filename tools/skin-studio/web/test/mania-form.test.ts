import { expect, test } from "bun:test";
import { spec } from "@vosu-tools/skin-spec";
import { ELSEWHERE, MANIA_COLUMNS, MANIA_FIELDS, columnKey, setListEntry, uncovered } from "../src/mania-form";
import { compose, type SkinData } from "../src/plan";

test("every [Mania] key of the schema has a control on the Keymodes screen", () => {
  expect(uncovered()).toEqual([]);
  const here = new Set([...MANIA_FIELDS.map((f) => f.key), ...MANIA_COLUMNS.map((f) => f.key)]);
  for (const s of spec.filter((s) => s.section === "Mania"))
    expect(here.has(s.key) || s.key in ELSEWHERE || s.type === "image").toBe(true);
  // Nothing twice: fields edited elsewhere are not in the form.
  for (const key of Object.keys(ELSEWHERE)) expect(here.has(key)).toBe(false);
});

test("controls follow the schema's types and defaults", () => {
  const field = (key: string) => MANIA_FIELDS.find((f) => f.key === key)!;
  expect(field("ColumnStart")).toMatchObject({ control: "number", fallback: "136", group: "Stage" });
  expect(field("LightPosition")).toMatchObject({ control: "integer", fallback: "413" });
  expect(field("KeysUnderNotes")).toMatchObject({ control: "switch", fallback: "0" });
  expect(field("SpecialStyle").options).toEqual([
    { value: "0", label: "None" }, { value: "1", label: "Left" }, { value: "2", label: "Right" },
  ]);
  expect(field("ColourHold")).toMatchObject({ control: "colour", alpha: true, fallback: "255,191,51,255", group: "Colours" });
  expect(field("ColourBreak")).toMatchObject({ control: "colour", alpha: false });
  const column = (key: string) => MANIA_COLUMNS.find((f) => f.key === key)!;
  expect(column("ColumnSpacing").length(7)).toBe(6);
  expect(column("LightingNWidth").length(7)).toBe(7);
  expect(column("NoteBodyStyle#").control).toBe("select");
  expect(columnKey(column("KeyFlipWhenUpsideDown#D"), 3)).toBe("KeyFlipWhenUpsideDown3D");
});

test("one entry of a comma list changes; the others keep their place", () => {
  expect(setListEntry(undefined, 3, 1, "5", () => "0")).toBe("0,5,0");
  expect(setListEntry("1,2", 4, 3, "9", (i) => String(10 + i))).toBe("1,2,12,9");
  expect(setListEntry("1, 2 ,3", 3, 1, null, () => "0")).toBe("1,0,3");
  expect(setListEntry("60,60,60", 3, 0, "75", () => "30")).toBe("75,60,60");
});

test("form values go through the draft without touching other lines", () => {
  const text = [
    "// header comment",
    "[General]",
    "Name: A",
    "[Mania]",
    "Keys: 4",
    "// our 4K",
    "ColumnWidth: 40,40,40,40",
    "Unknown: kept verbatim",
    "NoteBodyStyle: 1",
    "",
    "[Mania]",
    "Keys: 7",
    "Foo: bar",
    "",
  ].join("\r\n");
  const base: SkinData = { key: "/Skins/A", name: "A", text, files: ["skin.ini"] };
  const { plan } = compose(
    {
      name: "",
      base: base.key,
      picks: {},
      inPlace: true,
      keymodes: { "4": { images: {}, values: { ColumnSpacing: "1,2,3", NoteBodyStyle2: "0", ColourHold: "1,2,3,4", NoteBodyStyle: null } } },
    },
    new Map([[base.key, base]]),
  );
  const lines = plan.ini.split("\r\n");
  // Every line ends in CRLF, comments and unknown keys stay where they were.
  expect(plan.ini.replace(/\r\n/g, "")).not.toContain("\n");
  expect(lines.slice(0, 8)).toEqual(["// header comment", "[General]", "Name: A", "[Mania]", "Keys: 4", "// our 4K", "ColumnWidth: 40,40,40,40", "Unknown: kept verbatim"]);
  expect(lines).toContain("ColumnSpacing: 1,2,3");
  expect(lines).toContain("NoteBodyStyle2: 0");
  expect(lines).toContain("ColourHold: 1,2,3,4");
  expect(lines).not.toContain("NoteBodyStyle: 1");
  // The 7K block is untouched.
  expect(plan.ini).toContain("[Mania]\r\nKeys: 7\r\nFoo: bar");
});
