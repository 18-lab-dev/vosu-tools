import { expect, test } from "bun:test";
import {
  PLAYFIELD_DEFAULTS,
  playfieldOptions,
  playfieldSize,
} from "../src/playfield";

test("canvases are drawn at the screen's pixels, supersampled up to 1920", () => {
  // A 1080p screen at its pixels: unchanged.
  expect(playfieldSize(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
  // A smaller panel is drawn at 1920 wide (as Replay renderer's preview).
  expect(playfieldSize(1280, 720, 1)).toEqual({ width: 1920, height: 1080 });
  // At most 2× each way.
  expect(playfieldSize(640, 360, 1)).toEqual({ width: 1280, height: 720 });
  // HiDPI: the pixel ratio counts, capped at 2.
  expect(playfieldSize(1280, 720, 2)).toEqual({ width: 2560, height: 1440 });
  expect(playfieldSize(1280, 720, 3)).toEqual({ width: 2560, height: 1440 });
  // Never beyond WebGPU's guaranteed texture size.
  expect(playfieldSize(5000, 1000, 2).width).toBe(8192);
  // Fractional ratios and empty panels stay valid.
  expect(playfieldSize(0, 0, 1.25)).toEqual({ width: 2, height: 2 });
});

test("tool options override lazer's defaults, undefined ones do not", () => {
  expect(playfieldOptions()).toEqual({ ...PLAYFIELD_DEFAULTS });
  expect(
    playfieldOptions({ comboColourNormalisation: undefined, scrollSpeed: 16 }),
  ).toEqual({ ...PLAYFIELD_DEFAULTS, scrollSpeed: 16 });
  // A stable client turns normalisation off.
  expect(
    playfieldOptions({ comboColourNormalisation: 0 }).comboColourNormalisation,
  ).toBe(0);
  expect(playfieldOptions({ playfieldShift: false }).playfieldShift).toBe(
    false,
  );
});
