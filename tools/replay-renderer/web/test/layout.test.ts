import { expect, test } from "bun:test";
import {
  VIEW,
  contentBounds,
  fitScale,
  guidesFor,
  place,
  resizeBox,
  snapMove,
  transformFor,
} from "../src/layout";

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);
// A 4-key mania stage: full 480-unit height, narrow and centred on x = 256.
const stage = { x: 256 - 90, y: -48, width: 180, height: 480 };
// Side-by-side cells of a 1920×1080 frame with an 8 px gap.
const cell = { x: 0, y: 0, width: 956, height: 1080 };

test("a mania stage fills the cell height in a narrow cell", () => {
  const { box, target, draw } = place(cell, stage, { x: 0, y: 0, scale: 1 });
  close(box.height, 1080);
  close(box.y, 0);
  close(box.x + box.width / 2, 478);
  // The renderer fits 640×480 by height, so the target is 4:3 at that scale.
  expect(target).toEqual({ width: 1440, height: 1080 });
  // World x = 256 (stage centre) lands on the cell centre.
  close(draw.x + draw.width / 2, 478);
  close(draw.height, 1080);
});

test("osu! fills the height of a wide cell and the width of a narrow one", () => {
  const wide = place({ x: 0, y: 0, width: 1920, height: 1080 }, VIEW, { x: 0, y: 0, scale: 1 });
  close(wide.box.height, 1080);
  close(wide.box.width, 1440);
  close(wide.box.x, 240);
  const narrow = place(cell, VIEW, { x: 0, y: 0, scale: 1 });
  close(narrow.box.width, 956);
  close(narrow.box.height, 717);
  close(narrow.box.y, (1080 - 717) / 2);
});

test("a taiko strip is width-limited", () => {
  const strip = { x: -64, y: 69, width: 640, height: 132 };
  close(fitScale({ x: 0, y: 0, width: 1920, height: 540 }, strip), 3);
});

test("transforms offset by cell fractions and scale about the centre", () => {
  const { box } = place(cell, stage, { x: 0.25, y: -0.1, scale: 0.5 });
  close(box.height, 540);
  close(box.x + box.width / 2, 478 + 239);
  close(box.y + box.height / 2, 540 - 108);
});

test("transformFor inverts place", () => {
  for (const t of [
    { x: 0, y: 0, scale: 1 },
    { x: -0.3, y: 0.42, scale: 1.37 },
    { x: 1.5, y: -2, scale: 0.25 },
  ]) {
    const back = transformFor(cell, stage, place(cell, stage, t).box);
    close(back.x, t.x);
    close(back.y, t.y);
    close(back.scale, t.scale);
  }
});

test("a target rendered for another scale is drawn resampled onto the same box", () => {
  const live = place(cell, stage, { x: 0.1, y: 0, scale: 1.5 }, { width: 1440, height: 1080 });
  const exact = place(cell, stage, { x: 0.1, y: 0, scale: 1.5 });
  close(live.draw.x, exact.draw.x, 4);
  close(live.draw.width, exact.draw.width, 4);
  expect(live.box).toEqual(exact.box);
});

test("render targets never exceed the texture limit", () => {
  const { target } = place({ x: 0, y: 0, width: 7680, height: 7680 }, stage, { x: 0, y: 0, scale: 2 });
  expect(Math.max(target.width, target.height)).toBeLessThanOrEqual(8192);
});

test("contentBounds measures drawn pixels in world units", () => {
  const width = 640,
    height = 480,
    pixels = new Uint8Array(width * height * 4);
  for (let y = 10; y < 470; y++) for (let x = 230; x < 410; x++) pixels[(y * width + x) * 4 + 3] = 255;
  expect(contentBounds(pixels, width, height)).toEqual({ x: 166, y: -38, width: 180, height: 460 });
  expect(contentBounds(new Uint8Array(width * height * 4), width, height)).toEqual(VIEW);
});

test("moves snap edges and centres to the canvas and cells", () => {
  const guides = guidesFor({ x: 0, y: 0, width: 1920, height: 1080 }, [cell]);
  const moved = snapMove({ x: 473, y: 5, width: 10, height: 100 }, guides, 8);
  // The centre (478) meets the cell centre; the top meets the canvas edge.
  expect(moved.box.x).toBe(473);
  expect(moved.box.y).toBe(0);
  expect(moved.lines).toEqual({ x: 478, y: 0 });
  const free = snapMove({ x: 300, y: 300, width: 10, height: 10 }, guides, 8);
  expect(free.lines).toEqual({ x: null, y: null });
});

test("corner resizes keep the opposite corner and the aspect ratio", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  const { box } = resizeBox(start, "se", { x: 500, y: 150 }, { aspect: 2 });
  expect(box).toEqual({ x: 100, y: 100, width: 400, height: 200 });
  const nw = resizeBox(start, "nw", { x: 250, y: 50 }, {}).box;
  expect(nw).toEqual({ x: 250, y: 50, width: 50, height: 150 });
});
