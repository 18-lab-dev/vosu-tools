import { expect, test } from "bun:test";
import { groupChoice, pickLabel, provenance, useButtonLabel } from "../src/draft-labels";
import { assignGroupPick, type Recipe, type Plan } from "../src/plan";
import { groupOf } from "../src/assets";
import { parseIni } from "../src/ini";

const name = (key: string) => key.toUpperCase();
const ref = { kind: "image" as const, name: "hitcircle" };
const draft = (): Recipe => ({ name: "Test", base: "base", picks: {} });
const plan = (skin = "base"): Plan => ({ name: "Test", overwrite: false, ini: "", sources: [{ skin, files: ["hitcircle.png"] }], blanks: [], texts: [] });

test("provenance distinguishes Base, Group, Override and Not included", () => {
  const recipe = draft();
  expect(provenance(ref, recipe, plan(), name)).toEqual({ label: "Base · BASE", included: true });
  recipe.picks[groupOf(ref, parseIni(""))] = { kind: "skin", key: "group" };
  expect(provenance(ref, recipe, plan("group"), name)).toEqual({ label: "Group · GROUP", included: true });
  recipe.overrides = { "image:hitcircle": { skin: "override", ref } };
  expect(provenance(ref, recipe, plan("group"), name)).toEqual({ label: "Override · OVERRIDE", included: true });
  expect(provenance(ref, draft(), null, name)).toEqual({ label: "Not included", included: false });
});

test("Use label counts complete asset files, including selection and override states", () => {
  expect(useButtonLabel(1, 1, false, false)).toBe("Use asset · 1 file");
  expect(useButtonLabel(1, 12, false, false)).toBe("Use asset · 12 files");
  expect(useButtonLabel(2, 14, false, false)).toBe("Use 2 assets · 14 files");
  expect(useButtonLabel(1, 1, false, true)).toBe("Override with this · 1 file");
  expect(useButtonLabel(2, 14, false, true)).toBe("Override with this · 14 files");
  expect(useButtonLabel(2, 14, true, true)).toBe("Remove from mix");
  expect(useButtonLabel(0, 0, false, false)).toBe("Use asset · 0 files");
});

test("pickLabel names explicit picks and base inheritance", () => {
  const recipe = draft();
  expect(pickLabel(undefined, recipe, name)).toBe("base · BASE");
  expect(pickLabel({ kind: "skin", key: "group" }, recipe, name)).toBe("GROUP");
  expect(pickLabel({ kind: "default" }, recipe, name)).toBe("built-in");
  expect(pickLabel({ kind: "blank" }, recipe, name)).toBe("blank");
  recipe.base = null;
  expect(pickLabel(undefined, recipe, name)).toBe("built-in");
});

test("Built-in selects default; toggling or × removes the pick and inherits base", () => {
  const recipe = draft();
  const group = groupOf(ref, parseIni(""));
  assignGroupPick(recipe, group, groupChoice(false, { kind: "default" }));
  expect(recipe.picks[group]).toEqual({ kind: "default" });
  assignGroupPick(recipe, group, groupChoice(true, { kind: "default" }));
  expect(Object.hasOwn(recipe.picks, group)).toBe(false);
  assignGroupPick(recipe, group, { kind: "skin", key: "group" });
  assignGroupPick(recipe, group, null); // × Reset to the base
  expect(Object.hasOwn(recipe.picks, group)).toBe(false);
  expect(pickLabel(recipe.picks[group], recipe, name)).toBe("base · BASE");
  expect(provenance(ref, recipe, plan(), name).label).toBe("Base · BASE");
});
