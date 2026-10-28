import { expect, test } from "bun:test";
import { editKeymodeDraft, type KeymodeDraft } from "../src/keymodes";
import { compose, hasEdits, type Recipe } from "../src/plan";

for (const preference of ["keepProportions", "moveReceptors"] as const) {
  test(`${preference} roundtrip removes an inherited count instead of leaving dirty state`, () => {
    const changed = editKeymodeDraft(undefined, (draft) => { draft[preference] = false; });
    expect(changed?.[preference]).toBe(false);
    expect(hasEdits({ name: "Mix", base: null, picks: {}, keymodes: { "4": changed! } })).toBe(true);
    const restored = editKeymodeDraft(changed, (draft) => { delete draft[preference]; });
    expect(restored).toBeUndefined();
    expect(changed?.[preference]).toBe(false);
    expect(hasEdits({ name: "Mix", base: null, picks: {} })).toBe(false);
  });

  test(`${preference} roundtrip preserves an explicitly added empty stage`, () => {
    const before: KeymodeDraft = { images: {}, values: {}, added: true };
    const changed = editKeymodeDraft(before, (draft) => { draft[preference] = false; });
    const restored = editKeymodeDraft(changed, (draft) => { delete draft[preference]; });
    expect(restored).toEqual(before);
    const recipe: Recipe = { name: "Mix", base: null, picks: {}, keymodes: { "5": restored! } };
    expect(hasEdits(recipe)).toBe(true);
    expect(compose(recipe, new Map()).plan.ini).toContain("Keys: 5");
  });

  test(`${preference} roundtrip preserves a legacy unmarked empty stage`, () => {
    const before: KeymodeDraft = { images: {}, values: {} };
    const changed = editKeymodeDraft(before, (draft) => { draft[preference] = false; });
    const restored = editKeymodeDraft(changed, (draft) => { delete draft[preference]; });
    expect(before).toEqual({ images: {}, values: {} });
    expect(restored).toEqual({ images: {}, values: {}, added: true });
    const recipe: Recipe = { name: "Legacy add", base: null, picks: {}, keymodes: { "5": restored! } };
    expect(compose(recipe, new Map()).plan.ini).toContain("Keys: 5");
  });
}

test("preference cleanup preserves the other preference, explicit removals and geometry captures", () => {
  const other = editKeymodeDraft({ images: {}, values: {}, moveReceptors: false }, (draft) => { draft.keepProportions = true; });
  expect(other).toEqual({ images: {}, values: {}, moveReceptors: false });
  const removal = editKeymodeDraft({ images: { KeyImage0: null }, values: { HitPosition: null } }, () => {});
  expect(removal).toEqual({ images: { KeyImage0: null }, values: { HitPosition: null } });
  const captured: KeymodeDraft = { images: {}, values: {}, hit: { originals: {}, moved: 1 } };
  expect(editKeymodeDraft(captured, (draft) => { draft.moveReceptors = true; })).toEqual(captured);
});
