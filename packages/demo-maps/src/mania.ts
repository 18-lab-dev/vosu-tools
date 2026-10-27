// Generated mania demo maps, one per key count (1K–10K). Every key count gets
// the same 8 s phrase at 120 BPM, laid out over its columns:
//   0–1750     a staircase bouncing across the columns
//   2000–3000  a long-note chord on the outer columns, notes between them
//   3250–3750  mirrored jumps
//   4000–7000  a long hold in the middle column, a short hold beside it and
//              a stream over the remaining columns
//   7250–7750  a closing run and an outer chord
// Columns never overlap themselves, so every key count reads like a chart.

export const MANIA_PERIOD = 8000;
export const MANIA_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

interface Note {
  column: number;
  time: number;
  /** Hold end; notes without one are taps. */
  end?: number;
}

/** 0, 1, …, keys-1, keys-2, …, 1, 0, 1, … */
const bounce = (i: number, keys: number) => {
  if (keys === 1) return 0;
  const span = 2 * (keys - 1);
  const p = i % span;
  return p < keys ? p : span - p;
};

export function maniaNotes(keys: number): Note[] {
  const notes: Note[] = [];
  const last = keys - 1;
  const mid = Math.floor(keys / 2);
  for (let i = 0; i < 8; i++)
    notes.push({ column: bounce(i, keys), time: i * 250 });

  // Long-note chord on the outer columns, taps walking between them.
  notes.push({ column: 0, time: 2000, end: 3000 });
  if (keys > 1) notes.push({ column: last, time: 2000, end: 3000 });
  const inner = Array.from({ length: Math.max(0, keys - 2) }, (_, i) => i + 1);
  for (let i = 0; i < 3 && inner.length; i++)
    notes.push({ column: inner[i % inner.length], time: 2250 + i * 250 });

  // Mirrored jumps (a single note for odd middles and 1K).
  for (let i = 0; i < 3; i++) {
    const column = i % Math.max(1, Math.ceil(keys / 2));
    const mirror = last - column;
    notes.push({ column, time: 3250 + i * 250 });
    if (mirror !== column) notes.push({ column: mirror, time: 3250 + i * 250 });
  }

  // A long hold in the middle; a short one beside it; a stream elsewhere.
  notes.push({ column: mid, time: 4000, end: 7000 });
  const beside = keys > 1 ? (mid + 1) % keys : -1;
  if (beside >= 0) notes.push({ column: beside, time: 5000, end: 5500 });
  const free = Array.from({ length: keys }, (_, c) => c).filter(
    (c) => c !== mid,
  );
  let k = 0;
  for (let time = 4250; time <= 6750 && free.length; time += 250) {
    let column = free[k++ % free.length];
    if (column === beside && time >= 5000 && time <= 5500)
      column = free[k++ % free.length];
    if (column === beside && time >= 5000 && time <= 5500) continue;
    notes.push({ column, time });
  }

  // Closing run and an outer chord.
  notes.push({ column: bounce(keys, keys), time: 7250 });
  notes.push({ column: bounce(keys + 1, keys), time: 7500 });
  notes.push({ column: 0, time: 7750 });
  if (keys > 1) notes.push({ column: last, time: 7750 });
  return notes.sort((a, b) => a.time - b.time || a.column - b.column);
}

/**
 * A still stage for skin editors, drawn at time 0 with the keys up: in every
 * column a note nearest the receptors and a hold (head, body and tail on
 * screen) above it. `times` places them for a skin and scroll speed
 * (render-core's `maniaStillTimes`); the default suits lazer's default speed.
 */
export function maniaStillNotes(
  keys: number,
  times: { note: number; start: number; end: number } = { note: 100, start: 300, end: 900 },
): Note[] {
  return Array.from({ length: keys }, (_, column) => [
    { column, time: Math.round(times.note) },
    { column, time: Math.round(times.start), end: Math.round(times.end) },
  ]).flat();
}

/** The `.osu` text of `notes` (one period of the demo by default) for `keys` columns. */
export function maniaOsu(keys: number, notes = maniaNotes(keys)): string {
  const x = (column: number) => Math.floor(((column + 0.5) * 512) / keys);
  const objects = notes.map((n) =>
    n.end === undefined
      ? `${x(n.column)},192,${n.time},1,0,0:0:0:0:`
      : `${x(n.column)},192,${n.time},128,0,${n.end}:0:0:0:0:`,
  );
  return [
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: none",
    "AudioLeadIn: 0",
    "PreviewTime: -1",
    "Countdown: 0",
    "SampleSet: Soft",
    "StackLeniency: 0.7",
    "Mode: 3",
    "",
    "[Metadata]",
    "Title:Skin studio demo",
    "Artist:18-LAB",
    "Creator:vosu tools",
    `Version:Mania-${keys}K`,
    "Source:",
    "Tags:",
    "",
    "[Difficulty]",
    "HPDrainRate:5",
    `CircleSize:${keys}`,
    "OverallDifficulty:7",
    "ApproachRate:8",
    "SliderMultiplier:1.6",
    "SliderTickRate:2",
    "",
    "[TimingPoints]",
    "0,500,4,2,0,60,1,0",
    "",
    "[HitObjects]",
    ...objects,
    "",
  ].join("\r\n");
}
