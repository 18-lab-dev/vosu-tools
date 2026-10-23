// Timeline gestures as a small state machine, independent of the DOM.
//
//   press on a section edge          → resize that section
//   Shift+press on a section         → move that section
//   Shift+press elsewhere            → create a section
//   any other press (incl. playhead) → scrub: the playhead follows the pointer
//
// A press released without moving past the threshold is a click: it seeks,
// except on a section edge (nothing happens).
import type { Range } from './time';

export const MIN_RANGE_MS = 250;
export const DRAG_THRESHOLD_PX = 4;

export type Target = { kind: 'edge'; index: number; edge: 'start' | 'end' } | { kind: 'range'; index: number } | { kind: 'empty' };
export type Mode = 'resize' | 'move' | 'create' | 'scrub';

export function modeFor(target: Target, shift: boolean): Mode {
  if (target.kind === 'edge') return 'resize';
  if (shift) return target.kind === 'range' ? 'move' : 'create';
  return 'scrub';
}

/** What a pointer move or release does. */
export type Effect =
  | { kind: 'none' }
  | { kind: 'scrub'; time: number }
  | { kind: 'seek'; time: number }
  | { kind: 'ranges'; ranges: Range[] }
  | { kind: 'commit'; ranges: Range[] };

export class Gesture {
  readonly mode: Mode;
  #moved = false;
  #ranges: Range[];

  constructor(
    readonly target: Target,
    shift: boolean,
    private readonly originX: number,
    private readonly originTime: number,
    private readonly ranges: readonly Range[],
    private readonly duration: number,
  ) {
    this.mode = modeFor(target, shift);
    this.#ranges = ranges.map((r) => ({ ...r }));
  }

  get moved(): boolean {
    return this.#moved;
  }

  /** The pointer moved to `x` (px), at source time `time` (ms). */
  move(x: number, time: number): Effect {
    if (!this.#moved && Math.abs(x - this.originX) < DRAG_THRESHOLD_PX) return { kind: 'none' };
    this.#moved = true;
    if (this.mode === 'scrub') return { kind: 'scrub', time };
    this.#ranges = this.#apply(time);
    return { kind: 'ranges', ranges: this.#ranges.map((r) => ({ ...r })) };
  }

  /** The pointer was released at source time `time` (ms). */
  end(time: number): Effect {
    if (!this.#moved) return this.target.kind === 'edge' ? { kind: 'none' } : { kind: 'seek', time };
    if (this.mode === 'scrub') return { kind: 'seek', time };
    return { kind: 'commit', ranges: this.#ranges.map((r) => ({ ...r })) };
  }

  #apply(t: number): Range[] {
    const next = this.ranges.map((r) => ({ ...r }));
    const target = this.target;
    if (this.mode === 'resize' && target.kind === 'edge') {
      const r = next[target.index];
      if (target.edge === 'start') r.start_ms = Math.max(0, Math.min(t, r.end_ms - MIN_RANGE_MS));
      else r.end_ms = Math.min(this.duration, Math.max(t, r.start_ms + MIN_RANGE_MS));
    } else if (this.mode === 'move' && target.kind === 'range') {
      const r = next[target.index];
      const length = r.end_ms - r.start_ms;
      const start = Math.min(Math.max(0, r.start_ms + t - this.originTime), Math.max(0, this.duration - length));
      r.start_ms = start;
      r.end_ms = start + length;
    } else if (this.mode === 'create') {
      const start = Math.min(this.originTime, t);
      next.push({ start_ms: start, end_ms: Math.max(this.originTime, t, start + MIN_RANGE_MS) });
    }
    return next.sort((a, b) => a.start_ms - b.start_ms);
  }
}

/** Keyboard nudge for the playhead: ±1 s, ±5 s with Shift; Home/End jump. */
export function nudge(key: string, shift: boolean, time: number, duration: number): number | null {
  const step = shift ? 5000 : 1000;
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  if (key === 'ArrowLeft') return clamp(time - step);
  if (key === 'ArrowRight') return clamp(time + step);
  if (key === 'Home') return 0;
  if (key === 'End') return duration;
  return null;
}
