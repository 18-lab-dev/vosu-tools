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

/** How tracks share the frame. `auto` follows the output's aspect ratio;
 *  `overlap` draws osu! replays of one map on a single playfield (overlap.ts). */
export type Layout = "auto" | "side-by-side" | "stacked" | "grid" | "overlap";
export const LAYOUTS: readonly Layout[] = ["auto", "side-by-side", "stacked", "grid", "overlap"];
/** Space between cells, output pixels. */
export const CELL_GAP = 8;

/**
 * Columns × rows for `count` tracks in a `width`×`height` frame.
 * - one track always gets the whole frame;
 * - side by side puts tracks in a row, or in a column on a portrait frame;
 * - stacked is always one column;
 * - grid picks the column count whose cells have the largest short side;
 * - auto, given the tracks' playfield extents (`contents`), picks the column
 *   count that draws the smallest playfield largest: taiko strips stack, mania
 *   stages and osu! fields sit side by side when that makes them bigger. Without
 *   extents it is side by side for two tracks and a grid for more.
 * Ties go to fewer empty cells, then fewer columns.
 */
export function gridFor(
  count: number,
  width: number,
  height: number,
  layout: Layout,
  contents?: readonly Rect[],
) {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (layout === "auto" && !contents?.length) layout = count <= 2 ? "side-by-side" : "grid";
  if (layout === "stacked" || (layout === "side-by-side" && height > width))
    return { columns: 1, rows: count };
  if (layout === "side-by-side") return { columns: count, rows: 1 };
  let best = { columns: 1, rows: count, score: -1, empty: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cell = {
      x: 0,
      y: 0,
      width: (width - CELL_GAP * (columns - 1)) / columns,
      height: (height - CELL_GAP * (rows - 1)) / rows,
    };
    const score =
      layout === "auto"
        ? Math.min(...contents!.map((content) => fitScale(cell, content)))
        : Math.min(cell.width, cell.height);
    const empty = columns * rows - count;
    // Within 1 % counts as equal: prefer filled grids, then fewer columns.
    if (score > best.score * 1.01 || (score >= best.score * 0.99 && empty < best.empty))
      best = { columns, rows, score, empty };
  }
  return { columns: best.columns, rows: best.rows };
}

/** One cell per track, row by row, in whole output pixels. `contents` (the
 *  tracks' playfield extents) let `auto` fit the playfields. In `overlap`
 *  every track's cell is the whole frame. */
export function layoutCells(
  count: number,
  width: number,
  height: number,
  layout: Layout,
  contents?: readonly Rect[],
): Rect[] {
  if (!Number.isInteger(count) || count < 1 || count > 16 || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2)
    throw new Error("Invalid layout dimensions");
  if (layout === "overlap") return Array.from({ length: count }, () => ({ x: 0, y: 0, width, height }));
  const { columns, rows } = gridFor(count, width, height, layout, contents);
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
 * The cell corner each layer hangs from, as in lazer's legacy HUD: health bar
 * top left, score top right with accuracy under it, combo bottom left. A
 * layer's margins (`hud.<layer>.margin_x`/`.margin_y`) are its distance from
 * that corner into the cell in lazer UI units (`uiUnit`), except accuracy's
 * vertical margin, which is measured from the score layer's bottom edge.
 */
export const HUD_ANCHOR: Record<HudKey, { x: 0 | 1; y: 0 | 1 }> = {
  score: { x: 1, y: 0 },
  accuracy: { x: 1, y: 0 },
  combo: { x: 0, y: 1 },
  health: { x: 0, y: 0 },
};
/** A HUD layer's size at scale 1, lazer UI units. */
export interface Size {
  width: number;
  height: number;
}
/** Output pixels per lazer UI unit in `cell`: osu! scales its interface to fit 1024×768 inside the screen. */
export const uiUnit = (cell: Rect) => Math.min(cell.width / 1024, cell.height / 768);
/** Output pixels per spacing unit of the studio's own marks (overlap legend, name tags, overlay spots): the short side over 1080. */
export const hudUnit = (cell: Rect) => Math.min(cell.width, cell.height) / 1080;
/** Output-pixel box of a HUD layer of `size` placed at `transform` (`x`/`y`:
 *  margins, lazer UI units) in `cell`; `below` is the score's box, which
 *  accuracy hangs under. */
export function hudBox(cell: Rect, key: HudKey, transform: Transform, size: Size, below?: Rect): Rect {
  const anchor = HUD_ANCHOR[key],
    unit = uiUnit(cell);
  const width = size.width * unit * transform.scale,
    height = size.height * unit * transform.scale;
  return {
    x: anchor.x ? cell.x + cell.width - transform.x * unit - width : cell.x + transform.x * unit,
    y: below
      ? below.y + below.height + transform.y * unit
      : anchor.y
        ? cell.y + cell.height - transform.y * unit - height
        : cell.y + transform.y * unit,
    width,
    height,
  };
}
/** The transform that puts a HUD layer of `size` at `box`; its height decides the scale. */
export function hudTransformFor(cell: Rect, key: HudKey, box: Rect, size: Size, below?: Rect): Transform {
  const anchor = HUD_ANCHOR[key],
    unit = uiUnit(cell);
  return {
    x: (anchor.x ? cell.x + cell.width - box.x - box.width : box.x - cell.x) / unit,
    y: (below
      ? box.y - below.y - below.height
      : anchor.y
        ? cell.y + cell.height - box.y - box.height
        : box.y - cell.y) / unit,
    scale: box.height / (size.height * unit),
  };
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/**
 * Where a `width`×`height` box fits inside every cell without touching any of
 * that cell's obstacles (playfield, HUD layers, other overlays; kept `margin`
 * apart), as an offset from the cells' corner. Rows are tried top to bottom,
 * each left to right, in steps of `step` pixels. Null when nothing is free.
 */
export function freeSpot(
  cells: readonly { cell: Rect; obstacles: readonly Rect[] }[],
  width: number,
  height: number,
  { step = 8, margin = 8 } = {},
): { x: number; y: number } | null {
  if (!cells.length) return null;
  const room = {
    width: Math.min(...cells.map((c) => c.cell.width)),
    height: Math.min(...cells.map((c) => c.cell.height)),
  };
  for (let y = margin; y + height + margin <= room.height; y += step)
    for (let x = margin; x + width + margin <= room.width; x += step) {
      const free = cells.every(({ cell, obstacles }) => {
        const box = { x: cell.x + x - margin, y: cell.y + y - margin, width: width + 2 * margin, height: height + 2 * margin };
        return !obstacles.some((obstacle) => overlaps(box, obstacle));
      });
      if (free) return { x, y };
    }
  return null;
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
 * `drawnWidth` is the world width, centred on x = 256, that the playfield
 * draws (see `drawnWidth`): a mania stage's StageLeft/StageRight images can
 * reach past the view. The target covers it up to the cell's width, as the
 * client draws them up to the screen's edges.
 */
export function place(
  cell: Rect,
  content: Rect,
  transform: Transform,
  texture?: { width: number; height: number },
  drawnWidth = VIEW.width,
): Placement {
  const ceiling = MAX_TARGET / Math.max(VIEW.width, VIEW.height);
  const scale = fitScale(cell, content) * transform.scale;
  const targetScale = Math.min(scale, ceiling);
  // At least the view: a wider target keeps the renderer's height-fitted
  // scale (`viewScale`), so only the covered width changes.
  const covered = Math.max(VIEW.width, Math.min(drawnWidth, cell.width / scale));
  const target = {
    width: Math.max(2, Math.min(MAX_TARGET, Math.round(covered * targetScale))),
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

/** Where world point (`x`, `y`) of a playfield placed at `transform` in
 *  `cell` lands, in output pixels; `shift` is render-core's playfield shift in
 *  world units (osu! gameplay draws 8 lower). */
export function worldToOutput(
  cell: Rect,
  content: Rect,
  transform: Transform,
  x: number,
  y: number,
  shift = 0,
): { x: number; y: number; scale: number } {
  const scale = fitScale(cell, content) * transform.scale;
  return {
    x: cell.x + cell.width * (0.5 + transform.x) + (x - (content.x + content.width / 2)) * scale,
    y: cell.y + cell.height * (0.5 + transform.y) + (y + shift - (content.y + content.height / 2)) * scale,
    scale,
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

/** The world width, centred on x = 256, holding every pixel with alpha above
 *  `threshold` of an RGBA image drawn at 1 px per world unit with x = 256 at
 *  its centre; at least the view's width. */
export function drawnWidth(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = 8,
): number {
  let left = width,
    right = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[(y * width + x) * 4 + 3] > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
  if (right < left) return VIEW.width;
  return Math.max(VIEW.width, 2 * Math.max(width / 2 - left, right + 1 - width / 2));
}

/**
 * The extent a playfield is fitted by. A mania stage always spans the full
 * view height, so only its measured width is used: transparent rows at the top
 * or bottom of a skin's stage (or notes present at the probe time) must not
 * change the scale, or two tracks with the same skin would draw their stages at
 * different sizes and hit positions. The width is made symmetric about the
 * stage centre (x = 256): lazer always centres the stage, so decorations wider
 * on one side (StageLeft/StageRight images) must not move it. Other rulesets
 * use the measured box.
 */
export function fitBounds(mode: number, measured: Rect): Rect {
  if (mode !== 3) return measured;
  const half = Math.max(256 - measured.x, measured.x + measured.width - 256);
  return { x: 256 - half, width: 2 * half, y: VIEW.y, height: VIEW.height };
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
