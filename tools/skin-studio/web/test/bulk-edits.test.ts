import { expect, test } from "bun:test";
import { changedSlots, columnRuns, defaultPattern, type Slot } from "../src/keymodes";

test("the 1/2/S pattern sets only the slots it changes", () => {
  // 7K: kinds 1 2 1 S 1 2 1. Columns 1, 3 and 5 already share an image; column 7 differs.
  const current = (key: string): Slot => {
    const column = Number(/\d+/.exec(key)![0]);
    if (key.startsWith("NoteImage") && /\d$/.test(key)) return { value: column === 6 ? "blue" : column % 2 ? "two" : "one" };
    return { value: key.replace(/\d+/, column === 1 || column === 5 ? "2" : column === 3 ? "S" : "1") };
  };
  const pattern = defaultPattern(7, current);
  expect(Object.keys(pattern).length).toBe(4 * 6);
  const changed = changedSlots(pattern, current);
  expect(changed).toEqual({ NoteImage6: { value: "one" } });
  expect(columnRuns(Object.keys(changed))).toBe("Column 7");
});

test("column runs read as ranges", () => {
  expect(columnRuns(["KeyImage2", "NoteImage3", "KeyImage4D", "NoteImage5H", "NoteImage6"])).toBe("Columns 3–7");
  expect(columnRuns(["KeyImage1", "KeyImage3", "KeyImage4", "KeyImage5"])).toBe("Columns 2, 4–6");
  expect(columnRuns(["KeyImage0", "KeyImage2"])).toBe("Columns 1, 3");
});
