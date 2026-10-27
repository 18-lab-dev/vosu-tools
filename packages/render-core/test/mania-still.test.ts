import { expect, test } from "bun:test";
import {
  DEFAULT_SCROLL_LENGTH,
  MANIA_SCALE,
  maniaConfig,
  maniaLayout,
  maniaStillTimes,
  skinImageSize,
  type ImageSize,
} from "../src/mania";

// Receptors reaching above the hit line (like receptor circles), tall tails.
const sizes: Record<string, [number, number]> = {
  "mania-key1": [30, 200],
  "mania-key2": [30, 200],
  "mania-keyS": [30, 200],
  "mania-note1": [30, 12],
  "mania-note2": [30, 12],
  "mania-noteS": [30, 12],
  "mania-note1T": [30, 20],
  "mania-note2T": [30, 20],
  "mania-noteST": [30, 20],
};
const size: ImageSize = (name) => {
  const s = sizes[name];
  return s ? { width: s[0], height: s[1] } : undefined;
};

test("the still stage: note above the receptors, hold above the note, all on the stage", () => {
  for (const keys of [1, 4, 7, 10])
    for (const speed of [1, 8, 24, 40]) {
      const layout = maniaLayout(maniaConfig(undefined, keys), size);
      const t = maniaStillTimes(layout, speed);
      const perMs = (speed * DEFAULT_SCROLL_LENGTH * MANIA_SCALE) / 11485;
      const at = (time: number) => time * perMs; // distance above the hit line
      const column = layout.columns[0];
      const receptorTop = layout.hitY - column.key!.y;
      expect(receptorTop).toBeGreaterThan(0);
      expect(at(t.note)).toBeGreaterThan(receptorTop);
      expect(at(t.start)).toBeGreaterThan(at(t.note) + column.note!.height);
      expect(t.end).toBeGreaterThan(t.start);
      // The tail's top stays on the stage.
      expect(at(t.end) + column.tail!.height).toBeLessThanOrEqual(layout.hitY + 1e-9);
      // The same picture at every speed: distances do not depend on it.
      expect(at(t.note)).toBeCloseTo(maniaStillTimes(layout, 8).note * ((8 * DEFAULT_SCROLL_LENGTH * MANIA_SCALE) / 11485), 6);
    }
});

test("skin sizes are display sizes; a frame alias is not a plain image", () => {
  const bitmap = (width: number, height: number) => ({ width, height }) as ImageBitmap;
  const frame = bitmap(64, 128);
  const skin = {
    assets: new Map([
      ["key", bitmap(60, 200)],
      ["anim-0", frame],
      ["anim", frame],
    ]),
    pixelScale: new Map([
      ["key", 2],
      ["anim-0", 1],
      ["anim", 1],
    ]),
  };
  const s = skinImageSize(skin);
  expect(s("key", false)).toEqual({ width: 30, height: 100 });
  expect(s("anim", true)).toEqual({ width: 64, height: 128 });
  expect(s("anim", false)).toBeUndefined();
  expect(s("missing", true)).toBeUndefined();
});
