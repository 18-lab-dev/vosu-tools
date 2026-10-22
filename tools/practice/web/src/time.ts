// Time formatting and the trim mapping between source and output map time.
// Windows are in source milliseconds, output_start before the rate change (the
// service's `trim::Window`); output times here are after the rate change.
export type Range = { start_ms: number; end_ms: number };
export type Window = { source_start: number; source_end: number; output_start: number };

export function clock(ms: number, tenths = false): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return tenths
    ? `${minutes}:${(Math.floor(seconds * 10) / 10).toFixed(1).padStart(4, '0')}`
    : `${minutes}:${String(Math.floor(seconds)).padStart(2, '0')}`;
}

/** `m:ss.s`, `ss.s` or `ss` → milliseconds; null when unparseable. */
export function parseClock(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d+(?:\.\d*)?)$/);
  if (!m) return null;
  return Math.round(((m[1] ? Number(m[1]) * 60 : 0) + Number(m[2])) * 1000);
}

/** Source-audio time for an output time, or null inside a gap between sections. */
export function sourceTime(outputMs: number, rate: number, windows: Window[]): number | null {
  const t = outputMs * rate;
  if (!windows.length) return t;
  for (const w of windows) {
    const end = w.output_start + (w.source_end - w.source_start);
    if (t >= w.output_start && t <= end) return t - w.output_start + w.source_start;
  }
  return null;
}

/** Output time for a source time, or null when the source time is trimmed away. */
export function outputTime(sourceMs: number, rate: number, windows: Window[]): number | null {
  if (!windows.length) return sourceMs / rate;
  const w = windows.find((w) => sourceMs >= w.source_start && sourceMs <= w.source_end);
  return w ? (sourceMs - w.source_start + w.output_start) / rate : null;
}
