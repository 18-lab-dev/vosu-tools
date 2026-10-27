import { expect, test } from "bun:test";
import { type Geometry, hitPositionFor, pieceOf, pieceOps, referenceScale } from "../src/proportions";

test("HitPosition follows the receptors: 480 − (480 − HitPosition) × s, rounded", () => {
  expect(hitPositionFor(402, 1)).toBe(402);
  expect(hitPositionFor(455, 0.8)).toBe(460); // 480 − 25 × 0.8
  expect(hitPositionFor(402, 1.25)).toBe(383); // 480 − 97.5 = 382.5 → 383 (half up)
  expect(hitPositionFor(480, 1.5)).toBe(480); // on the stage bottom: stays
  expect(hitPositionFor(0, 0.5)).toBe(240); // the stage top
  expect(hitPositionFor(401, 1.1)).toBe(393); // 480 − 79 × 1.1 = 393.1
});

test("mixed widths: the hit line follows the scale most columns share, ties nearest 1", () => {
  expect(referenceScale([1, 1, 1.5, 1, 1])).toBe(1); // a wider special column
  expect(referenceScale([1.2, 1.2, 1.2, 1])).toBe(1.2);
  expect(referenceScale([0.8, 1.25])).toBe(0.8); // a tie: 0.8 is nearer 1
});

const g = (over: Partial<Geometry>): Geometry => ({ hitPosition: 402, width: 48, noteHeight: 48, repeat: false, ...over });
const dims = new Map([
  ["k.png", { width: 60, height: 200 }],
  ["k@2x.png", { width: 120, height: 400 }],
  ["n-0.png", { width: 60, height: 20 }],
  ["n-0@2x.png", { width: 120, height: 40 }],
  ["n-1.png", { width: 60, height: 20 }],
  ["b.png", { width: 60, height: 1000 }],
]);

test("pieces by key", () => {
  expect(["KeyImage0", "KeyImage3D", "NoteImage1", "NoteImage1H", "NoteImage1T", "NoteImage1L", "StageHint"].map(pieceOf)).toEqual([
    "key", "key", "note", "note", "note", "body", null,
  ]);
});

test("keys: both files from the @2x source, exact target sizes, receptor on the new line", () => {
  const files = [{ from: "k.png", suffix: ".png" }, { from: "k@2x.png", suffix: "@2x.png" }];
  const ops = pieceOps("key", g({}), g({ width: 60, hitPosition: hitPositionFor(402, 1.25) }), files, dims)!;
  expect(ops.map((o) => o.source)).toEqual(["k@2x.png", "k@2x.png"]);
  const [sd, hd] = ops.map((o) => (o.op as { resize: { width: number; height: number; scale_y: number; up: number } }).resize);
  expect([sd.width, sd.height, hd.width, hd.height]).toEqual([75, 250, 150, 500]);
  expect(sd.scale_y).toBeCloseTo(0.625); // 1.25 × 200 / 400
  expect(hd.scale_y).toBeCloseTo(1.25);
  // 383 instead of the exact 382.5: half a unit (0.8 px, 1.6 @2x) down.
  expect(sd.up).toBeCloseTo(-0.8);
  expect(hd.up).toBeCloseTo(-1.6);
  // Only HitPosition: the exact row move, no resampling.
  expect(pieceOps("key", g({}), g({ hitPosition: 397 }), files, dims)).toEqual([
    { source: "k.png", op: { shift: { up: 8 } } },
    { source: "k@2x.png", op: { shift: { up: 16 } } },
  ]);
  expect(pieceOps("key", g({}), g({}), files, dims)).toBeNull();
});

test("notes keep their look when every column scales, else their height is resampled; frames too", () => {
  const files = [
    { from: "n-0.png", suffix: "-0.png" },
    { from: "n-0@2x.png", suffix: "-0@2x.png" },
    { from: "n-1.png", suffix: "-1.png" },
  ];
  // Uniform: the note height width scales along (min column or WidthForNoteHeightScale).
  expect(pieceOps("note", g({}), g({ width: 60, noteHeight: 60 }), files, dims)).toBeNull();
  // Only this column widens: its notes grow in height by the same 1.25.
  const ops = pieceOps("note", g({}), g({ width: 60 }), files, dims)!;
  const r = ops.map((o) => (o.op as { resize: { width: number; height: number } }).resize);
  expect(ops.map((o) => o.source)).toEqual(["n-0@2x.png", "n-0@2x.png", "n-1.png"]);
  expect(r.map((x) => [x.width, x.height])).toEqual([[60, 25], [120, 50], [60, 25]]);
  // A narrower column elsewhere shrinks the note height width: unchanged columns compensate.
  const other = pieceOps("note", g({}), g({ noteHeight: 40 }), files, dims)!;
  expect((other[0].op as { resize: { height: number } }).resize.height).toBe(24);
});

test("bodies: stretched ones need nothing, repeated ones change their height by 1/s exactly", () => {
  const files = [{ from: "b.png", suffix: ".png" }];
  expect(pieceOps("body", g({}), g({ width: 60 }), files, dims)).toBeNull();
  expect(pieceOps("body", g({ repeat: true }), g({ width: 60, repeat: true }), files, dims)).toEqual([{ source: "b.png", op: { rows: { height: 800 } } }]);
  expect(pieceOps("body", g({ repeat: true }), g({ width: 38.4, repeat: true }), files, dims)).toEqual([{ source: "b.png", op: { rows: { height: 1250 } } }]);
});
