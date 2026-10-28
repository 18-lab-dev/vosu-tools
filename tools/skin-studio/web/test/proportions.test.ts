import { expect, test } from "bun:test";
import { type Geometry, hitPositionFor, pieceOf, pieceOps, referenceScale } from "../src/proportions";
import { HitPanel, type HitHost } from "../src/hit-panel";

test("repeating a 5K width never renders, captures originals, or derives files", async () => {
  const unexpected = () => { throw new Error("Unchanged width must do nothing"); };
  const host: HitHost = {
    keys: () => 5,
    mixText: () => "[Mania]\nKeys: 5\nColumnWidth: 60,60,60,60,60\nHitPosition: 455\n",
    mixFiles: unexpected, mixIndex: unexpected, resolved: unexpected, draft: unexpected,
    change: unexpected, derive: unexpected, rows: unexpected, lastPlay: unexpected,
    speed: unexpected, setSpeed: unexpected, canWrite: unexpected, state: unexpected, error: unexpected,
  };
  const panel = new HitPanel(host);
  await panel.setWidths([0, 1, 2, 3, 4], "60", "Apply width to all columns");
  await panel.setWidths([0], "60", "Set column 1 width");
  expect(panel.lastRegeometry).toBeNull();
});

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

test("derived SD sources named @2x still use destination density and the HD twin", () => {
  const files = [
    { from: "sd/k@2x.png", suffix: ".png" },
    { from: "hd/k@2x.png", suffix: "@2x.png" },
  ];
  const sizes = new Map([[files[0].from, { width: 60, height: 200 }], [files[1].from, { width: 120, height: 400 }]]);
  const ops = pieceOps("key", g({}), g({ width: 60, hitPosition: 383 }), files, sizes)!;
  expect(ops.map((op) => op.source)).toEqual([files[1].from, files[1].from]);
  const resized = ops.map(({ op }) => {
    if (!("resize" in op)) throw new Error("Expected a resize");
    return op.resize;
  });
  expect(resized[0].up).toBeCloseTo(-0.8);
  expect(resized[1].up).toBeCloseTo(-1.6);
  expect(resized[0].scale_y).toBeCloseTo(0.625);
  expect(pieceOps("key", g({}), g({ hitPosition: 397 }), files, sizes, -5)?.[0])
    .toEqual({ source: files[0].from, op: { shift: { up: 8 } } });
});

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
  // Only HitPosition, by hand: the exact row move inside the canvas.
  expect(pieceOps("key", g({}), g({ hitPosition: 397 }), files, dims, -5)).toEqual([
    { source: "k.png", op: { shift: { up: 8 } } },
    { source: "k@2x.png", op: { shift: { up: 16 } } },
  ]);
  // The same line reached without a hand move (another column's width
  // moved it): the canvas grows instead, nothing is cut.
  expect(pieceOps("key", g({}), g({ hitPosition: 397 }), files, dims)).toEqual([
    { source: "k.png", op: { shift: { up: 8, grow: true } } },
    { source: "k@2x.png", op: { shift: { up: 16, grow: true } } },
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

// Where the receptor point (on the hit line before) ends, in px above the
// bottom, after a key's operations: the hand move, then scale and offset.
const lands = (op: { pre?: unknown; op: unknown }, line: number, k: number) => {
  const pre = (op.pre as { shift?: { up: number } } | undefined)?.shift?.up ?? 0;
  const r = (op.op as { resize?: { scale_y: number; up: number; height: number } }).resize;
  const sh = (op.op as { shift?: { up: number } }).shift?.up ?? 0;
  // resize scale_y is per source px (the @2x source); line in source px.
  return r ? (line * 2 + pre) * r.scale_y + r.up : line * k + pre + sh;
};

test("a width change scales the canvas onto the derived HitPosition: no cut, under 1 px left", () => {
  const files = [{ from: "k.png", suffix: ".png" }, { from: "k@2x.png", suffix: "@2x.png" }];
  for (const [hp, s] of [[402, 1.25], [455, 65 / 60], [455, 0.8], [420, 50 / 35]] as const) {
    const to = hitPositionFor(hp, s);
    const ops = pieceOps("key", g({ hitPosition: hp }), g({ hitPosition: to, width: 48 * s }), files, dims)!;
    for (const [i, o] of ops.entries()) {
      expect(o.pre).toBeUndefined();
      const r = (o.op as { resize: { up: number } }).resize;
      expect(Math.abs(r.up)).toBeLessThanOrEqual(0.8 * (i ? 2 : 1) + 1e-9); // the rounding of HitPosition
      // The receptor point lands on the new line.
      expect(lands(o, (480 - hp) * 1.6, i ? 2 : 1)).toBeCloseTo((480 - to) * 1.6 * (i ? 2 : 1), 6);
    }
  }
});

test("hand moves and width changes in either order end on the line; only the hand move cuts", () => {
  const files = [{ from: "k.png", suffix: ".png" }, { from: "k@2x.png", suffix: "@2x.png" }];
  const s = 1.25;
  // Stepper −5 first (5 units at the captured widths), then every column 1.25×.
  const first = pieceOps("key", g({}), g({ hitPosition: hitPositionFor(397, s), width: 60 }), files, dims, -5)!;
  // Width first (402 → 383), then the stepper −5 at that scale: 4 captured units.
  const second = pieceOps("key", g({}), g({ hitPosition: hitPositionFor(402, s) - 5, width: 60 }), files, dims, -5 / s)!;
  for (const [ops, target] of [[first, hitPositionFor(397, s)], [second, hitPositionFor(402, s) - 5]] as const)
    for (const [i, o] of ops.entries()) {
      // The hand move inside the original (@2x) canvas, then the scaling.
      expect((o.pre as { shift: { up: number; grow?: boolean } }).shift.grow).toBeUndefined();
      expect("resize" in o.op).toBe(true);
      expect(Math.abs(lands(o, 78 * 1.6, i ? 2 : 1) - (480 - target) * 1.6 * (i ? 2 : 1))).toBeLessThan(1.6 * (i ? 2 : 1));
    }
  expect((first[0].pre as { shift: { up: number } }).shift.up).toBe(16); // 5 × 3.2 px on the @2x source
  expect((second[0].pre as { shift: { up: number } }).shift.up).toBe(13); // 4 × 3.2 = 12.8
});
