// Multi-selection of per-column value fields (widths, lines, colours, the
// [Mania] form's per-column settings), spreadsheet style like the image
// slots: Ctrl/Cmd+click toggles a column, Shift+click selects the run from
// the anchor, Shift+arrows grow it, Ctrl+A takes the whole row. A selection
// stays inside one row: rows hold different kinds of value (a width, a
// colour, a switch), so one typed value only means something for one row.

export interface RowSelection {
  /** The row's id (`ColumnWidth`, `Colour`, `NoteBodyStyle#`, …); "" for none. */
  row: string;
  /** Selected columns of that row, in the order they were selected. */
  cols: number[];
  /** Where the next Shift range starts. */
  anchor: number | null;
}

export const NONE: RowSelection = { row: "", cols: [], anchor: null };

export const single = (row: string, col: number): RowSelection => ({ row, cols: [col], anchor: col });

export function toggle(selection: RowSelection, row: string, col: number): RowSelection {
  if (selection.row !== row) return single(row, col);
  const cols = selection.cols.includes(col) ? selection.cols.filter((c) => c !== col) : [...selection.cols, col];
  return { row, cols, anchor: col };
}

/** The run from the anchor to `col` (the anchor stays). */
export function range(selection: RowSelection, row: string, col: number): RowSelection {
  if (selection.row !== row || selection.anchor === null) return single(row, col);
  const [from, to] = [selection.anchor, col].sort((a, b) => a - b);
  return { row, cols: Array.from({ length: to - from + 1 }, (_, i) => from + i), anchor: selection.anchor };
}

/** Shift+arrow from `col`: the run from the anchor to the next column. */
export function extend(selection: RowSelection, row: string, col: number, delta: number, length: number): RowSelection {
  const base = selection.row === row && selection.cols.includes(col) ? selection : single(row, col);
  return range(base, row, Math.max(0, Math.min(length - 1, col + delta)));
}

export const all = (row: string, length: number): RowSelection => ({
  row,
  cols: Array.from({ length }, (_, i) => i),
  anchor: 0,
});

/**
 * The columns an edit of `col` in `row` sets: the selection when that cell
 * is part of it, else the cell alone. Sorted.
 */
export function targets(selection: RowSelection, row: string, col: number): number[] {
  const cols = selection.row === row && selection.cols.includes(col) ? selection.cols : [col];
  return [...cols].sort((a, b) => a - b);
}

export const isSelected = (selection: RowSelection, row: string, col: number) =>
  selection.row === row && selection.cols.includes(col);

/** `columns 1, 2 and 5` (1-based). */
export function columnsText(cols: readonly number[]): string {
  const n = [...cols].sort((a, b) => a - b).map((c) => c + 1);
  return n.length === 1 ? `column ${n[0]}` : `columns ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}
