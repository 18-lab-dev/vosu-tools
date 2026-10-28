// "Keep proportions when changing column width": what each mania piece
// needs so a column drawn wider or narrower looks as if it were scaled
// uniformly, instead of osu!'s stretch. From lazer 2026.1005.0:
//
// - **Keys** (KeyImage#, KeyImage#D; `LegacyKeyArea`): the sprite spans the
//   column's width (`RelativeSizeAxes = X, Width = 1`) and keeps the
//   texture's height (DisplayHeight: pixels, halved for @2x), anchored to the
//   stage's bottom. A width change stretches them sideways only. Fix: scale
//   the image by s in both axes about its bottom edge; the hit line moves the
//   same way (HitPosition counts down from the 480-unit stage's top, the
//   receptors stand on its bottom): HitPosition' = 480 − (480 − HitPosition) × s.
// - **Notes, hold heads and tails** (NoteImage#, #H, #T; `LegacyNotePiece`):
//   scaled by (column width, note height width) / texture width, where the
//   note height width is WidthForNoteHeightScale, else the stage's narrowest
//   column (`LegacySkin.GetConfig`). They keep their look when every column
//   changes by the same s (WidthForNoteHeightScale is scaled along); with
//   different scales a column's note is stretched by s_i × nh / nh', undone
//   by resampling its height by that factor.
// - **Hold bodies** (NoteImage#L; `LegacyBodyPiece`): as wide as the column
//   and as long as the hold. Stretched (NoteBodyStyle 0): their detail
//   across the column scales with it, along it follows the hold: nothing to
//   do. Repeated (other styles): the image is stretched over 32800 units
//   whatever its height, so its pattern keeps its size along the hold while
//   the width changes: the image's height becomes H / s (rows cut, or
//   repeated from its top), so the pattern scales by s too.
//
// Order of changes to one piece (all in one undo step): the image as it was
// before the first geometry change (its "original", which carries any tail
// calibration made before), then the proportion scale, then the receptor's
// hit-line move (keys only), filled by the edge-clamp rule.

import type { DeriveOp } from "./hit-panel";

/** The stage height HitPosition is measured in (legacy units). */
export const STAGE = 480;
/** Image pixels (1x) per legacy unit: lazer draws the stage 768 tall. */
export const UNIT_PX = 1.6;

/** HitPosition after the receptors grow by `scale` about the stage bottom. */
export const hitPositionFor = (hitPosition: number, scale: number) =>
  Math.round(STAGE - (STAGE - hitPosition) * scale);

/**
 * The scale the shared hit line follows when columns change by different
 * scales: the one most columns share (ties: the one nearest 1, so the line
 * moves least). Every other column's receptor is then placed on that line
 * by its own vertical offset.
 */
export function referenceScale(scales: readonly number[]): number {
  const groups = new Map<string, { scale: number; n: number }>();
  for (const scale of scales) {
    const id = scale.toFixed(6);
    const group = groups.get(id) ?? { scale, n: 0 };
    group.n++;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || Math.abs(a.scale - 1) - Math.abs(b.scale - 1))[0]?.scale ?? 1;
}

export type Piece = "key" | "note" | "body";
export function pieceOf(key: string): Piece | null {
  if (/^KeyImage\d+D?$/.test(key)) return "key";
  if (/^NoteImage\d+[HT]?$/.test(key)) return "note";
  if (/^NoteImage\d+L$/.test(key)) return "body";
  return null;
}
export const columnOf = (key: string) => Number(/\d+/.exec(key)?.[0] ?? -1);

/**
 * Whether a geometry change re-derives a captured piece. HitPosition moves
 * only the keys (lazer places LegacyKeyArea's receptors on the hit line;
 * notes and hold pieces are drawn by the scrolling, not from the image), so
 * notes and hold pieces follow width changes only.
 */
export const rederives = (key: string, widthsChange: boolean) => widthsChange || pieceOf(key) === "key";

const ROLE: Record<string, string> = { "": "note", H: "hold head", L: "hold body", T: "hold tail" };
/** A piece as the screen names it: `7K column 3 hold body`. */
export function pieceName(keys: number, key: string): string {
  const m = /^(KeyImage|NoteImage)(\d+)([DHLT]?)$/.exec(key);
  if (!m) return `${keys}K ${key}`;
  const role = m[1] === "KeyImage" ? (m[3] === "D" ? "key pressed" : "key") : ROLE[m[3]];
  return `${keys}K column ${Number(m[2]) + 1} ${role}`;
}

/** Rows an image operation dropped. */
export interface Lost {
  key: string;
  file: string;
  rows: number;
  /** `rows`: a repeated body's tile made shorter; else moved past the edge. */
  op: "shift" | "resize" | "rows";
}
/**
 * One line per distinct loss, the columns that share it named together:
 * `7K columns 1, 2 and 5 hold body: 3073 rows cut from the end of …`.
 */
export function lostReport(keys: number, lost: readonly Lost[]): string {
  return pieceReport(
    keys,
    lost.map((l) => ({
      key: l.key,
      what:
        l.op === "rows"
          ? `${l.rows} rows cut from the end of ${l.file}`
          : `${l.rows} rows of ${l.file} moved past the image edge`,
    })),
  );
}

/**
 * One line per distinct note about pieces, the columns that share it named
 * together: `10K columns 1, 2 and 10 key: <what>`.
 */
export function pieceReport(keys: number, notes: readonly { key: string; what: string }[]): string {
  const groups = new Map<string, number[]>();
  for (const { key, what } of notes) {
    const role = pieceName(keys, key).replace(/^\d+K column \d+ /, "");
    const id = `${role}\n${what}`;
    const columns = groups.get(id) ?? [];
    if (!columns.includes(columnOf(key) + 1)) columns.push(columnOf(key) + 1);
    groups.set(id, columns);
  }
  return [...groups]
    .map(([id, columns]) => {
      const [role, what] = id.split("\n");
      columns.sort((a, b) => a - b);
      const named =
        columns.length === 1
          ? `column ${columns[0]}`
          : `columns ${columns.slice(0, -1).join(", ")} and ${columns.at(-1)}`;
      return `${keys}K ${named} ${role}: ${what}`;
    })
    .join("; ");
}

/** One column's geometry: HitPosition, its width, the note height width, body style. */
export interface Geometry {
  hitPosition: number;
  width: number;
  noteHeight: number;
  repeat: boolean;
}
export interface Dims {
  width: number;
  height: number;
  /** Not one visible pixel (a placeholder that hides an element). */
  blank?: boolean;
}

/**
 * Why a piece is left as it is, or null when it can be made: an image with
 * no visible pixel (skins hide receptors with a 1-px `blank.png`) has
 * nothing to scale or move.
 */
export function unchanged(files: readonly { from: string }[], dims: ReadonlyMap<string, Dims>): string | null {
  return files.length && files.every((f) => dims.get(f.from)?.blank) ? "blank image, left as it is" : null;
}

/**
 * Why the service would refuse an operation (`images.rs`), or null. A
 * guard: the operations made here stay inside these limits.
 */
export function refused(op: DeriveOp): string | null {
  if (!("resize" in op)) return null;
  const r = op.resize;
  if (!(r.width >= 1 && r.width <= 8192 && r.height >= 1 && r.height <= 65536))
    return `would be ${r.width}×${r.height} px, outside 1–8192 × 1–65536`;
  if (!(Number.isFinite(r.scale_y) && r.scale_y > 0 && r.scale_y <= 16))
    return `vertical scale ${r.scale_y} outside 0–16`;
  if (!(Number.isFinite(r.up) && Math.abs(r.up) <= r.height))
    return `a ${Math.round(Math.abs(r.up))} px move is more than its ${r.height} px height`;
  return null;
}
/** One output file: an operation on a source file of the same image. */
export interface FileOp {
  source: string;
  op: DeriveOp;
  /**
   * Applied to `source` first, `op` then to its result: a key image's
   * hit-position move (inside its canvas) before the width change scales it.
   */
  pre?: DeriveOp;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const hd = (name: string) => /@2x\.[^./]+$/i.test(name);
/** The @2x file of the same frame, if the image has one. */
function hdTwin(files: readonly { from: string; suffix: string }[], file: { from: string; suffix: string }) {
  if (hd(file.suffix)) return file;
  const want = file.suffix.replace(/(\.[^.]+)$/, "@2x$1").toLowerCase();
  return files.find((f) => f.suffix.toLowerCase() === want) ?? file;
}

/**
 * The files a piece becomes when its column goes from `from` to `to`
 * geometry, or null when it is unchanged (the original is used as is).
 * `dims` has the size of every file of the image.
 *
 * Key images take two operations, kept apart: `moved`, the HitPosition
 * units moved by hand (stepper, field, calibration) at the captured widths,
 * shifts the receptor inside its canvas (cutting what leaves it, as asked);
 * a width change scales the whole canvas, which carries the receptor onto
 * the HitPosition the widths derive, so it shifts nothing. What scaling
 * leaves over (the rounding of that HitPosition to whole units, under 1 px;
 * or, with mixed widths, the distance between a column's own scale and the
 * shared hit line) is moved without cutting: within the resample, the
 * canvas grown to hold it.
 */
export function pieceOps(
  piece: Piece,
  from: Geometry,
  to: Geometry,
  files: readonly { from: string; suffix: string }[],
  dims: ReadonlyMap<string, Dims>,
  moved = 0,
): FileOp[] | null {
  const s = to.width / from.width;
  const size = (name: string) => {
    const d = dims.get(name);
    if (!d) throw new Error(`No size for ${name}`);
    return d;
  };
  // Resampled from the largest source (the @2x file when there is one), so
  // the 1x file is a downscale of it, never an upscale of a smaller image.
  const resize = (file: { from: string; suffix: string }, sx: number, sy: number, up: number, grow = false): FileOp => {
    const source = hdTwin(files, file).from;
    const target = size(file.from), src = size(source);
    const lift = up * (hd(file.suffix) ? 2 : 1);
    return {
      source,
      op: {
        resize: {
          width: Math.max(1, Math.round(target.width * sx)),
          height: Math.max(1, Math.round(target.height * sy)) + (grow ? Math.max(0, Math.ceil(lift - 1e-9)) : 0),
          scale_y: (sy * target.height) / src.height,
          up: lift,
        },
      },
    };
  };
  if (piece === "key") {
    // The receptor point that stood on the hit line stands on the new one.
    // A key image shorter than its distance to the hit line (a bar under
    // it, a 1-px placeholder) has nothing on the line: it scales from the
    // stage bottom, where lazer anchors it (LegacyKeyArea), and stays.
    const line = (STAGE - from.hitPosition) * UNIT_PX;
    const reaches = (f: { from: string; suffix: string }) => {
      const d = dims.get(f.from);
      return !d || d.height / (hd(f.suffix) ? 2 : 1) >= line;
    };
    // By hand (px at the captured scale), and what the width change leaves.
    const byHand = -moved * UNIT_PX;
    const left = (STAGE - to.hitPosition) * UNIT_PX - s * (line + byHand);
    // Density belongs to the destination suffix, not the stored source:
    // deriving a 1x image from its HD twin retains the twin's filename.
    const k = (suffix: string) => (hd(suffix) ? 2 : 1);
    const shift = (up: number, grow: boolean): DeriveOp => ({ shift: grow ? { up, grow } : { up } });
    const out = files.map((f): FileOp | null => {
      if (!reaches(f)) return same(s, 1) ? null : resize(f, s, s, 0);
      if (same(s, 1)) {
        // Exact row moves, no resampling: by hand inside the canvas, the
        // rest growing it.
        const hand = Math.round(byHand * k(f.suffix)),
          rest = Math.round(left * k(f.suffix));
        if (hand && rest) return { source: f.from, pre: shift(hand, false), op: shift(rest, true) };
        if (hand) return { source: f.from, op: shift(hand, false) };
        if (rest) return { source: f.from, op: shift(rest, true) };
        return null;
      }
      const op = resize(f, s, s, left, true);
      const hand = Math.round(byHand * k(hdTwin(files, f).suffix));
      return hand ? { ...op, pre: shift(hand, false) } : op;
    });
    if (out.every((o) => o === null)) return null;
    // A file that needs nothing still belongs to the slot: an unchanged copy.
    return out.map((o, i) => o ?? { source: files[i].from, op: shift(0, false) });
  }
  if (piece === "note") {
    const factor = (s * from.noteHeight) / to.noteHeight;
    if (same(factor, 1)) return null;
    return files.map((f) => resize(f, 1, factor, 0));
  }
  if (!to.repeat || same(s, 1)) return null;
  return files.map((f) => ({ source: f.from, op: { rows: { height: Math.max(1, Math.round(size(f.from).height / s)) } } }));
}
