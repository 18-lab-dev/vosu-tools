import { expect, test } from "bun:test";
import {
  ATLAS_PADDING,
  STRIP_GUTTER,
  planAtlas,
  stripWindow,
  type AtlasPlan,
} from "../src/atlas";
import { parseSkinIni } from "@vosu-tools/osu-parse";
import { regionInstances, wrappedImages, type AtlasRegion } from "../src/skin";

const limits = { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };

/** Pieces (with gutters and padding) never overlap and stay inside their page. */
function expectDisjoint(plan: AtlasPlan) {
  const boxes = [...plan.placements.values()].flatMap((p) =>
    p.pieces.map((piece) => ({
      page: piece.page,
      x0: piece.x - ATLAS_PADDING,
      x1: piece.x + piece.width + ATLAS_PADDING,
      y0: piece.y - piece.gutterTop - ATLAS_PADDING,
      y1: piece.y + piece.height + piece.gutterBottom + ATLAS_PADDING,
    })),
  );
  for (const box of boxes) {
    expect(box.x0).toBeGreaterThanOrEqual(0);
    expect(box.y0).toBeGreaterThanOrEqual(0);
    expect(box.x1).toBeLessThanOrEqual(plan.pageWidth);
    expect(box.y1).toBeLessThanOrEqual(plan.pageHeight);
    expect(box.page).toBeLessThan(plan.pages);
  }
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1))
      if (a.page === b.page)
        expect(
          a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0,
        ).toBe(true);
}

test("tall images are cut into full-resolution strips", () => {
  // GAME OVER's hold body: 138 × 39950 pixels.
  const plan = planAtlas(
    [
      { key: "holdbody", width: 138, height: 39950 },
      { key: "note", width: 256, height: 82 },
    ],
    limits,
  );
  // The smaller of the two page sizes wins: 2048 px pages for one tall body.
  expect(plan.pageHeight).toBe(2048);
  expect(plan.pages * plan.pageWidth * plan.pageHeight).toBeLessThan(
    4096 * 4096,
  );
  const body = plan.placements.get("holdbody")!;
  expect([body.width, body.height]).toEqual([138, 39950]);
  const strip = plan.pageHeight - 2 * ATLAS_PADDING - 2 * STRIP_GUTTER;
  expect(body.pieces.length).toBe(Math.ceil(39950 / strip));
  // Contiguous rows from the top to the bottom, nothing scaled.
  let row = 0;
  for (const piece of body.pieces) {
    expect(piece.top).toBe(row);
    expect(piece.width).toBe(138);
    expect(piece.height).toBe(piece.bottom - piece.top);
    expect(piece.height).toBeLessThanOrEqual(strip);
    row = piece.bottom;
  }
  expect(row).toBe(39950);
  // Gutters only between strips.
  expect(body.pieces[0].gutterTop).toBe(0);
  expect(body.pieces.at(-1)!.gutterBottom).toBe(0);
  expect(body.pieces[1].gutterTop).toBe(STRIP_GUTTER);
  expect(plan.placements.get("note")!.pieces).toHaveLength(1);
  expectDisjoint(plan);
});

test("a full atlas grows by pages instead of shrinking images", () => {
  const images = Array.from({ length: 20 }, (_, i) => ({
    key: `bg${i}`,
    width: 1500,
    height: 1500,
  }));
  const plan = planAtlas(images, limits);
  expect(plan.pages).toBeGreaterThan(1);
  for (const placement of plan.placements.values()) {
    expect([placement.width, placement.height]).toEqual([1500, 1500]);
    expect(placement.pieces).toHaveLength(1);
  }
  expect(plan.downscaled).toEqual([]);
  expectDisjoint(plan);
  // The device's array layer limit still bounds the atlas.
  expect(() =>
    planAtlas(images, { ...limits, maxTextureArrayLayers: 2 }),
  ).toThrow("exceeds GPU texture capacity");
});

test("pages widen for wide images; only images wider than the device are scaled", () => {
  const plan = planAtlas(
    [
      { key: "wide", width: 6000, height: 300 },
      { key: "wider", width: 10000, height: 500 },
    ],
    limits,
  );
  expect(plan.pageWidth).toBe(8192);
  expect(plan.downscaled).toEqual(["wider"]);
  const wide = plan.placements.get("wide")!,
    wider = plan.placements.get("wider")!;
  expect([wide.width, wide.height]).toEqual([6000, 300]);
  expect(wider.width).toBe(8192 - 2 * ATLAS_PADDING);
  expect(wider.height).toBe(Math.round(500 * ((8192 - 4) / 10000)));
  expectDisjoint(plan);
  // A small device keeps small pages.
  const small = planAtlas([{ key: "a", width: 100, height: 3000 }], {
    maxTextureDimension2D: 2048,
    maxTextureArrayLayers: 256,
  });
  expect([small.pageWidth, small.pageHeight]).toEqual([2048, 2048]);
  expect(small.placements.get("a")!.pieces).toHaveLength(2);
});

/** Image row shown at quad position t (0 top, 1 bottom), as the shader computes it. */
const rowAt = (
  strip: { a: number; b: number },
  w: NonNullable<ReturnType<typeof stripWindow>>,
  t: number,
) => {
  const local = w.v0 + ((t - w.t0) / (w.t1 - w.t0)) * (w.v1 - w.v0);
  return strip.a + local * (strip.b - strip.a);
};

test("a source rect spanning three strips draws one quad per strip", () => {
  const strips = [
    { a: 0, b: 0.25 },
    { a: 0.25, b: 0.5 },
    { a: 0.5, b: 0.75 },
    { a: 0.75, b: 1 },
  ];
  // The quad shows rows [0, 0.6]: strips 0-2, the last one partly.
  for (const flip of [false, true]) {
    const windows = strips.map((s) => stripWindow(s, 0.6, flip));
    expect(windows[3]).toBeNull();
    const shown = windows.slice(0, 3).map((w) => w!);
    // The quads tile the whole quad without gaps or overlaps.
    const ranges = shown
      .map((w) => [w.t0, w.t1] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(ranges[0][0]).toBeCloseTo(0, 9);
    expect(ranges[1][0]).toBeCloseTo(ranges[0][1], 9);
    expect(ranges[2][0]).toBeCloseTo(ranges[1][1], 9);
    expect(ranges[2][1]).toBeCloseTo(1, 9);
    // Each quad maps continuously onto the image: row = t * 0.6 (top
    // first), or (1 - t) * 0.6 when flipped.
    for (const [i, w] of shown.entries())
      for (const t of [w.t0, (w.t0 + w.t1) / 2, w.t1])
        expect(rowAt(strips[i], w, t)).toBeCloseTo((flip ? 1 - t : t) * 0.6, 9);
    // Strip-local texture coordinates stay inside the strip.
    for (const w of shown)
      for (const v of [w.v0, w.v1]) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    // Strip 2 shows its first 40 %.
    expect(Math.max(shown[2].v0, shown[2].v1)).toBeCloseTo(0.4, 9);
  }
  // Flipped, strip 0 (the image's top) sits at the quad's bottom.
  const flipped = stripWindow(strips[0], 0.6, true)!;
  expect(flipped.t1).toBeCloseTo(1, 9);
  expect(flipped.v1).toBeCloseTo(0, 9);
  // A whole image (one strip) keeps the plain mapping.
  expect(stripWindow({ a: 0, b: 1 }, 1, false)).toEqual({
    t0: 0,
    t1: 1,
    v0: 0,
    v1: 1,
  });
});

test("regions draw one instance per strip, skipping strips that never show", () => {
  const strips = [0, 1, 2].map((k) => ({
    u: 0,
    v: k / 3,
    w: 0.1,
    h: 0.3,
    layer: k,
    a: k / 3,
    b: (k + 1) / 3,
  }));
  const region: AtlasRegion = {
    ...strips[0],
    strips,
    still: 10,
    first: 20,
    count: 4,
    stride: 3,
  };
  expect(regionInstances(region, true).map((i) => i.entry)).toEqual([
    10, 11, 12,
  ]);
  expect(regionInstances(region, false).map((i) => i.entry)).toEqual([
    20, 21, 22,
  ]);
  expect(regionInstances(region, false, 0.4).map((i) => i.uv.layer)).toEqual([
    0, 1,
  ]);
  // Plain images: one instance on their own entry.
  expect(
    regionInstances({ u: 0, v: 0, w: 1, h: 1, first: 5, count: 1 }, false),
  ).toEqual([
    {
      entry: 5,
      uv: { u: 0, v: 0, w: 1, h: 1, layer: 0, a: 0, b: 1 },
    },
  ]);
});

test("images lazer clamps or repeats get opaque edge padding, per axis", () => {
  const skin = {
    name: "wrap",
    assets: new Map(),
    sections: parseSkinIni(
      "[Mania]\nKeys: 4\nNoteImage0: Notes\\note.png\nKeyImage0: keys/k1\nStageLeft: stage/left\n",
    ),
  };
  const wrapped = wrappedImages(skin);
  expect(wrapped.get("taiko-roll-middle")).toEqual([true, true]);
  expect(wrapped.get("taiko-roll-end")).toEqual([true, true]);
  // LegacyKeyArea clamps horizontally only; notes, heads, tails and bodies both ways.
  expect(wrapped.get("keys/k1")).toEqual([true, false]);
  expect(wrapped.get("mania-key1D")).toEqual([true, false]);
  expect(wrapped.get("Notes/note")).toEqual([true, true]);
  expect(wrapped.get("mania-note1L")).toEqual([true, true]);
  expect(wrapped.get("mania-noteSH")).toEqual([true, true]);
  // Everything else is WrapMode.None (transparent padding).
  expect(wrapped.has("stage/left")).toBe(false);
  expect(wrapped.has("mania-stage-left")).toBe(false);
  expect(wrapped.has("taiko-slider")).toBe(false);
  expect(wrapped.has("hitcircle")).toBe(false);
});

test("WebGL2's minimum limits still hold tall images at full resolution", () => {
  // WebGL2 guarantees MAX_TEXTURE_SIZE 2048 and MAX_ARRAY_TEXTURE_LAYERS 256.
  const webgl2 = { maxTextureDimension2D: 2048, maxTextureArrayLayers: 256 };
  const plan = planAtlas(
    [
      { key: "holdbody", width: 138, height: 39950 },
      { key: "stage", width: 2000, height: 3000 },
      { key: "note", width: 256, height: 82 },
    ],
    webgl2,
  );
  expect(plan.pageWidth).toBeLessThanOrEqual(2048);
  expect(plan.pageHeight).toBeLessThanOrEqual(2048);
  expect(plan.pages).toBeLessThanOrEqual(256);
  expect(plan.downscaled).toEqual([]);
  const body = plan.placements.get("holdbody")!;
  expect([body.width, body.height]).toEqual([138, 39950]);
  expect(body.pieces.at(-1)!.bottom).toBe(39950);
  expectDisjoint(plan);
  // More pages than the layer limit allows is an error, not a silent cut.
  expect(() =>
    planAtlas(
      Array.from({ length: 300 }, (_, i) => ({
        key: `big-${i}`,
        width: 2000,
        height: 2000,
      })),
      webgl2,
    ),
  ).toThrow("exceeds GPU texture capacity");
});
