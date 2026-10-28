import { expect, test } from "bun:test";
import { mergeDraftIni } from "../src/draft-ini";
import { KeymodeGenerations } from "../src/keymode-generations";
import type { Recipe } from "../src/plan";

const original = "[General]\r\nName: Mix\r\nAuthor: Source\r\n[Mania]\r\nKeys: 7\r\nNoteImage0: old/note\r\nHitPosition: 400\r\n[Mania]\r\nKeys: 4\r\nNoteImage0: other\r\n";
const next = original.replace("old/note", "mania/7k/note").replace("HitPosition: 400", "HitPosition: 420");
const manual = "\uFEFF// retain me\r\n" + original.replace("Author: Source", "Author: Manual").replace("HitPosition: 400", "HitPosition: 399 // keep inline");

test("background composition updates untouched image keys without resetting hand overrides", () => {
  const text = mergeDraftIni(manual, original, next);
  expect(text).toBe(manual.replace("old/note", "mania/7k/note"));
});

test("a late first base composition cannot replace values typed after choosing the base", () => {
  const previous = "[General]\nName: Mix\nAuthor:\n";
  const fresh = "[General]\nName: Mix\nAuthor: Source\n[Mania]\nKeys: 4\nNoteImage0: note\n";
  const hand = "// retain\n" + fresh.replace("Author: Source", "Author: My hand edit");
  expect(mergeDraftIni(hand, previous, fresh)).toBe(hand);
});

test("late base publication cannot inflate a hand-replaced document with untouched source sections", () => {
  const before = "[General]\nName: Mix\nAuthor:\n";
  const hand = "[Mania]\nKeys: 4\nNoteImage0: user/note\n";
  expect(mergeDraftIni(hand, before, original)).toBe(hand);
});

test("an explicit draft rename still owns General.Name", () => {
  const before: Recipe = { name: "Mix", base: "a", picks: {} };
  const after: Recipe = { ...before, name: "Renamed" };
  const hand = original.replace("Name: Mix", "Name: Hand name");
  expect(mergeDraftIni(hand, original, original.replace("Name: Mix", "Name: Renamed"), before, after)).toBe(hand.replace("Name: Hand name", "Name: Renamed"));
});

test("an explicit group pick owns its values even if its source matches the old composition", () => {
  const before: Recipe = { name: "Mix", base: "a", picks: {} };
  const after: Recipe = { ...before, picks: { "mania-keys-7": { kind: "skin", key: "b" } } };
  const text = mergeDraftIni(manual, original, original, before, after);
  expect(text).toContain("HitPosition: 400 // keep inline");
  expect(text).toContain("Author: Manual");
  expect(text).toContain("Keys: 4\r\nNoteImage0: other");
});

test("single-asset naming keys and accepted carry keys merge while unrelated manual values survive", () => {
  const before = "[Fonts]\nScorePrefix: old\nScoreOverlap: 4\nComboOverlap: 2\n";
  const edited = before.replace("ComboOverlap: 2", "ComboOverlap: 8 // manual") + "// last line";
  const next = before.replace("ScorePrefix: old", "ScorePrefix: numbers/new").replace("ScoreOverlap: 4", "ScoreOverlap: 6");
  expect(mergeDraftIni(edited, before, next)).toBe(edited.replace("ScorePrefix: old", "ScorePrefix: numbers/new").replace("ScoreOverlap: 4", "ScoreOverlap: 6"));
});

test("a same-named font pick still repairs manually changed naming and accepted overlap", () => {
  const source = "[Fonts]\nComboPrefix: default\nComboOverlap: 7\nScoreOverlap: 9\n";
  const edited = source.replace("ComboPrefix: default", "ComboPrefix: custom").replace("ComboOverlap: 7", "ComboOverlap: 99");
  const before: Recipe = { name: "Mix", base: "a", picks: {} };
  const after: Recipe = { ...before, overrides: { "font:default": { skin: "b", carry: ["overlap"] } } };
  expect(mergeDraftIni(edited, source, source, before, after)).toBe(source);
});

test("adding/removing a composed Mania stage does not leave an unkeyed section or duplicate Keys", () => {
  const base = "[General]\nName: Mix\n";
  const stage = base + "[Mania]\nKeys: 7\nNoteImage0: new/note\n";
  const added = mergeDraftIni(base, base, stage);
  expect(added.match(/Keys: 7/g)).toHaveLength(1);
  expect(mergeDraftIni(added, stage, base)).not.toContain("[Mania]");
});

test("the draft-wide clock invalidates ABA edits, text, and edits outside a key count", () => {
  const clock = new KeymodeGenerations();
  const recipe: Recipe = { name: "Mix", base: "a", picks: {} };
  const first = clock.captureDraft(recipe, "draft", original);
  recipe.name = "Other"; clock.observe(recipe, "draft", original);
  recipe.name = "Mix"; clock.observe(recipe, "draft", original);
  expect(clock.captureDraft(recipe, "draft", original)).toBeGreaterThan(first);
  const second = clock.captureDraft(recipe, "draft", original);
  clock.observe(recipe, "draft", manual);
  expect(clock.captureDraft(recipe, "draft", manual)).toBeGreaterThan(second);
  const third = clock.captureDraft(recipe, "draft", manual);
  recipe.sourceInfo = { a: { name: "metadata only" } };
  expect(clock.captureDraft(recipe, "draft", manual)).toBe(third);
});
