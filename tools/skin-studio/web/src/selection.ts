// Multi-selection of Keymodes slots, spreadsheet style: a click selects one
// slot, Ctrl/Cmd+click toggles one, Shift+click selects the rectangle from
// the anchor (the last slot clicked or toggled), Shift+arrows grow it, and
// Ctrl+A takes every slot of the grid. Ranges stay inside one region (the
// column grid, or the stage-wide images), since a rectangle across both
// means nothing.

export type Cell = readonly [row: number, col: number];

export interface Shape {
  /** The slot key at a cell, or undefined (a value field, or nothing). */
  keyAt(row: number, col: number): string | undefined;
  /** Which region a row belongs to; ranges never cross regions. */
  region(row: number): number;
  /** Every cell of a region, in reading order. */
  cells(region: number): Cell[];
}

export interface Selection {
  /** Selected slot keys, in the order they were selected. */
  keys: string[];
  /** Where the next Shift range starts. */
  anchor: Cell | null;
  /** The slot acted on last (the picker filters by its role). */
  focus: Cell | null;
}

export const EMPTY: Selection = { keys: [], anchor: null, focus: null };

export function single(shape: Shape, cell: Cell): Selection {
  const key = shape.keyAt(...cell);
  return key ? { keys: [key], anchor: cell, focus: cell } : EMPTY;
}

export function toggle(selection: Selection, shape: Shape, cell: Cell): Selection {
  const key = shape.keyAt(...cell);
  if (!key) return selection;
  const keys = selection.keys.includes(key)
    ? selection.keys.filter((k) => k !== key)
    : [...selection.keys, key];
  return { keys, anchor: cell, focus: cell };
}

/** The rectangle from the anchor to `cell` (the anchor stays). */
export function range(selection: Selection, shape: Shape, cell: Cell): Selection {
  const anchor = selection.anchor;
  if (!anchor || shape.region(anchor[0]) !== shape.region(cell[0]))
    return single(shape, cell);
  const [r0, r1] = [anchor[0], cell[0]].sort((a, b) => a - b);
  const [c0, c1] = [anchor[1], cell[1]].sort((a, b) => a - b);
  const keys = shape
    .cells(shape.region(cell[0]))
    .filter(([r, c]) => r >= r0 && r <= r1 && c >= c0 && c <= c1)
    .map(([r, c]) => shape.keyAt(r, c))
    .filter((k): k is string => !!k);
  return { keys, anchor, focus: cell };
}

/** Shift+arrow: moves the range's far corner by `delta`, within the region. */
export function extend(selection: Selection, shape: Shape, delta: Cell): Selection {
  const from = selection.focus ?? selection.anchor;
  if (!from) return selection;
  const region = shape.cells(shape.region(from[0]));
  const rows = region.map(([r]) => r),
    cols = region.map(([, c]) => c);
  const clamp = (v: number, list: number[]) => Math.max(Math.min(...list), Math.min(Math.max(...list), v));
  const to: Cell = [clamp(from[0] + delta[0], rows), clamp(from[1] + delta[1], cols)];
  const base = selection.anchor ? selection : { ...selection, anchor: from };
  return range(base, shape, to);
}

/** Every slot of the region `cell` is in. */
export function all(shape: Shape, cell: Cell): Selection {
  const cells = shape.cells(shape.region(cell[0]));
  return {
    keys: cells.map(([r, c]) => shape.keyAt(r, c)).filter((k): k is string => !!k),
    anchor: cells[0] ?? null,
    focus: cell,
  };
}
