import { expect, test } from "bun:test";
import { NONE, all, columnsText, extend, isSelected, range, single, targets, toggle } from "../src/value-selection";

test("Ctrl+click toggles columns of one row; another row starts over", () => {
  let s = single("ColumnWidth", 0);
  s = toggle(s, "ColumnWidth", 2);
  s = toggle(s, "ColumnWidth", 4);
  expect(s.cols).toEqual([0, 2, 4]);
  expect(toggle(s, "ColumnWidth", 2).cols).toEqual([0, 4]);
  // A selection never spans rows: a width and a colour are different values.
  expect(toggle(s, "Colour", 1)).toEqual({ row: "Colour", cols: [1], anchor: 1 });
});

test("Shift+click selects the run from the anchor; Shift+arrows grow it", () => {
  const s = range(single("Colour", 2), "Colour", 5);
  expect(s.cols).toEqual([2, 3, 4, 5]);
  expect(range(s, "Colour", 0).cols).toEqual([0, 1, 2]);
  expect(range(NONE, "Colour", 3).cols).toEqual([3]);
  expect(extend(single("Colour", 2), "Colour", 2, 1, 7).cols).toEqual([2, 3]);
  expect(extend(range(single("Colour", 2), "Colour", 3), "Colour", 3, 1, 7).cols).toEqual([2, 3, 4]);
  // Clamped to the row.
  expect(extend(single("Colour", 6), "Colour", 6, 1, 7).cols).toEqual([6]);
});

test("Ctrl+A takes the row; an edit sets the selection only when the cell is in it", () => {
  expect(all("KeyFlipWhenUpsideDown#", 4).cols).toEqual([0, 1, 2, 3]);
  const s = toggle(toggle(single("ColumnWidth", 4), "ColumnWidth", 0), "ColumnWidth", 2);
  expect(targets(s, "ColumnWidth", 2)).toEqual([0, 2, 4]);
  expect(targets(s, "ColumnWidth", 3)).toEqual([3]);
  expect(targets(s, "ColumnLineWidth", 2)).toEqual([2]);
  expect(isSelected(s, "ColumnWidth", 4)).toBe(true);
  expect(isSelected(s, "Colour", 4)).toBe(false);
  expect(columnsText([4, 0, 2])).toBe("columns 1, 3 and 5");
  expect(columnsText([6])).toBe("column 7");
});
