import { expect, test } from "bun:test";
import { plural } from "../src/plural";

test("one of a thing is singular, every other count plural", () => {
  expect(plural(1, "image")).toBe("1 image");
  expect(plural(0, "image")).toBe("0 images");
  expect(plural(2, "value")).toBe("2 values");
  expect(plural(1, "very late release")).toBe("1 very late release");
  expect(plural(3, "press", "presses")).toBe("3 presses");
});
