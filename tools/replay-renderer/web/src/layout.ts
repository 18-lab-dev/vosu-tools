/** Placement math for playfields and overlay layers in the output frame.
 *  Pure functions: the preview, the editor and both exports share them. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A playfield's offset and size inside its layout cell: `x`/`y` move its
 *  centre by fractions of the cell size; `scale` multiplies the fitted size. */
export interface Transform {
  x: number;
  y: number;
  scale: number;
}
export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1 };
/** render-core draws world point (256, 192) at the viewport centre and fits
 *  this 640×480 box uniformly: `min(width / 640, height / 480)`. */
export const VIEW: Rect = { x: -64, y: -48, width: 640, height: 480 };
/** Largest render target side; WebGPU's guaranteed `maxTextureDimension2D`. */
export const MAX_TARGET = 8192;

/** How tracks share the frame. `auto` follows the output's aspect ratio. */
export type Layout = "auto" | "side-by-side" | "stacked" | "grid";
export const LAYOUTS: readonly Layout[] = ["auto", "side-by-side", "stacked", "grid"];
/** Space between cells, output pixels. */
export const CELL_GAP = 8;

/**
 * Columns × rows for `count` tracks in a `width`×`height` frame.
 * - one track always gets the whole frame;
 * - side by side puts tracks in a row, or in a column on a portrait frame;
 * - stacked is always one column;
 * - grid picks the column count whose cells have the largest short side,
 *   preferring fewer empty cells on a tie;
 * - auto is side by side for two tracks and a grid for more.
 */
export function gridFor(count: number, width: number, height: number, layout: Layout) {
  if (count <= 1) return { columns: 1, rows: 1 };
  const resolved = layout === "auto" ? (count <= 2 ? "side-by-side" : "grid") : layout;
  if (resolved === "stacked" || (resolved === "side-by-side" && height > width))
    return { columns: 1, rows: count };
  if (resolved === "side-by-side") return { columns: count, rows: 1 };
  let best = { columns: 1, rows: count, side: -1, empty: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const side = Math.min(
      (width - CELL_GAP * (columns - 1)) / columns,
      (height - CELL_GAP * (rows - 1)) / rows,
    );
    const empty = columns * rows - count;
    if (side > best.side + 1e-9 || (Math.abs(side - best.side) <= 1e-9 && empty < best.empty))
      best = { columns, rows, side, empty };
  }
  return { columns: best.columns, rows: best.rows };
}

/** One cell per track, row by row, in whole output pixels. */
export function layoutCells(count: number, width: number, height: number, layout: Layout): Rect[] {
  if (!Number.isInteger(count) || count < 1 || count > 16 || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2)
    throw new Error("Invalid layout dimensions");
  const { columns, rows } = gridFor(count, width, height, layout);
  const cellWidth = (width - CELL_GAP * (columns - 1)) / columns,
    cellHeight = (height - CELL_GAP * (rows - 1)) / rows;
  if (cellWidth < 1 || cellHeight < 1) throw new Error("Layout is too small");
  return Array.from({ length: count }, (_, i) => {
    const column = i % columns,
      row = Math.floor(i / columns);
    const x = Math.round(column * (cellWidth + CELL_GAP)),
      y = Math.round(row * (cellHeight + CELL_GAP));
    return {
      x,
      y,
      width: Math.round(column * (cellWidth + CELL_GAP) + cellWidth) - x,
      height: Math.round(row * (cellHeight + CELL_GAP) + cellHeight) - y,
    };
  });
}

/** The built-in HUD: four layers per track, each moved and scaled like an overlay. */
export type HudKey = "score" | "accuracy" | "combo" | "health";
export const HUD_KEYS: readonly HudKey[] = ["score", "accuracy", "combo", "health"];
/**
 * Size of each layer at scale 1 in a 1080 px cell (the short side), and the
 * corner its position names: `x`/`y` (cell fractions, from the settings) put
 * that corner of the box, so right-aligned text grows leftwards.
 */
export const HUD: Record<HudKey, { width: number; height: number; anchorX: 0 | 1; anchorY: 0 | 1 }> = {
  score: { width: 330, height: 72, anchorX: 1, anchorY: 0 },
  accuracy: { width: 190, height: 46, anchorX: 1, anchorY: 0 },
  combo: { width: 260, height: 84, anchorX: 0, anchorY: 1 },
  health: { width: 480, height: 14, anchorX: 0, anchorY: 0 },
};
/** HUD units per output pixel in `cell`: its short side over 1080. */
const hudUnit = (cell: Rect) => Math.min(cell.width, cell.height) / 1080;
/** Output-pixel box of a HUD layer placed at `transform` in `cell`. */
export function hudBox(cell: Rect, key: HudKey, transform: Transform): Rect {
  const spec = HUD[key],
    unit = hudUnit(cell) * transform.scale;
  const width = spec.width * unit,
    height = spec.height * unit;
  return {
    x: cell.x + transform.x * cell.width - spec.anchorX * width,
    y: cell.y + transform.y * cell.height - spec.anchorY * height,
    width,
    height,
  };
}
/** The transform that puts a HUD layer's box at `box`; its height decides the scale. */
export function hudTransformFor(cell: Rect, key: HudKey, box: Rect): Transform {
  const spec = HUD[key];
  return {
    x: (box.x + spec.anchorX * box.width - cell.x) / cell.width,
    y: (box.y + spec.anchorY * box.height - cell.y) / cell.height,
    scale: box.height / (spec.height * hudUnit(cell)),
  };
}
/** Pixels per world unit that make `content` fill `cell`: the cell height,
 *  unless the cell is narrower than the content's aspect ratio. */
export function fitScale(cell: Rect, content: Rect) {
  return Math.min(cell.width / content.width, cell.height / content.height);
}

export interface Placement {
  /** Render target size to request from the renderer. */
  target: { width: number; height: number };
  /** Where the target texture is drawn on the canvas. */
  draw: Rect;
  /** The playfield's content box on the canvas (what the editor selects). */
  box: Rect;
}

/** Renderer viewport scale for a target of this size. */
const viewScale = (width: number, height: number) =>
  Math.min(width / VIEW.width, height / VIEW.height);

/**
 * Places a playfield whose visible content occupies `content` (world units)
 * in `cell`. `texture` is the size of an already rendered target; when it
 * was rendered for another scale (live dragging) it is drawn resampled.
 */
export function place(
  cell: Rect,
  content: Rect,
  transform: Transform,
  texture?: { width: number; height: number },
): Placement {
  const ceiling = MAX_TARGET / Math.max(VIEW.width, VIEW.height);
  const scale = fitScale(cell, content) * transform.scale;
  const targetScale = Math.min(scale, ceiling);
  const target = {
    width: Math.max(2, Math.round(VIEW.width * targetScale)),
    height: Math.max(2, Math.round(VIEW.height * targetScale)),
  };
  const tex = texture ?? target;
  const rendered = viewScale(tex.width, tex.height);
  const k = scale / rendered;
  const cx = content.x + content.width / 2,
    cy = content.y + content.height / 2;
  const centre = {
    x: cell.x + cell.width * (0.5 + transform.x),
    y: cell.y + cell.height * (0.5 + transform.y),
  };
  return {
    target,
    draw: {
      x: centre.x - k * (tex.width / 2 + (cx - 256) * rendered),
      y: centre.y - k * (tex.height / 2 + (cy - 192) * rendered),
      width: tex.width * k,
      height: tex.height * k,
    },
    box: {
      x: centre.x - (content.width * scale) / 2,
      y: centre.y - (content.height * scale) / 2,
      width: content.width * scale,
      height: content.height * scale,
    },
  };
}

/** The transform that puts the playfield's content box at `box` (canvas px).
 *  The box keeps the content's aspect ratio; its width decides the scale. */
export function transformFor(cell: Rect, content: Rect, box: Rect): Transform {
  return {
    x: (box.x + box.width / 2 - cell.x) / cell.width - 0.5,
    y: (box.y + box.height / 2 - cell.y) / cell.height - 0.5,
    scale: box.width / (content.width * fitScale(cell, content)),
  };
}

/** Bounding box (world units) of pixels with alpha above `threshold` in an
 *  RGBA image rendered at the reference 640×480 viewport (1 px = 1 unit).
 *  Returns the whole view when nothing (or almost nothing) is drawn. */
export function contentBounds(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = 8,
): Rect {
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[(y * width + x) * 4 + 3] > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  if (right < left || right - left < width * 0.05 || bottom - top < height * 0.05)
    return { ...VIEW };
  const sx = VIEW.width / width,
    sy = VIEW.height / height;
  return {
    x: VIEW.x + left * sx,
    y: VIEW.y + top * sy,
    width: (right - left + 1) * sx,
    height: (bottom - top + 1) * sy,
  };
}

/**
 * The extent a playfield is fitted by. A mania stage always spans the full
 * view height, so only its measured width is used: transparent rows at the top
 * or bottom of a skin's stage (or notes present at the probe time) must not
 * change the scale, or two tracks with the same skin would draw their stages at
 * different sizes and hit positions. Other rulesets use the measured box.
 */
export function fitBounds(mode: number, measured: Rect): Rect {
  return mode === 3 ? { x: measured.x, width: measured.width, y: VIEW.y, height: VIEW.height } : measured;
}

/** Lines a dragged box can snap to: edges and centres of the canvas and cells. */
export interface Guides {
  x: number[];
  y: number[];
}
export function guidesFor(canvas: Rect, cells: Rect[]): Guides {
  const x = new Set<number>(),
    y = new Set<number>();
  for (const r of [canvas, ...cells]) {
    x.add(r.x).add(r.x + r.width / 2).add(r.x + r.width);
    y.add(r.y).add(r.y + r.height / 2).add(r.y + r.height);
  }
  return { x: [...x], y: [...y] };
}
/** Smallest offset that lands one of `points` on a guide within `threshold`. */
function nearest(points: number[], guides: number[], threshold: number) {
  let best: { delta: number; line: number } | null = null;
  for (const point of points)
    for (const line of guides) {
      const delta = line - point;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta)))
        best = { delta, line };
    }
  return best;
}
/** Moves `box` so its nearest edge or centre meets a guide on each axis. */
export function snapMove(box: Rect, guides: Guides, threshold: number) {
  const sx = nearest([box.x, box.x + box.width / 2, box.x + box.width], guides.x, threshold),
    sy = nearest([box.y, box.y + box.height / 2, box.y + box.height], guides.y, threshold);
  return {
    box: { ...box, x: box.x + (sx?.delta ?? 0), y: box.y + (sy?.delta ?? 0) },
    lines: { x: sx?.line ?? null, y: sy?.line ?? null },
  };
}

export type Corner = "nw" | "ne" | "sw" | "se";
/**
 * Resizes `start` by dragging `corner` to `point` with the opposite corner
 * fixed. `aspect` (width / height) locks the shape; the dragged corner snaps
 * to guides first.
 */
export function resizeBox(
  start: Rect,
  corner: Corner,
  point: { x: number; y: number },
  options: { aspect?: number; guides?: Guides; threshold?: number; min?: number } = {},
) {
  const min = options.min ?? 8;
  const west = corner === "nw" || corner === "sw",
    north = corner === "nw" || corner === "ne";
  const anchor = {
    x: west ? start.x + start.width : start.x,
    y: north ? start.y + start.height : start.y,
  };
  let px = point.x,
    py = point.y;
  const lines = { x: null as number | null, y: null as number | null };
  if (options.guides) {
    const t = options.threshold ?? 0;
    const sx = nearest([px], options.guides.x, t),
      sy = nearest([py], options.guides.y, t);
    if (sx) (px = sx.line), (lines.x = sx.line);
    if (sy) (py = sy.line), (lines.y = sy.line);
  }
  let width = Math.max(min, Math.abs(px - anchor.x)),
    height = Math.max(min, Math.abs(py - anchor.y));
  if (options.aspect) {
    // The axis that moved further proportionally decides the size.
    if (width / options.aspect >= height) height = width / options.aspect;
    else width = height * options.aspect;
  }
  return {
    box: {
      x: west ? anchor.x - width : anchor.x,
      y: north ? anchor.y - height : anchor.y,
      width,
      height,
    },
    lines,
  };
}
