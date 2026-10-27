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

// The user's 10K (「シルビア」 v1.2 in lazer): keys hidden with a 128×1
// `_blank.png`, HitPosition 455, every width changed to 50 one by one. The
// receptor move (8.75 px) was larger than the 1-px image: "Invalid resize."
test("width changes on 7K, 10K and 18K with tall, short, blank and 2x keys stay valid", async () => {
  const { lostReport, pieceName, pieceReport, refused, unchanged } = await import("../src/proportions");
  const sizes = new Map([
    ["tall.png", { width: 100, height: 480 }],
    ["tall@2x.png", { width: 200, height: 960 }],
    ["_blank.png", { width: 128, height: 1, blank: true }],
    ["Inactive.png", { width: 3, height: 3 }],
    ["Inactive@2x.png", { width: 6, height: 6 }],
    ["note.png", { width: 100, height: 40 }],
  ]);
  const kinds = [
    [{ from: "tall.png", suffix: ".png" }, { from: "tall@2x.png", suffix: "@2x.png" }],
    [{ from: "_blank.png", suffix: ".png" }],
    [{ from: "Inactive.png", suffix: ".png" }, { from: "Inactive@2x.png", suffix: "@2x.png" }],
  ];
  for (const keys of [7, 10, 18])
    for (const hitPosition of [402, 455, 470]) {
      const widths = Array.from({ length: keys }, () => 30 * 1.6);
      for (let c = 0; c < keys; c++) {
        const scales = widths.map((w, i) => (i <= c ? 50 * 1.6 : w) / (30 * 1.6));
        const hp = hitPositionFor(hitPosition, referenceScale(scales));
        for (let col = 0; col < keys; col++) {
          const files = kinds[col % kinds.length];
          const from = g({ hitPosition, width: 30 * 1.6, noteHeight: 30 * 1.6 });
          const to = g({ hitPosition: hp, width: (col <= c ? 50 : 30) * 1.6, noteHeight: 30 * 1.6 });
          if (unchanged(files, sizes)) {
            expect(files[0].from).toBe("_blank.png");
            continue;
          }
          for (const o of pieceOps("key", from, to, files, sizes) ?? []) expect(refused(o.op)).toBeNull();
          for (const o of pieceOps("note", from, to, [{ from: "note.png", suffix: ".png" }], sizes) ?? []) expect(refused(o.op)).toBeNull();
        }
      }
    }
  // A key under the hit line scales from the stage bottom without moving.
  const [small] = pieceOps("key", g({ hitPosition: 470, width: 56 }), g({ hitPosition: 470, width: 80 }), kinds[2], sizes)!;
  expect(small.op).toEqual({ resize: { width: 4, height: 4, scale_y: 4.285714285714286 / 6, up: 0 } });
  // Messages name key count, columns and piece.
  expect(pieceName(10, "KeyImage9D")).toBe("10K column 10 key pressed");
  expect(pieceReport(10, [{ key: "KeyImage0", what: "blank image, left as it is" }, { key: "KeyImage9", what: "blank image, left as it is" }])).toBe(
    "10K columns 1 and 10 key: blank image, left as it is",
  );
  expect(lostReport(7, [{ key: "NoteImage2L", file: "b.png", rows: 3, op: "rows" }, { key: "NoteImage2L", file: "b.png", rows: 3, op: "rows" }])).toBe(
    "7K column 3 hold body: 3 rows cut from the end of b.png",
  );
  expect(refused({ resize: { width: 4, height: 1, scale_y: 1, up: 8.75 } })).toBe("a 9 px move is more than its 1 px height");
});
