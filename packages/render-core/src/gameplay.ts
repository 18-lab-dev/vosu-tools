/**
 * Gameplay elements a replay's input drives, as osu!lazer draws them with
 * legacy skins. Ported from ppy/osu at 2026.1005.0-lazer (MIT): the taiko
 * input drum (`LegacyInputDrum`), the osu!catch catcher's dash trails
 * (`CatcherArea`, `CatcherTrail`), the mania key and column light timing
 * (`LegacyKeyArea`, `LegacyColumnBackground`) and the osu! cursor
 * (`LegacyCursor`, `OsuCursor`, `LegacyCursorTrail`, `CursorTrail`).
 *
 * Everything is a function of the input and the time, so frames can be
 * rendered in any order.
 */
import type { InputFrame } from "./scene";
import { Profile, type Marks } from "./judgements";

/** `OsuPlayfieldAdjustmentContainer.PlayfieldShift`: 8 osu! pixels down. */
export const PLAYFIELD_SHIFT = 8;

export interface Interval {
  start: number;
  end: number;
}

/** Index of the last frame at or before `time`, or -1. */
export function frameIndex(input: readonly InputFrame[], time: number): number {
  let lo = 0,
    hi = input.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (input[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The input's position at `time`, linearly between frames (lazer's replay handlers). */
export function positionAt(
  input: readonly InputFrame[],
  time: number,
): { x: number; y: number } {
  if (!input.length) return { x: 256, y: 192 };
  const i = frameIndex(input, time);
  if (i < 0) return { x: input[0].x, y: input[0].y };
  if (i >= input.length - 1) return { x: input[i].x, y: input[i].y };
  const p = input[i],
    q = input[i + 1],
    f = q.time > p.time ? (time - p.time) / (q.time - p.time) : 1;
  return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
}

/** Where `held(frame)` holds, as merged [press, release) intervals. */
export function heldIntervals(
  input: readonly InputFrame[],
  held: (frame: InputFrame) => boolean,
): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const frame of input) {
    const down = held(frame);
    if (down && start === null) start = frame.time;
    else if (!down && start !== null) {
      out.push({ start, end: frame.time });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: Infinity });
  return out;
}

/** osu!mania: each column's key presses (a frame's x holds the pressed columns). */
export function pressIntervals(
  input: readonly InputFrame[],
  columns: number,
): Interval[][] {
  return Array.from({ length: columns }, (_, lane) =>
    heldIntervals(input, (f) => ((Math.trunc(f.x) >>> lane) & 1) !== 0),
  );
}

/** Times the given key bit goes down. */
export function presses(input: readonly InputFrame[], bit: number): number[] {
  const out: number[] = [];
  let previous = 0;
  for (const frame of input) {
    if (frame.keys & bit && !(previous & bit)) out.push(frame.time);
    previous = frame.keys;
  }
  return out;
}

/** Whether `time` falls inside one of the sorted `intervals`. */
export function within(intervals: readonly Interval[], time: number): boolean {
  let lo = 0,
    hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid].start <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && time < intervals[lo - 1].end;
}

const outQuad = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * osu!taiko: `LegacyInputDrum`'s half drums flash on every press of their
 * action: `FadeTo(1, 80 × (1 - alpha), out)`, then from 100 ms a 50 ms fade
 * out. A press during a flash restarts it from the alpha it had reached.
 */
export function drumFlashes(
  input: readonly InputFrame[],
  marks: Marks,
  /** Playfield units (from the playfield's top-left) to world. */
  px: (x: number) => number,
  py: (y: number) => number,
  /** World units per playfield unit. */
  scale: number,
  skinVersion: number,
): void {
  const inner = marks.size("taiko-drum-inner"),
    outer = marks.size("taiko-drum-outer");
  // TaikoReplayFrame.FromLegacy: Left1 left centre, Right1 left rim, Left2
  // right centre, Right2 right rim. Positions as LegacyInputDrum sets them,
  // in the drum's 180-unit width (the right half is mirrored about it).
  const ratio = 1.6,
    adjust = 180 / ratio,
    modern = skinVersion >= 2.1,
    leftCentre = modern ? 0 : 18 * ratio,
    leftRim = modern ? 0 : 8 * ratio,
    rightCentre = 180 - (modern ? (adjust - 56) * ratio : (adjust - 54) * ratio),
    rightRim = 180 - (modern ? (adjust - 56) * ratio : (adjust - 53) * ratio),
    centreTop = modern ? 0 : 31 * ratio,
    rimTop = modern ? 0 : 23 * ratio;
  const halves = [
    { bit: 1, asset: "taiko-drum-inner", size: inner, left: leftCentre, top: centreTop, mirror: false },
    { bit: 2, asset: "taiko-drum-outer", size: outer, left: leftRim, top: rimTop, mirror: true },
    { bit: 4, asset: "taiko-drum-inner", size: inner, left: rightCentre, top: centreTop, mirror: true },
    { bit: 8, asset: "taiko-drum-outer", size: outer, left: rightRim, top: rimTop, mirror: false },
  ];
  for (const half of halves) {
    const [w, h] = half.size;
    if (w <= 0 || h <= 0) continue;
    const times = presses(input, half.bit);
    let previous: number | null = null,
      previousStart = 0;
    for (let i = 0; i < times.length; i++) {
      const time = times[i];
      // The alpha the previous flash had reached when this press came.
      let start = 0;
      if (previous !== null) {
        const dt = time - previous,
          down = 80 * (1 - previousStart);
        start =
          (dt < down
            ? previousStart + (1 - previousStart) * outQuad(dt / down)
            : 1) * Math.max(0, Math.min(1, 1 - (dt - 100) / 50));
      }
      marks.put({
        asset: half.asset,
        x: px(half.left + w / 2),
        y: py(half.top + h / 2),
        w: (half.mirror ? -w : w) * scale,
        h: h * scale,
        time,
        until: Math.min(time + 150, times[i + 1] ?? Infinity),
        profile: Profile.drumFlash,
        p1: start,
        fps: 0,
      });
      previous = time;
      previousStart = start;
    }
  }
}

/** osu!catch: `CatchReplayFrame.FromLegacy` dashes on exactly `Left1`. */
export const isDashing = (frame: InputFrame) => frame.keys === 1;

/** A per-frame sprite: world centre, size and turn (radians). */
export interface CursorSprite {
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  alpha: number;
  additive: boolean;
}

export interface CursorSkin {
  /** Display sizes (SD units) of the images the skin has. */
  size: (asset: string) => [number, number] | undefined;
  /** skin.ini [General]: CursorCentre, CursorRotate, CursorExpand, CursorTrailRotate (default on). */
  centre: boolean;
  rotate: boolean;
  expand: boolean;
  trailRotate: boolean;
}

/**
 * The osu! cursor from a replay: `LegacyCursor` (cursor turning once every
 * 10 s, expanding to 1.3 × over 100 ms (out quad) on each button press and
 * back when all are released; cursormiddle on top) and `LegacyCursorTrail`:
 * with a cursormiddle, an additive trail of parts every `width / 2.5` along
 * the path that fade over 500 ms; without, a part every 1/60 s that fades
 * over 150 ms. Parts turn with the cursor (CursorTrailRotate).
 */
export class CursorModel {
  /** Expand (+1) and contract (-1) events with the scale each starts from. */
  private readonly changes: { time: number; kind: 1 | -1; from: number }[] = [];
  /** Path length up to each input frame. */
  private readonly travelled: number[] = [];
  constructor(
    private readonly input: readonly InputFrame[],
    private readonly skin: CursorSkin,
  ) {
    // OsuReplayFrame: Left1|Left2 left button, Right1|Right2 right button.
    let previous = 0;
    for (const frame of input) {
      const left = frame.keys & 5,
        right = frame.keys & 10,
        wasLeft = previous & 5,
        wasRight = previous & 10;
      if ((left && !wasLeft) || (right && !wasRight))
        this.changes.push({ time: frame.time, kind: 1, from: 1 });
      else if (!(left || right) && (wasLeft || wasRight))
        this.changes.push({
          time: frame.time,
          kind: -1,
          from: this.scaleAt(frame.time),
        });
      previous = frame.keys;
    }
    let total = 0;
    for (let i = 0; i < input.length; i++) {
      if (i)
        total += Math.hypot(
          input[i].x - input[i - 1].x,
          input[i].y - input[i - 1].y,
        );
      this.travelled.push(total);
    }
  }
  /** `ExpandTarget`'s scale at `time`. */
  scaleAt(time: number): number {
    if (!this.skin.expand) return 1;
    let lo = 0,
      hi = this.changes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.changes[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    const change = this.changes[lo - 1];
    if (!change) return 1;
    const t = outQuad(Math.min(1, (time - change.time) / 100));
    return change.kind === 1 ? 1 + 0.3 * t : change.from + (1 - change.from) * t;
  }
  /** LegacyCursor spins clockwise once every 10 s. */
  rotationAt(time: number): number {
    return this.skin.rotate ? ((time / 10000) % 1) * 2 * Math.PI : 0;
  }
  /** Path length travelled by `time`. */
  private distanceAt(time: number): number {
    const i = frameIndex(this.input, time);
    if (i < 0) return 0;
    if (i >= this.input.length - 1) return this.travelled[i];
    const p = this.input[i],
      q = this.input[i + 1],
      f = q.time > p.time ? (time - p.time) / (q.time - p.time) : 1;
    return this.travelled[i] + (this.travelled[i + 1] - this.travelled[i]) * f;
  }
  /** Time and place the path reaches `distance`, at or after frame `from`. */
  private pointAt(distance: number, from: number): { time: number; x: number; y: number; index: number } {
    let i = from;
    while (i < this.input.length - 2 && this.travelled[i + 1] < distance) i++;
    const p = this.input[i],
      q = this.input[Math.min(this.input.length - 1, i + 1)],
      span = this.travelled[Math.min(this.input.length - 1, i + 1)] - this.travelled[i],
      f = span > 0 ? Math.max(0, Math.min(1, (distance - this.travelled[i]) / span)) : 0;
    return {
      time: p.time + (q.time - p.time) * f,
      x: p.x + (q.x - p.x) * f,
      y: p.y + (q.y - p.y) * f,
      index: i,
    };
  }
  /**
   * Sprites to draw at `time`, back to front, at `cursorScale` (the
   * gameplay cursor size); at most `limit`.
   */
  sprites(time: number, cursorScale: number, limit: number): CursorSprite[] {
    const out: CursorSprite[] = [];
    if (!this.input.length) return out;
    const { x, y } = positionAt(this.input, time),
      rotation = this.rotationAt(time),
      cursor = this.skin.size("cursor"),
      middle = this.skin.size("cursormiddle"),
      trail = this.skin.size("cursortrail");
    // Sizes are game-space units (NonPlayfieldSprite; the trail texture's
    // ScaleAdjust × 1.6): world units are 1.6 times larger.
    const place = (
      asset: string,
      [w, h]: [number, number],
      px: number,
      py: number,
      scale: number,
      angle: number,
      alpha: number,
      additive: boolean,
    ) => {
      const sw = (w / 1.6) * scale,
        sh = (h / 1.6) * scale;
      // Top-left origin (CursorCentre: false) turns about the corner.
      const ox = this.skin.centre ? 0 : sw / 2,
        oy = this.skin.centre ? 0 : sh / 2;
      out.push({
        asset,
        x: px + ox * Math.cos(angle) - oy * Math.sin(angle),
        y: py + ox * Math.sin(angle) + oy * Math.cos(angle),
        w: sw,
        h: sh,
        angle,
        alpha,
        additive,
      });
    };
    if (trail) {
      const partAngle = this.skin.trailRotate ? rotation : 0;
      if (middle) {
        // Parts every `interval` of path, the newest one interval behind the cursor.
        const interval =
          ((trail[0] / 1.6) * cursorScale) / 2.5 / Math.max(cursorScale, 1);
        if (interval > 0) {
          const end = this.distanceAt(time) - interval,
            begin = this.distanceAt(time - 500);
          let k = Math.max(1, Math.ceil(begin / interval)),
            from = Math.max(0, frameIndex(this.input, time - 500));
          for (; k * interval < end && out.length < limit; k++) {
            const point = this.pointAt(k * interval, from);
            from = point.index;
            const age = time - point.time;
            if (age < 0 || age >= 500) continue;
            place("cursortrail", trail, point.x, point.y, this.scaleAt(point.time) * cursorScale, partAngle, 1 - age / 500, true);
          }
        }
      } else {
        // A part per 1/60 s at the cursor's position then.
        const step = 1000 / 60,
          newest = Math.floor(time / step + 1e-9) * step;
        for (let at = newest - Math.floor(150 / step) * step; at <= newest; at += step) {
          const age = time - at;
          if (age < 0 || age >= 150) continue;
          const p = positionAt(this.input, at);
          place("cursortrail", trail, p.x, p.y, this.scaleAt(at) * cursorScale, partAngle, 1 - age / 150, false);
        }
      }
    }
    while (out.length > Math.max(0, limit - 2)) out.shift();
    if (cursor)
      place("cursor", cursor, x, y, this.scaleAt(time) * cursorScale, rotation, 1, false);
    if (middle) place("cursormiddle", middle, x, y, cursorScale, 0, 1, false);
    return out;
  }
}

/** A small seeded generator (mulberry32) for reproducible stand-ins of lazer's unseeded `RNG`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
