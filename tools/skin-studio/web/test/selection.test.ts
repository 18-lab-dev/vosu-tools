import { expect, test } from "bun:test";
import { EMPTY, all, extend, range, single, toggle, type Cell, type Shape } from "../src/selection";

// A 6-row × 7-column column grid (region 0), 4 value rows without slots,
// and a row of stage-wide images (region 1) at row 10.
const ROLES = ["KeyImage#", "KeyImage#D", "NoteImage#", "NoteImage#H", "NoteImage#L", "NoteImage#T"];
const STAGE = ["StageLeft", "StageRight", "StageHint"];
const shape: Shape = {
  keyAt: (r, c) =>
    r < ROLES.length && c >= 0 && c < 7
      ? ROLES[r].replace("#", String(c))
      : r === 10
        ? STAGE[c]
        : undefined,
  region: (r) => (r < ROLES.length ? 0 : r === 10 ? 1 : -1),
  cells: (region) =>
    region === 0
      ? ROLES.flatMap((_, r) => Array.from({ length: 7 }, (_, c) => [r, c] as Cell))
      : region === 1
        ? STAGE.map((_, c) => [10, c] as Cell)
        : [],
};

test("click selects one, Ctrl+click toggles", () => {
  let s = single(shape, [0, 2]);
  expect(s.keys).toEqual(["KeyImage2"]);
  s = toggle(s, shape, [2, 4]);
  s = toggle(s, shape, [3, 6]);
  expect(s.keys).toEqual(["KeyImage2", "NoteImage4", "NoteImage6H"]);
  s = toggle(s, shape, [0, 2]);
  expect(s.keys).toEqual(["NoteImage4", "NoteImage6H"]);
  expect(s.anchor).toEqual([0, 2]);
  // Value rows have no slot: nothing changes.
  expect(toggle(s, shape, [7, 1])).toBe(s);
  expect(single(shape, [7, 1])).toBe(EMPTY);
});

test("Shift+click selects the rectangle from the anchor", () => {
  const s = range(single(shape, [0, 1]), shape, [2, 3]);
  expect(s.keys.sort()).toEqual(
    ["KeyImage1", "KeyImage2", "KeyImage3", "KeyImage1D", "KeyImage2D", "KeyImage3D", "NoteImage1", "NoteImage2", "NoteImage3"].sort(),
  );
  expect(s.anchor).toEqual([0, 1]);
  // Backwards from the same anchor replaces the range.
  expect(range(s, shape, [0, 0]).keys).toEqual(["KeyImage0", "KeyImage1"]);
  // Across regions: just the clicked slot.
  expect(range(s, shape, [10, 1]).keys).toEqual(["StageRight"]);
});

test("Shift+arrows extend from the anchor and stay in the region", () => {
  let s = single(shape, [0, 5]);
  s = extend(s, shape, [0, 1]);
  expect(s.keys).toEqual(["KeyImage5", "KeyImage6"]);
  s = extend(s, shape, [0, 1]); // clamped at the last column
  expect(s.keys).toEqual(["KeyImage5", "KeyImage6"]);
  s = extend(s, shape, [1, 0]);
  expect(s.keys.sort()).toEqual(["KeyImage5", "KeyImage5D", "KeyImage6", "KeyImage6D"].sort());
  expect(s.focus).toEqual([1, 6]);
  // The far corner moves back past the anchor.
  s = extend(extend(s, shape, [0, -1]), shape, [0, -1]);
  expect(s.keys.sort()).toEqual(["KeyImage4", "KeyImage4D", "KeyImage5", "KeyImage5D"].sort());
  s = extend(single(shape, [10, 0]), shape, [1, 1]);
  expect(s.keys).toEqual(["StageLeft", "StageRight"]);
});

test("Ctrl+A selects the whole region", () => {
  expect(all(shape, [3, 3]).keys).toHaveLength(42);
  expect(all(shape, [10, 2]).keys).toEqual(STAGE);
});
