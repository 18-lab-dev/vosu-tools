import type { Beatmap, Point } from "@vosu-tools/osu-parse";

/**
 * How osu!lazer sees a decoded osu! beatmap before conversion: single-precision
 * difficulty values, control points resolved the way `LegacyBeatmapDecoder`
 * resolves lines that share a time, and hit objects with their node sounds.
 */

export const f32 = Math.fround;

/** .NET `Math.Round` / `MathF.Round`: midpoints go to the even neighbour. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value),
    diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `Precision.AlmostEquals(double, double)` with osu!framework's default epsilon. */
export const almostEquals = (a: number, b: number, epsilon = 1e-7): boolean =>
  Math.abs(a - b) <= epsilon;

export const Sound = { normal: 1, whistle: 2, finish: 4, clap: 8 } as const;

interface Timed {
  time: number;
}
export interface TimingLine extends Timed {
  beatLength: number;
}
export interface DifficultyLine extends Timed {
  sliderVelocity: number;
}
export interface EffectLine extends Timed {
  kiai: boolean;
  scrollSpeed: number;
}

/** The latest point at or before `time`, else `fallback`. */
export function pointAt<T extends Timed>(
  points: readonly T[],
  time: number,
  fallback: T,
): T {
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo ? points[lo - 1] : fallback;
}

export interface ControlPoints {
  timing: TimingLine[];
  difficulty: DifficultyLine[];
  effect: EffectLine[];
}

/**
 * `ControlPointInfo.Add`: a point that changes nothing at its time is dropped,
 * one at an existing point's exact time replaces it.
 */
export function addControlPoint<T extends Timed>(
  list: T[],
  point: T,
  isRedundant: (existing: T | undefined) => boolean,
): void {
  let lo = 0,
    hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].time <= point.time) lo = mid + 1;
    else hi = mid;
  }
  const existing = lo ? list[lo - 1] : undefined;
  if (isRedundant(existing)) return;
  if (existing?.time === point.time) list[lo - 1] = point;
  else list.splice(lo, 0, point);
}

/**
 * `LegacyBeatmapDecoder`'s timing section: lines are taken in file order and
 * consecutive lines at one time are flushed together (the first uninherited
 * line sets the beat length; the last inherited line, else that uninherited
 * line, sets slider velocity and kiai), each point then added only if it
 * changes something at its time.
 */
export function controlPoints(map: Beatmap): ControlPoints {
  const out: ControlPoints = { timing: [], difficulty: [], effect: [] };
  const lines = [...map.timing].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (let start = 0; start < lines.length;) {
    let end = start + 1;
    while (end < lines.length && lines[end].time === lines[start].time) end++;
    const group = lines.slice(start, end),
      time = group[0].time,
      red = group.find((l) => l.uninherited),
      greens = group.filter((l) => !l.uninherited),
      winner = greens.length ? greens[greens.length - 1] : red!;
    if (red)
      addControlPoint(
        out.timing,
        { time, beatLength: Math.min(60000, Math.max(6, red.beatLength)) },
        () => false,
      );
    const sliderVelocity =
      winner.beatLength < 0
        ? Math.min(10, Math.max(0.1, 100 / -winner.beatLength))
        : 1;
    addControlPoint(
      out.difficulty,
      { time, sliderVelocity },
      (e) => (e?.sliderVelocity ?? 1) === sliderVelocity,
    );
    // osu! maps never carry scroll speed on effect points: only kiai matters.
    const kiai = !!(winner.effects & 1);
    addControlPoint(
      out.effect,
      { time, kiai, scrollSpeed: 1 },
      (e) => (e?.kiai ?? false) === kiai && (e?.scrollSpeed ?? 1) === 1,
    );
    start = end;
  }
  return out;
}

export function timingPointAt(points: ControlPoints, time: number): TimingLine {
  return pointAt(
    points.timing,
    time,
    points.timing[0] ?? { time: 0, beatLength: 1000 },
  );
}
export function sliderVelocityAt(points: ControlPoints, time: number): number {
  return pointAt(points.difficulty, time, { time: 0, sliderVelocity: 1 })
    .sliderVelocity;
}
export function effectAt(points: ControlPoints, time: number): EffectLine {
  return pointAt(points.effect, time, { time: 0, kiai: false, scrollSpeed: 1 });
}

/** `LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength`. */
export function precisionAdjustedBeatLength(
  sliderVelocity: number,
  beatLength: number,
  ruleset: "taiko" | "mania" | "fruits",
): number {
  const max = ruleset === "fruits" ? 1000 : 10000;
  const asBeatLength = -100 / sliderVelocity;
  const multiplier =
    asBeatLength < 0
      ? Math.min(max, Math.max(10, f32(-asBeatLength))) / 100
      : 1;
  return beatLength * multiplier;
}

export type LegacyKind = "circle" | "slider" | "spinner" | "hold";

export interface LegacyObject {
  kind: LegacyKind;
  time: number;
  /** End time of spinners and holds; sliders compute theirs per ruleset. */
  endTime: number;
  x: number;
  y: number;
  sound: number;
  /** Slider node sounds: head, every repeat, tail. */
  nodeSounds: number[];
  /** Slider spans after lazer's zero-length guard. */
  spans: number;
  /** The file's pixel length, or `null` when it was absent/zero. */
  expectedDistance: number | null;
  /** Absolute slider path, as flattened and length-fitted by osu-parse. */
  path: Point[];
  /** `SliderPath.Distance`: the declared length once the path was fitted to it. */
  distance: number;
  /** Absolute slider control points from the file. */
  controlPoints: Point[];
  /** Difficulty-point slider velocity at the object's start. */
  sliderVelocity: number;
  /** The file's new-combo flag (type bit 2), forced on the first object after a break. */
  newCombo: boolean;
}

export interface LegacyBeatmap {
  source: Beatmap;
  formatVersion: number;
  hp: number;
  cs: number;
  od: number;
  ar: number;
  sliderMultiplier: number;
  sliderTickRate: number;
  points: ControlPoints;
  objects: LegacyObject[];
  totalBreakTime: number;
}

const pathLength = (path: readonly Point[]): number => {
  let length = 0;
  for (let i = 1; i < path.length; i++)
    length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return length;
};

/**
 * lazer stores the declared length itself as the fitted path's distance; only
 * a path left unextended (its last two points coincide) or collapsed to a
 * single point keeps its own length.
 */
function sliderDistance(path: readonly Point[], expected: number | null) {
  const length = pathLength(path);
  if (expected === null || path.length < 2) return length;
  const last = path[path.length - 1],
    previous = path[path.length - 2];
  if (last.x === previous.x && last.y === previous.y && length < expected)
    return length;
  return expected;
}

/** Reads an osu!-ruleset beatmap the way lazer's decoder hands it to converters. */
export function legacyBeatmap(map: Beatmap): LegacyBeatmap {
  const points = controlPoints(map),
    lazerPositions = map.format >= 128;
  // LegacyBeatmapDecoder forces a new combo on the first object after a break.
  const breaks = [...map.breaks].sort((a, b) => a[0] - b[0]);
  let nextBreak = 0;
  const objects = map.objects.map((o): LegacyObject => {
    let afterBreak = false;
    while (nextBreak < breaks.length && breaks[nextBreak][1] < o.time) {
      afterBreak = true;
      nextBreak++;
    }
    const kind: LegacyKind =
      o.type & 2
        ? "slider"
        : o.type & 8
          ? "spinner"
          : o.type & 128
            ? "hold"
            : "circle";
    const expected = kind === "slider" && o.length > 0 ? o.length : null,
      distance = kind === "slider" ? sliderDistance(o.path, expected) : 0;
    let spans = kind === "slider" ? Math.max(1, o.repeats) : 1;
    let nodeSounds: number[] = [];
    if (kind === "slider") {
      nodeSounds = Array.from({ length: spans + 1 }, (_, i) => {
        const value = o.edgeSounds[i];
        return value === undefined
          ? o.sound
          : Number.isFinite(value)
            ? value
            : 0;
      });
      // Zero-length sliders lose their repeats (lazer's anti-exploit guard).
      if (almostEquals(distance, 0)) {
        spans = 1;
        nodeSounds = [nodeSounds[0], nodeSounds[nodeSounds.length - 1]];
      }
    }
    return {
      kind,
      time: o.time,
      endTime:
        kind === "spinner" || kind === "hold"
          ? Math.max(o.time, o.endTime)
          : o.time,
      x: lazerPositions ? f32(o.x) : Math.trunc(o.x),
      y: lazerPositions ? f32(o.y) : Math.trunc(o.y),
      sound: o.sound,
      nodeSounds,
      spans,
      expectedDistance: expected,
      path: o.path,
      distance,
      controlPoints: o.controlPoints ?? (o.path.length ? [o.path[0]] : []),
      sliderVelocity: sliderVelocityAt(points, o.time),
      newCombo: (o.type & 4) !== 0 || afterBreak,
    };
  });
  return {
    source: map,
    formatVersion: map.format,
    hp: f32(map.difficulty.hp),
    cs: f32(map.difficulty.cs),
    od: f32(map.difficulty.od),
    ar: f32(map.difficulty.ar),
    sliderMultiplier: map.difficulty.sliderMultiplier,
    sliderTickRate: map.difficulty.sliderTickRate,
    points,
    objects,
    totalBreakTime: map.breaks.reduce(
      (sum, [start, end]) => sum + Math.max(0, end - start),
      0,
    ),
  };
}
