// Proportions against render-core's layout (lazer's legacy mania rules):
// lay a 4K stage out before and after a column width change, with the image
// sizes and content transforms the "Keep proportions" operations produce,
// and measure each piece's drawn test pattern.
import { expect, test } from "bun:test";
import { maniaConfig, maniaLayout } from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { type Geometry, hitPositionFor, pieceOps } from "../src/proportions";

type Resize = { width: number; height: number; scale_y: number; up: number };
const ini = (width: number, hitPosition: number, style: number) =>
  [
    "[General]", "Version: 2.7", "[Mania]", "Keys: 4",
    `ColumnWidth: ${[width, width, width, width].join(",")}`,
    `HitPosition: ${hitPosition}`, `NoteBodyStyle: ${style}`,
    "KeyImage0: key", "NoteImage0: note", "NoteImage0H: head", "NoteImage0L: body", "",
  ].join("\n");
// 1x test images: a receptor 60×200 with a circle (r 25) whose centre is
// 70 px above the bottom; a note 60×30 with a circle (r 12) at its centre;
// a 60×1000 body with 1 px side borders.
const SIZES = { key: { width: 60, height: 200 }, note: { width: 60, height: 30 }, head: { width: 60, height: 30 }, body: { width: 60, height: 1000 } };
const layout = (text: string, sizes: Record<string, { width: number; height: number }>) =>
  maniaLayout(maniaConfig(readSkinIni(text), 4), (name) => sizes[name.replace(/-0$/, "")]);

/** A circle (centre above the image bottom, radii in image px) as drawn. */
function drawn(sprite: { x: number; y: number; width: number; height: number }, image: { width: number; height: number }, c: { above: number; rx: number; ry: number }) {
  const sx = sprite.width / image.width, sy = sprite.height / image.height;
  return { aspect: (c.rx * sx) / (c.ry * sy), width: 2 * c.rx * sx, centreY: sprite.y + sprite.height - c.above * sy };
}

for (const scale of [0.8, 1.25]) {
  test(`keys at ${scale}×: same aspect, ${scale}× as large, centre ${scale}× as far from the hit line`, () => {
    const before = layout(ini(40, 402, 0), SIZES);
    const key = before.columns[0].key!;
    const circle = { above: 70, rx: 25, ry: 25 };
    const was = drawn(key, SIZES.key, circle);
    const hitPosition = hitPositionFor(402, scale);
    const g = (width: number, hp: number): Geometry => ({ hitPosition: hp, width: width * 1.6, noteHeight: width * 1.6, repeat: false });
    const [op] = pieceOps("key", g(40, 402), g(40 * scale, hitPosition), [{ from: "key", suffix: "" }], new Map([["key", SIZES.key]]))!;
    const r = (op.op as { resize: Resize }).resize;
    const after = layout(ini(40 * scale, hitPosition, 0), { ...SIZES, key: { width: r.width, height: r.height } });
    // The resampled content: horizontally fitted, vertically scaled from the bottom and moved up.
    const now = drawn(after.columns[0].key!, r, { above: circle.above * r.scale_y + r.up, rx: (circle.rx * r.width) / SIZES.key.width, ry: circle.ry * r.scale_y });
    expect(now.aspect).toBeCloseTo(was.aspect, 2);
    expect(now.width / was.width).toBeCloseTo(scale, 2);
    // Within the half unit HitPosition rounds to (0.8 lazer units).
    expect(Math.abs(after.hitY - now.centreY - scale * (before.hitY - was.centreY))).toBeLessThan(0.01 + 0.8);
    // And exactly on the line render-core places: the receptor point on the
    // old line is on the new one.
    const onLine = (before.hitY - (key.y + key.height)) * -1; // old hit line above the image bottom (lazer units)
    expect(Math.abs(after.columns[0].key!.y + after.columns[0].key!.height - ((onLine / 1.0) * r.scale_y + r.up) - after.hitY)).toBeLessThan(1e-6);
  });

  test(`one column at ${scale}×: every column's notes and heads keep their aspect`, () => {
    // Only column 0 changes. The note height width is the narrowest column,
    // so at 0.8× column 0's notes already keep theirs and the others need
    // the compensation; at 1.25× it is the other way round.
    const text = (w0: number) => ini(40, 402, 0).replace("ColumnWidth: 40,40,40,40", `ColumnWidth: ${w0},40,40,40`);
    const cfgBefore = maniaConfig(readSkinIni(text(40)), 4), cfgAfter = maniaConfig(readSkinIni(text(40 * scale)), 4);
    const before = layout(text(40), SIZES);
    const circle = { above: 15, rx: 12, ry: 12 };
    let resampled = 0;
    for (const column of [0, 1]) {
      const g = (cfg: typeof cfgBefore): Geometry => ({ hitPosition: 402, width: cfg.columnWidth[column], noteHeight: cfg.noteHeightWidth, repeat: false });
      const s = cfgAfter.columnWidth[column] / cfgBefore.columnWidth[column];
      // A note's drawn height: image height × note height width / image width
      // (render-core, asserted below for the column that has one).
      const was = drawn({ x: 0, y: 0, width: before.columns[column].width, height: (SIZES.note.height * cfgBefore.noteHeightWidth) / SIZES.note.width }, SIZES.note, circle);
      for (const piece of ["note", "head"] as const) {
        const ops = pieceOps("note", g(cfgBefore), g(cfgAfter), [{ from: piece, suffix: "" }], new Map([[piece, SIZES[piece]]]));
        const r: Resize = ops ? (ops[0].op as { resize: Resize }).resize : { ...SIZES[piece], scale_y: 1, up: 0 };
        if (ops) resampled++;
        const after = layout(text(40 * scale), { ...SIZES, [piece]: { width: r.width, height: r.height } });
        const height = (r.height * after.config.noteHeightWidth) / r.width;
        if (column === 0) expect(height).toBeCloseTo(piece === "note" ? after.columns[0].note!.height : after.columns[0].head!.height, 6);
        const now = drawn({ x: 0, y: 0, width: after.columns[column].width, height }, r, { above: circle.above * r.scale_y, rx: (circle.rx * r.width) / SIZES[piece].width, ry: circle.ry * r.scale_y });
        expect(now.aspect).toBeCloseTo(was.aspect, 2);
        expect(now.width / was.width).toBeCloseTo(s, 2);
      }
    }
    expect(resampled).toBe(2); // one column's note and head
    // render-core draws a note's height from the note height width (LegacyNotePiece).
    expect(before.columns[0].note!.height).toBeCloseTo((SIZES.note.height * cfgBefore.noteHeightWidth) / SIZES.note.width, 6);
  });

  for (const style of [0, 1])
    test(`hold body at ${scale}×, NoteBodyStyle ${style}: border width and pattern scale together`, () => {
      // Across: a 1 px border drawn at column width / image width. Along: a
      // stretched body follows the hold (nothing to keep); a repeated one is
      // stretched over 32800 units (LegacyBodyPiece), so its rows set the scale.
      const across = (columnWidth: number) => (columnWidth * 1.6) / SIZES.body.width;
      const g = (width: number): Geometry => ({ hitPosition: 402, width: width * 1.6, noteHeight: width * 1.6, repeat: style !== 0 });
      const ops = pieceOps("body", g(40), g(40 * scale), [{ from: "body", suffix: "" }], new Map([["body", SIZES.body]]));
      expect(across(40 * scale) / across(40)).toBeCloseTo(scale, 6);
      if (style === 0) return expect(ops).toBeNull();
      const rows = (ops![0].op as { rows: { height: number } }).rows.height;
      const along = (height: number) => 32800 / height;
      expect(along(rows) / along(SIZES.body.height)).toBeCloseTo(scale, 2);
      expect(maniaConfig(readSkinIni(ini(40, 402, style)), 4).noteBodyStyle).toBe(style);
    });
}

test("5K at HitPosition 480: moving only the line aligns it to unchanged raised receptors", () => {
  const text = (hp: number) => ini(40, hp, 0).replace("Keys: 4", "Keys: 5");
  const config = (hp: number) => maniaLayout(maniaConfig(readSkinIni(text(hp)), 5), (name) => SIZES[name.replace(/-0$/, "") as keyof typeof SIZES]);
  const before = config(480), after = config(436.25);
  expect(after.columns[0].key).toEqual(before.columns[0].key);
  expect(before.hitY - after.hitY).toBeCloseTo(70);
  const receptor = drawn(after.columns[0].key!, SIZES.key, { above: 70, rx: 25, ry: 25 });
  expect(after.hitY).toBeCloseTo(receptor.centreY);
  const from: Geometry = { hitPosition: 480, width: 64, noteHeight: 64, repeat: false };
  const files = [{ from: "key", suffix: ".png" }];
  const dims = new Map([["key", SIZES.key]]);
  expect(pieceOps("key", from, { ...from, hitPosition: 436 }, files, dims, 0, false)).toBeNull();
  const resized = pieceOps("key", from, { ...from, width: 80, hitPosition: 425 }, files, dims, 0, false)!;
  expect(resized[0]).toMatchObject({ op: { resize: { width: 75, height: 250, up: 0 } } });
});
