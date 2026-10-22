import { expect, test } from "bun:test";
import { parseSize, ratioOf, sizeProblem } from "../src/sizes";

test("sizes follow the service's encoder limits", () => {
  expect(parseSize("1920x1080")).toEqual({ width: 1920, height: 1080 });
  expect(parseSize(" 1080 × 1920 ")).toEqual({ width: 1080, height: 1920 });
  expect(parseSize("4320x7680")).toEqual({ width: 4320, height: 7680 });
  for (const bad of ["1921x1080", "62x64", "7682x100", "7680x7680", "1920", "", null])
    expect(parseSize(bad)).toBeNull();
  expect(sizeProblem(1921, 1080)).toContain("even");
  expect(sizeProblem(7680, 7680)).toContain("7680 × 4320");
  expect(sizeProblem(1920.5, 1080)).toContain("whole");
});

test("ratios use common names, else the reduced fraction", () => {
  expect(ratioOf({ width: 3440, height: 1440 })).toBe("21:9");
  expect(ratioOf({ width: 2560, height: 1080 })).toBe("21:9");
  expect(ratioOf({ width: 5120, height: 1440 })).toBe("32:9");
  expect(ratioOf({ width: 1080, height: 1920 })).toBe("9:16");
  expect(ratioOf({ width: 1440, height: 1080 })).toBe("4:3");
  expect(ratioOf({ width: 2000, height: 1000 })).toBe("2:1");
  expect(ratioOf({ width: 1280, height: 1024 })).toBe("5:4");
});
