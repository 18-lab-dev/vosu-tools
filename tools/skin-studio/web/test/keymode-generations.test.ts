import { expect, test } from "bun:test";
import { KeymodeGenerations } from "../src/keymode-generations";
import type { Recipe } from "../src/plan";

const text = "[General]\nVersion: 2.7\n[Mania]\nKeys: 4\nColumnWidth: 70,70,70,70\n[Mania]\nKeys: 7\nColumnWidth: 70,70,70,70,70,70,70\n";
const fixture = (): Recipe => ({ name: "Mix", base: "base", picks: {}, keymodes: {
  "4": { images: { KeyImage0: { value: "key" } }, values: {} },
  "7": { images: {}, values: {} },
} });

for (const action of ["clear", "undo", "reset", "base replacement", "source recovery", "stage replacement"])
  test(`${action} invalidates a pending transaction and redo cannot recreate its generation`, () => {
    const recipe = fixture(), before = structuredClone(recipe), generations = new KeymodeGenerations();
    const captured = generations.capture(4, recipe, "new", text);
    switch (action) {
      case "clear": recipe.keymodes!["4"].images.KeyImage0 = null; break;
      case "undo": delete recipe.keymodes!["4"]; break;
      case "reset": recipe.keymodes = {}; break;
      case "base replacement": recipe.base = "other"; break;
      case "source recovery": recipe.keymodes!["4"].images.KeyImage0 = { skin: "replacement", name: "key", files: [{ from: "key.png", suffix: ".png" }] }; break;
      case "stage replacement": recipe.picks["mania-keys-4"] = { kind: "skin", key: "replacement" }; break;
    }
    generations.observe(recipe, "new", text);
    expect(generations.capture(4, recipe, "new", text)).toBeGreaterThan(captured);
    Object.assign(recipe, before);
    generations.observe(recipe, "new", text);
    expect(generations.capture(4, recipe, "new", text)).toBeGreaterThan(captured);
  });

test("mutations of a different key count do not invalidate the captured count", () => {
  const recipe = fixture(), generations = new KeymodeGenerations();
  const four = generations.capture(4, recipe, "new", text), seven = generations.capture(7, recipe, "new", text);
  recipe.keymodes!["7"].values.ColumnWidth = Array(7).fill(60).join(",");
  recipe.picks["mania-keys-7"] = { kind: "skin", key: "seven" };
  const next = text.replace("70,70,70,70,70,70,70", "60,60,60,60,60,60,60");
  generations.observe(recipe, "new", next);
  expect(generations.capture(4, recipe, "new", next)).toBe(four);
  expect(generations.capture(7, recipe, "new", next)).toBeGreaterThan(seven);
});

test("hand-edited geometry and draft mode changes invalidate pending work", () => {
  const recipe = fixture(), generations = new KeymodeGenerations();
  const captured = generations.capture(4, recipe, "new", text);
  const edited = text.replace("70,70,70,70\n", "73,70,70,70\n");
  generations.observe(recipe, "new", edited);
  const changed = generations.capture(4, recipe, "new", edited);
  expect(changed).toBeGreaterThan(captured);
  generations.observe(recipe, "current", edited);
  expect(generations.capture(4, recipe, "current", edited)).toBeGreaterThan(changed);
});
