import { expect, test } from "bun:test";
import { nameParts, roleOrder } from "../src/picker";

test("picker names keep their distinguishing end", () => {
  expect(nameParts("mania-note2T")).toEqual(["mania-", "note2T"]);
  expect(nameParts("mania/7k/mania-key1D")).toEqual(["mania/7k/mania-", "key1D"]);
  expect(nameParts("approachcircle")).toEqual(["approach", "circle"]);
  expect(nameParts("drop-note.png")).toEqual(["drop-", "note.png"]);
  expect(nameParts("lnt")).toEqual(["", "lnt"]);
  // Three mania notes no longer share one visible prefix.
  const tails = ["mania-note1", "mania-note2", "mania-noteS"].map((n) => nameParts(n)[1]);
  expect(new Set(tails).size).toBe(3);
});

test("note and hold roles rank osu!mania names before osu!-standard circles", () => {
  const names = ["approachcircle", "hitcircle", "hitcircleoverlay", "mania-note1", "mania-note2", "mania-noteS", "Notes/blue"];
  const sorted = (pattern: string) => [...names].sort((a, b) => roleOrder(pattern, a) - roleOrder(pattern, b));
  expect(sorted("NoteImage#")).toEqual(["mania-note1", "mania-note2", "mania-noteS", "Notes/blue", "approachcircle", "hitcircle", "hitcircleoverlay"]);
  expect(roleOrder("NoteImage#H", "mania-note1H")).toBe(0);
  expect(roleOrder("NoteImage#H", "mania-note1")).toBe(1);
  expect(roleOrder("NoteImage#H", "hitcircle")).toBe(2);
  expect(roleOrder("NoteImage#T", "mania-noteST")).toBe(0);
  expect(roleOrder("KeyImage#D", "mania-key2D")).toBe(0);
  expect(roleOrder("KeyImage#", "receptor")).toBe(1);
  // Stage-wide roles keep name order.
  expect(roleOrder("StageLeft", "hitcircle")).toBe(0);
});
