import { parse as parseSkinDocument } from "@vosu-tools/skin-spec";

/**
 * Repeated Mania blocks are kept separate, keyed by their explicit Keys entry.
 * Values lose trailing `//` comments, as `LegacyDecoder.StripComments` does
 * for every skin.ini line.
 */
export function parseSkinIni(
  text: string,
): Map<string, Record<string, string>[]> {
  const sections = new Map<string, Record<string, string>[]>();
  for (const line of parseSkinDocument(text).lines) {
    if (line.key === undefined || line.value === undefined) continue;
    let blocks = sections.get(line.section);
    if (!blocks) {
      blocks = [];
      sections.set(line.section, blocks);
    }
    let block = blocks.find((s) => s.__block === String(line.block));
    if (!block) {
      block = { __block: String(line.block) };
      blocks.push(block);
    }
    const comment = line.value.indexOf("//");
    block[line.key] =
      comment < 0 ? line.value : line.value.slice(0, comment).trimEnd();
  }
  return sections;
}

export type Point = { x: number; y: number };
export type Ruleset = 0 | 1 | 2 | 3;
export interface TimingPoint {
  time: number;
  beatLength: number;
  meter: number;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  uninherited: boolean;
  effects: number;
  /** Position in the file's [TimingPoints] section; lazer resolves out-of-order lines in file order. */
  order?: number;
}
export interface HitObject extends Point {
  time: number;
  endTime: number;
  type: number;
  sound: number;
  combo: number;
  number: number;
  stack: number;
  path: Point[];
  /** Absolute slider control points, repeated "red anchor" points merged as lazer does (sliders only). */
  controlPoints?: Point[];
  repeats: number;
  length: number;
  span: number;
  ticks: number[];
  edgeSounds: number[];
  /** Slider node normal/addition sample-set overrides, in file order. */
  edgeSets?: [number, number][];
  sample: string;
}
export interface Beatmap {
  format: number;
  mode: Ruleset;
  general: Record<string, string>;
  metadata: Record<string, string>;
  difficulty: {
    hp: number;
    cs: number;
    od: number;
    ar: number;
    sliderMultiplier: number;
    sliderTickRate: number;
  };
  timing: TimingPoint[];
  objects: HitObject[];
  breaks: [number, number][];
  events: string[];
  colours: [number, number, number][];
  colourSettings?: Record<string, [number, number, number]>;
  duration: number;
  rate: number;
  visualMods: string[];
  /** Catch: Hard Rock's (or Difficulty Adjust's "spicy patterns") fruit offsets. */
  catchHardRockOffsets?: boolean;
}
export interface Mod {
  acronym: string;
  settings?: Record<string, unknown>;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
/** Parse CSV including quoted event filenames. */
export function csv(line: string): string[] {
  return (
    line
      .match(/(?:"(?:[^"]|"")*"|[^,])+(?=,|$)|(?<=,)(?=,|$)/g)
      ?.map((v) => v.trim().replace(/^"|"$/g, "").replace(/""/g, '"')) ?? []
  );
}
/*
 * Slider paths follow osu!lazer (ppy/osu 2026.1005.0-lazer `SliderPath` and
 * `ConvertHitObjectParser`, osu!framework 2026.921.1 `PathApproximator`; MIT):
 * the same segment splitting, curve flattening and length fitting, so path
 * positions (catch fruit, slider ends) agree with the client to sub-pixel.
 */
type CurveKind = "L" | "P" | "B" | "C";
interface CurveType {
  kind: CurveKind;
  /** B-spline degree (lazer-format "B3"); plain Bézier when absent. */
  degree?: number;
}
interface ControlPoint extends Point {
  type?: CurveType;
}
/** First lazer-only .osu format version (`LegacyBeatmapEncoder.FIRST_LAZER_VERSION`). */
const firstLazerVersion = 128;
const bezierTolerance = 0.25;
const catmullDetail = 50;
const circularArcTolerance = 0.1;

function curveType(letter: string): CurveType {
  switch (letter[0]) {
    case "B": {
      const degree = Number(letter.slice(1));
      return letter.length > 1 && Number.isInteger(degree) && degree > 0
        ? { kind: "B", degree }
        : { kind: "B" };
    }
    case "L":
      return { kind: "L" };
    case "P":
      return { kind: "P" };
    default:
      return { kind: "C" };
  }
}
const isLinear = (p0: Point, p1: Point, p2: Point) =>
  Math.abs((p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y)) <=
  1e-3;

/** One typed run of control points, split at repeated points ("red anchors"). */
function convertPoints(
  type: CurveType,
  points: readonly Point[],
  endPoint: Point | undefined,
  format: number,
): ControlPoint[] {
  const vertices: ControlPoint[] = points.map((p) => ({ x: p.x, y: p.y }));
  if (type.kind === "P") {
    const endPointLength = endPoint ? 1 : 0;
    if (format < firstLazerVersion) {
      if (vertices.length + endPointLength !== 3) type = { kind: "B" };
      else if (isLinear(points[0], points[1], endPoint ?? points[2]))
        type = { kind: "L" };
    } else if (vertices.length + endPointLength > 3) type = { kind: "B" };
  }
  if (!vertices.length) return [];
  vertices[0].type = type;
  const out: ControlPoint[] = [];
  let start = 0,
    end = 0;
  while (++end < vertices.length) {
    if (!same(vertices[end], vertices[end - 1])) continue;
    if (type.kind === "C" && end > 1 && format < firstLazerVersion) continue;
    if (end === vertices.length - 1) continue;
    vertices[end - 1].type = type;
    out.push(...vertices.slice(start, end));
    start = end + 1;
  }
  if (start < end) out.push(...vertices.slice(start, end));
  return out;
}

/** `ConvertHitObjectParser.convertPathString`: absolute, typed control points. */
function curveControlPoints(
  curve: string,
  start: Point,
  format: number,
): ControlPoint[] {
  const points: Point[] = [],
    segments: { type: CurveType; start: number }[] = [];
  for (const token of curve.split("|")) {
    if (/^\p{L}/u.test(token)) {
      segments.push({ type: curveType(token), start: points.length });
      if (!points.length) points.push({ x: start.x, y: start.y });
    } else {
      const [x, y] = token.split(":").map(Number);
      points.push(
        format >= firstLazerVersion
          ? { x, y }
          : { x: Math.trunc(x), y: Math.trunc(y) },
      );
    }
  }
  const out: ControlPoint[] = [];
  segments.forEach((segment, i) => {
    const next = segments[i + 1];
    out.push(
      ...convertPoints(
        segment.type,
        points.slice(segment.start, next?.start),
        next ? points[next.start] : undefined,
        format,
      ),
    );
  });
  return out;
}

function bezierSubdivide(points: readonly Point[], count: number) {
  const mid = points.slice(0, count).map((p) => ({ x: p.x, y: p.y })),
    left: Point[] = new Array(count),
    right: Point[] = new Array(count);
  for (let i = 0; i < count; i++) {
    left[i] = mid[0];
    right[count - i - 1] = mid[count - i - 1];
    for (let j = 0; j < count - i - 1; j++)
      mid[j] = {
        x: (mid[j].x + mid[j + 1].x) / 2,
        y: (mid[j].y + mid[j + 1].y) / 2,
      };
  }
  return { left, right };
}
function bezierIsFlatEnough(points: readonly Point[]): boolean {
  for (let i = 1; i < points.length - 1; i++) {
    const x = points[i - 1].x - 2 * points[i].x + points[i + 1].x,
      y = points[i - 1].y - 2 * points[i].y + points[i + 1].y;
    if (x * x + y * y > bezierTolerance * bezierTolerance * 4) return false;
  }
  return true;
}
function bezierApproximate(points: readonly Point[], output: Point[]): void {
  const count = points.length,
    { left, right } = bezierSubdivide(points, count),
    l = [...left, ...right.slice(1)];
  output.push(points[0]);
  for (let i = 1; i < count - 1; i++) {
    const index = 2 * i;
    output.push({
      x: 0.25 * (l[index - 1].x + 2 * l[index].x + l[index + 1].x),
      y: 0.25 * (l[index - 1].y + 2 * l[index].y + l[index + 1].y),
    });
  }
}
/** `PathApproximator.BSplineToPiecewiseLinear` (Bézier when degree = n - 1). */
function bSplineToPiecewiseLinear(
  controlPoints: readonly Point[],
  degree: number,
): Point[] {
  if (controlPoints.length < 2) return controlPoints.slice(0, 1);
  degree = Math.min(degree, controlPoints.length - 1);
  const pointCount = controlPoints.length - 1,
    points = controlPoints.map((p) => ({ x: p.x, y: p.y }));
  const beziers: Point[][] = [];
  if (degree === pointCount) beziers.push(points);
  else {
    for (let i = 0; i < pointCount - degree; i++) {
      const sub: Point[] = new Array(degree + 1);
      sub[0] = { ...points[i] };
      for (let j = 0; j < degree - 1; j++) {
        sub[j + 1] = { ...points[i + 1] };
        for (let k = 1; k < degree - j; k++) {
          const l = Math.min(k, pointCount - degree - i);
          points[i + k] = {
            x: (l * points[i + k].x + points[i + k + 1].x) / (l + 1),
            y: (l * points[i + k].y + points[i + k + 1].y) / (l + 1),
          };
        }
      }
      sub[degree] = { ...points[i + 1] };
      beziers.push(sub);
    }
    beziers.push(points.slice(pointCount - degree));
  }
  // Depth-first: the earliest, left-most piece is always flattened next.
  const toFlatten = beziers.reverse(),
    output: Point[] = [];
  while (toFlatten.length) {
    const parent = toFlatten.pop()!;
    if (bezierIsFlatEnough(parent)) {
      bezierApproximate(parent, output);
      continue;
    }
    const { left, right } = bezierSubdivide(parent, degree + 1);
    toFlatten.push(right, left);
  }
  output.push({ ...controlPoints[pointCount] });
  return output;
}
function catmullPoint(
  v1: Point,
  v2: Point,
  v3: Point,
  v4: Point,
  t: number,
): Point {
  const t2 = t * t,
    t3 = t * t2,
    axis = (a: number, b: number, c: number, d: number) =>
      0.5 *
      (2 * b +
        (-a + c) * t +
        (2 * a - 5 * b + 4 * c - d) * t2 +
        (-a + 3 * b - 3 * c + d) * t3);
  return { x: axis(v1.x, v2.x, v3.x, v4.x), y: axis(v1.y, v2.y, v3.y, v4.y) };
}
function catmullToPiecewiseLinear(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const v1 = i > 0 ? points[i - 1] : points[i],
      v2 = points[i],
      v3 = points[i + 1],
      v4 =
        i < points.length - 2
          ? points[i + 2]
          : { x: 2 * v3.x - v2.x, y: 2 * v3.y - v2.y };
    for (let c = 0; c < catmullDetail; c++) {
      out.push(catmullPoint(v1, v2, v3, v4, c / catmullDetail));
      out.push(catmullPoint(v1, v2, v3, v4, (c + 1) / catmullDetail));
    }
  }
  return out;
}
/** `CircularArcProperties` + `CircularArcToPiecewiseLinear`; undefined → Bézier. */
function circularArc(points: readonly Point[]): Point[] | undefined {
  const [a, b, c] = points;
  if (isLinear(a, b, c)) return undefined;
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)),
    aSq = a.x * a.x + a.y * a.y,
    bSq = b.x * b.x + b.y * b.y,
    cSq = c.x * c.x + c.y * c.y,
    centre = {
      x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
      y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
    },
    radius = distance(a, centre),
    thetaStart = Math.atan2(a.y - centre.y, a.x - centre.x);
  let thetaEnd = Math.atan2(c.y - centre.y, c.x - centre.x);
  while (thetaEnd < thetaStart) thetaEnd += 2 * Math.PI;
  let direction = 1,
    thetaRange = thetaEnd - thetaStart;
  // Which side of AC is B on?
  if ((c.y - a.y) * (b.x - a.x) - (c.x - a.x) * (b.y - a.y) < 0) {
    direction = -1;
    thetaRange = 2 * Math.PI - thetaRange;
  }
  const amount =
    2 * radius <= circularArcTolerance
      ? 2
      : Math.max(
          2,
          Math.ceil(
            thetaRange / (2 * Math.acos(1 - circularArcTolerance / radius)),
          ),
        );
  if (amount >= 1000) return undefined;
  return Array.from({ length: amount }, (_, i) => {
    const theta = thetaStart + (direction * i * thetaRange) / (amount - 1);
    return {
      x: centre.x + Math.cos(theta) * radius,
      y: centre.y + Math.sin(theta) * radius,
    };
  });
}
function subPath(points: readonly Point[], type: CurveType): Point[] {
  switch (type.kind) {
    case "L":
      return points.map((p) => ({ x: p.x, y: p.y }));
    case "P":
      if (points.length === 3) {
        const arc = circularArc(points);
        if (arc) return arc;
      }
      break;
    case "C":
      return catmullToPiecewiseLinear(points);
  }
  return bSplineToPiecewiseLinear(points, type.degree ?? points.length);
}
/** `SliderPath.calculatePath`: flatten each typed segment and join them. */
function flattenControlPoints(controls: readonly ControlPoint[]): Point[] {
  const path: Point[] = [];
  let start = 0;
  for (let i = 0; i < controls.length; i++) {
    if (!controls[i].type && i < controls.length - 1) continue;
    const segment = controls.slice(start, i + 1);
    if (segment.length === 1) path.push({ x: segment[0].x, y: segment[0].y });
    else if (segment.length > 1) {
      const sub = subPath(segment, controls[start].type ?? { kind: "L" });
      const skipFirst =
        path.length > 0 &&
        sub.length > 0 &&
        same(path[path.length - 1], sub[0]);
      for (let j = skipFirst ? 1 : 0; j < sub.length; j++) path.push(sub[j]);
    }
    start = i;
  }
  return path;
}
/** `SliderPath.calculateLength`: trim or extend the path to the declared length. */
function fitLength(path: Point[], expectedLength?: number): Point[] {
  if (expectedLength === undefined || path.length < 1) return path;
  const cumulative = [0];
  for (let i = 1; i < path.length; i++)
    cumulative.push(cumulative[i - 1] + distance(path[i - 1], path[i]));
  const length = cumulative[cumulative.length - 1];
  if (length === expectedLength) return path;
  // osu!stable never extends a path whose last two points coincide.
  if (
    path.length >= 2 &&
    same(path[path.length - 1], path[path.length - 2]) &&
    expectedLength > length
  )
    return path;
  cumulative.pop();
  let end = path.length - 1;
  if (length > expectedLength)
    while (
      cumulative.length &&
      cumulative[cumulative.length - 1] >= expectedLength
    ) {
      cumulative.pop();
      path.pop();
      end--;
    }
  if (end <= 0) return path;
  const from = path[end - 1],
    span = distance(from, path[end]),
    remaining = expectedLength - cumulative[cumulative.length - 1];
  path[end] =
    span > 0
      ? {
          x: from.x + ((path[end].x - from.x) / span) * remaining,
          y: from.y + ((path[end].y - from.y) / span) * remaining,
        }
      : { ...path[end] };
  return path;
}
/**
 * Flatten one slider curve (`kind` + absolute points, start first) and fit it
 * to the declared pixel length, as osu!lazer does. A missing or zero length
 * keeps the curve's own length.
 */
export function sliderPath(
  kind: string,
  points: Point[],
  expectedLength?: number,
  formatVersion = 14,
): Point[] {
  const controls = convertPoints(
    curveType(kind),
    points,
    undefined,
    formatVersion,
  );
  return fitLength(flattenControlPoints(controls), expectedLength || undefined);
}
/** As `sliderPath`, from a whole curve field (`B|x:y|…`, including lazer's multi-segment form). */
export function sliderCurvePath(
  curve: string,
  start: Point,
  expectedLength?: number,
  formatVersion = 14,
): Point[] {
  return fitLength(
    flattenControlPoints(curveControlPoints(curve, start, formatVersion)),
    expectedLength || undefined,
  );
}
export function pathPosition(path: readonly Point[], progress: number): Point {
  if (!path.length) return { x: 256, y: 192 };
  let length = 0;
  for (let i = 1; i < path.length; i++)
    length += distance(path[i - 1], path[i]);
  let remaining = Math.min(1, Math.max(0, progress)) * length;
  for (let i = 1; i < path.length; i++) {
    const d = distance(path[i - 1], path[i]);
    if (remaining <= d)
      return lerp(path[i - 1], path[i], d ? remaining / d : 0);
    remaining -= d;
  }
  return { ...path[path.length - 1] };
}
export function timingAt(
  timing: readonly TimingPoint[],
  time: number,
): { beatLength: number; sv: number; meter: number } {
  let beatLength = 500,
    sv = 1,
    meter = 4;
  for (const p of timing) {
    if (p.time > time) break;
    if (p.uninherited) {
      beatLength = p.beatLength;
      sv = 1;
      meter = p.meter;
    } else sv = Math.max(0.1, Math.min(10, -100 / p.beatLength));
  }
  return { beatLength, sv, meter };
}
/** Taiko's 1.4 velocity factor, expressed in the 640x480 virtual playfield. */
export function taikoVelocity(
  map: Beatmap,
  time: number,
  noteSpeed = 1,
): number {
  const timing = timingAt(map.timing, time);
  return (
    ((140 * map.difficulty.sliderMultiplier * timing.sv) / timing.beatLength) *
    noteSpeed
  );
}
export function approachTime(ar: number): number {
  return ar < 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5);
}
export function circleRadius(cs: number): number {
  return 54.4 - 4.48 * cs;
}
function endPosition(object: HitObject): Point {
  return object.type & 2 && object.repeats % 2 === 1
    ? (object.path[object.path.length - 1] ?? object)
    : object;
}
/** Stable's v6+ backwards stacking. Slider-tail stacks receive negative offsets. */
export function applyStacking(map: Beatmap): void {
  for (const o of map.objects) o.stack = 0;
  if (map.mode !== 0) return;
  const threshold =
      approachTime(map.difficulty.ar) *
      Number(map.general.StackLeniency ?? 0.7),
    objs = map.objects;
  if (map.format < 6) {
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.type & 8) continue;
      let end = o.endTime;
      for (let j = i + 1; j < objs.length; j++) {
        const n = objs[j];
        if (n.time - end > threshold) break;
        if (distance(o, n) < 3) {
          o.stack++;
          end = n.endTime;
        }
      }
    }
    return;
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    let o = objs[i];
    if (o.stack || o.type & 8) continue;
    if (o.type & 1) {
      for (let j = i - 1; j >= 0; j--) {
        const n = objs[j];
        if (n.type & 8) continue;
        if (o.time - n.endTime > threshold) break;
        if (n.type & 2 && distance(endPosition(n), o) < 3) {
          const offset = o.stack - n.stack + 1;
          for (let k = j + 1; k <= i; k++)
            if (distance(endPosition(n), objs[k]) < 3) objs[k].stack -= offset;
          break;
        }
        if (distance(n, o) < 3) {
          n.stack = o.stack + 1;
          o = n;
        }
      }
    } else if (o.type & 2) {
      for (let j = i - 1; j >= 0; j--) {
        const n = objs[j];
        if (n.type & 8) continue;
        if (o.time - n.time > threshold) break;
        if (distance(endPosition(n), o) < 3) {
          n.stack = o.stack + 1;
          o = n;
        }
      }
    }
  }
}
export function parseOsu(text: string): Beatmap {
  const map: Beatmap = {
    format: 14,
    mode: 0,
    general: {},
    metadata: {},
    difficulty: {
      hp: 5,
      cs: 5,
      od: 5,
      ar: 5,
      sliderMultiplier: 1.4,
      sliderTickRate: 1,
    },
    timing: [],
    objects: [],
    breaks: [],
    events: [],
    colours: [],
    colourSettings: {},
    duration: 0,
    rate: 1,
    visualMods: [],
  };
  let section = "",
    combo = -1,
    number = 0;
  const difficulty: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("osu file format v")) {
      map.format = Number(line.slice(17));
      continue;
    }
    if (line.startsWith("[")) {
      section = line.slice(1, -1);
      continue;
    }
    if (["General", "Metadata", "Difficulty", "Colours"].includes(section)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim(),
        value = line.slice(colon + 1).trim();
      if (section === "General") map.general[key] = value;
      else if (section === "Metadata") map.metadata[key] = value;
      else if (section === "Difficulty") difficulty[key] = value;
      else if (/^Combo\d+$/.test(key)) {
        const c = value.split(",").map(Number);
        map.colours.push([c[0] / 255, c[1] / 255, c[2] / 255]);
      } else {
        const c = value.split(",").map(Number);
        if (c.length >= 3 && c.every(Number.isFinite))
          map.colourSettings![key] = [c[0] / 255, c[1] / 255, c[2] / 255];
      }
      continue;
    }
    const p = csv(line);
    if (section === "Events") {
      map.events.push(line);
      if (p[0] === "2" || p[0] === "Break")
        map.breaks.push([Number(p[1]), Number(p[2])]);
    }
    if (section === "TimingPoints") {
      const n = p.map(Number);
      if (!Number.isFinite(n[0]) || !Number.isFinite(n[1]) || n[1] === 0)
        continue;
      map.timing.push({
        time: n[0],
        beatLength: n[1],
        meter: n[2] || 4,
        sampleSet: n[3] || 0,
        sampleIndex: n[4] || 0,
        volume: n[5] ?? 100,
        uninherited: p[6] === undefined || n[6] === 1,
        effects: n[7] || 0,
        order: map.timing.length,
      });
    }
    if (section === "HitObjects") {
      const [x, y, time, type, sound] = p.slice(0, 5).map(Number);
      if (![x, y, time, type, sound].every(Number.isFinite)) continue;
      if (combo < 0 || type & 4) {
        combo += 1 + ((type >> 4) & 7);
        number = 0;
      }
      number++;
      const o: HitObject = {
        x,
        y,
        time,
        endTime: time,
        type,
        sound,
        combo,
        number,
        stack: 0,
        path: [],
        repeats: 1,
        length: 0,
        span: 0,
        ticks: [],
        edgeSounds: [],
        sample: type & 128 ? (p[5]?.split(":").slice(1).join(":") ?? "") : (p[(type & 2) ? 10 : (type & 8) ? 6 : 5] ?? ""),
      };
      if (type & 2) {
        const controls = curveControlPoints(p[5], { x, y }, map.format);
        o.length = Math.max(0, Number(p[7]) || 0);
        o.path = fitLength(
          flattenControlPoints(controls),
          o.length || undefined,
        );
        o.controlPoints = controls.map((point) => ({ x: point.x, y: point.y }));
        o.repeats = Math.max(1, Number(p[6]) || 1);
        // An empty field means "no per-node sounds" (the clients fall back to the object's own).
        o.edgeSounds = p[8] ? p[8].split("|").map(Number) : [];
        o.edgeSets = p[9] ? p[9].split("|").map((pair) => {
          const [normal, addition] = pair.split(":").map(Number);
          return [normal || 0, addition || 0];
        }) : [];
      } else if (type & 8) o.endTime = Number(p[5]) || time;
      else if (type & 128) o.endTime = Number(p[5]?.split(":")[0]) || time;
      map.objects.push(o);
    }
  }
  map.mode = Math.max(0, Math.min(3, Number(map.general.Mode) || 0)) as Ruleset;
  const d = map.difficulty;
  d.hp = Number(difficulty.HPDrainRate ?? 5);
  d.cs = Number(difficulty.CircleSize ?? 5);
  d.od = Number(difficulty.OverallDifficulty ?? 5);
  d.ar = Number(difficulty.ApproachRate ?? d.od);
  d.sliderMultiplier = Number(difficulty.SliderMultiplier ?? 1.4);
  d.sliderTickRate = Number(difficulty.SliderTickRate ?? 1);
  map.timing.sort((a, b) => a.time - b.time);
  map.objects.sort((a, b) => a.time - b.time);
  for (const o of map.objects) {
    if (o.type & 2) {
      const t = timingAt(map.timing, o.time);
      o.span = (o.length * t.beatLength) / (100 * d.sliderMultiplier * t.sv);
      o.endTime = o.time + o.span * o.repeats;
      const tickDistance = (100 * d.sliderMultiplier * t.sv) / d.sliderTickRate;
      for (
        let x = tickDistance;
        x < o.length - 0.01 && o.ticks.length < 10000;
        x += tickDistance
      )
        o.ticks.push(x / o.length);
    }
    map.duration = Math.max(map.duration, o.endTime);
  }
  applyStacking(map);
  return map;
}
/**
 * .NET's seeded `System.Random` (the compatibility algorithm lazer's mods get
 * from `new Random(seed)`): Knuth's subtractive generator.
 */
export class NetRandom {
  private readonly seeds = new Array<number>(56).fill(0);
  private next = 0;
  private nextP = 21;
  constructor(seed: number) {
    const MBIG = 2147483647;
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(Math.trunc(seed));
    let mj = 161803398 - subtraction,
      mk = 1;
    this.seeds[55] = mj;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.seeds[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.seeds[ii];
    }
    for (let k = 1; k < 5; k++)
      for (let i = 1; i < 56; i++) {
        this.seeds[i] -= this.seeds[1 + ((i + 30) % 55)];
        if (this.seeds[i] < 0) this.seeds[i] += MBIG;
      }
  }
  /** `Next()`: an integer in [0, 2^31 - 1). */
  nextInt(): number {
    const MBIG = 2147483647;
    if (++this.next >= 56) this.next = 1;
    if (++this.nextP >= 56) this.nextP = 1;
    let value = this.seeds[this.next] - this.seeds[this.nextP];
    if (value === MBIG) value--;
    if (value < 0) value += MBIG;
    this.seeds[this.next] = value;
    return value;
  }
  /** `Next(max)`: an integer in [0, max). */
  nextBelow(max: number): number {
    return Math.trunc(this.nextInt() * (1 / 2147483647) * max);
  }
}
/** A lazer mod setting as a finite number, if present. */
const numberSetting = (mod: Mod | undefined, key: string): number | undefined => {
  const value = mod?.settings?.[key];
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/**
 * Mods never mutate the parsed source. Rate is metadata: renderAt always
 * receives map milliseconds. Settings follow lazer's mods: rate-adjust
 * `speed_change`, Difficulty Adjust (including extended limits and catch's
 * hard-rock offsets), Mirror's `reflection` (osu!), and seeded Random for
 * mania columns and taiko colours. osu!'s Random and unseeded (osu!stable)
 * Random are approximations for display only.
 */
export function applyMods(
  source: Beatmap,
  mods: readonly Mod[] = [],
  options: { ar?: number; cs?: number; seed?: number } = {},
): Beatmap {
  const map = structuredClone(source),
    has = (s: string) => mods.some((m) => m.acronym.toUpperCase() === s),
    find = (s: string) => mods.find((m) => m.acronym.toUpperCase() === s);
  map.visualMods = mods.map((m) => m.acronym.toUpperCase());
  const d = map.difficulty;
  // lazer's ModEasy/ModHardRock change drain; each ruleset adds its own. Mania
  // keeps OD and key count: its Easy and Hard Rock scale the hit windows.
  if (has("EZ")) {
    if (map.mode !== 3) d.cs *= 0.5;
    d.ar *= 0.5;
    if (map.mode !== 3) d.od *= 0.5;
    d.hp *= 0.5;
    // TaikoModEasy: slower scrolling.
    if (map.mode === 1) d.sliderMultiplier *= 0.8;
  }
  if (has("HR")) {
    if (map.mode === 0 || map.mode === 2) {
      d.cs = Math.min(10, d.cs * 1.3);
      d.ar = Math.min(10, d.ar * 1.4);
    }
    if (map.mode !== 3) d.od = Math.min(10, d.od * 1.4);
    d.hp = Math.min(10, d.hp * 1.4);
    // TaikoModHardRock: faster scrolling.
    if (map.mode === 1) d.sliderMultiplier *= (1.4 * 4) / 3;
    if (map.mode === 2) map.catchHardRockOffsets = true;
  }
  for (const m of mods) {
    const a = m.acronym.toUpperCase(),
      s = m.settings ?? {};
    if (["DT", "NC", "HT", "DC"].includes(a))
      map.rate = Number(
        s.speed_change ?? (["DT", "NC"].includes(a) ? 1.5 : 0.75),
      );
    if (a === "DA") {
      d.ar = numberSetting(m, "approach_rate") ?? d.ar;
      d.cs = numberSetting(m, "circle_size") ?? d.cs;
      d.od = numberSetting(m, "overall_difficulty") ?? d.od;
      d.hp = numberSetting(m, "drain_rate") ?? d.hp;
      if (map.mode === 1) d.sliderMultiplier *= numberSetting(m, "scroll_speed") ?? 1;
      if (map.mode === 2 && s.hard_rock_offsets === true) map.catchHardRockOffsets = true;
    }
  }
  if (options.ar !== undefined) d.ar = options.ar;
  if (options.cs !== undefined) d.cs = options.cs;
  const randomMod = find("RD"),
    netSeed = options.seed ?? numberSetting(randomMod, "seed");
  let seed = (netSeed ?? 1) || 0x6d2b79f5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  // Mania columns: Random and Mirror apply in mod order, like lazer's beatmap mods.
  const keys = Math.max(1, Math.round(d.cs));
  // Mania's conversion mods run first (`IApplicableAfterBeatmapConversion`).
  if (map.mode === 3 && has("IN")) {
    // ManiaModInvert: holds fill the gaps between a column's notes.
    const columnOf = (o: HitObject) => Math.min(keys - 1, Math.floor((o.x * keys) / 512));
    const columns = new Map<number, HitObject[]>();
    for (const o of map.objects) columns.set(columnOf(o), [...(columns.get(columnOf(o)) ?? []), o]);
    const inverted: HitObject[] = [];
    for (const objects of columns.values()) {
      const starts = [...objects.filter((o) => !(o.type & 128)), ...objects.filter((o) => o.type & 128)].sort(
        (a, b) => a.time - b.time,
      );
      for (let i = 0; i + 1 < starts.length; i++) {
        const next = starts[i + 1].time;
        let duration = next - starts[i].time;
        // `TimingPointAt`: the first timing point applies before it starts.
        const red = map.timing.filter((t) => t.uninherited);
        const beatLength = (red.findLast((t) => t.time <= next) ?? red[0])?.beatLength ?? 500;
        duration = Math.max(duration / 2, duration - beatLength / 4);
        inverted.push({ ...starts[i], type: (starts[i].type & ~(1 | 2 | 8)) | 128, endTime: starts[i].time + duration });
      }
    }
    map.objects = inverted.sort((a, b) => a.time - b.time);
    map.breaks = [];
  } else if (map.mode === 3 && has("HO")) {
    // ManiaModHoldOff: holds become notes at their start.
    map.objects = [
      ...map.objects.filter((o) => !(o.type & 128)),
      ...map.objects.filter((o) => o.type & 128).map((o) => ({ ...o, type: (o.type & ~128) | 1, endTime: o.time })),
    ].sort((a, b) => a.time - b.time);
  }
  let lanes = Array.from({ length: keys }, (_, i) => i);
  for (const m of mods) {
    const a = m.acronym.toUpperCase();
    if (a === "RD" && map.mode === 3) {
      let shuffled: number[];
      if (netSeed !== undefined) {
        // ManiaModRandom: OrderBy(_ => rng.Next()) over the columns (a stable sort).
        const rng = new NetRandom(netSeed);
        shuffled = lanes
          .map((_, column) => ({ column, key: rng.nextInt() }))
          .sort((x, y) => x.key - y.key || x.column - y.column)
          .map((e) => e.column);
      } else {
        shuffled = [...lanes.keys()];
        for (let i = keys - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
      }
      lanes = lanes.map((lane) => shuffled[lane]);
    } else if (a === "MR" && map.mode === 3) lanes = lanes.map((lane) => keys - 1 - lane);
  }
  // osu! Mirror's axes (0 horizontal, 1 vertical, 2 both); catch mirrors after conversion (`catchObjects`).
  const mirrorMod = find("MR"),
    reflection = mirrorMod?.settings?.reflection,
    axes =
      reflection === 1 || reflection === "Vertical" || reflection === "vertical"
        ? { x: false, y: true }
        : reflection === 2 || reflection === "Both" || reflection === "both"
          ? { x: true, y: true }
          : { x: true, y: false };
  const transform = (p: Point) => {
    if (map.mode === 0 && has("HR")) p.y = 384 - p.y;
    if (mirrorMod && map.mode === 0) {
      if (axes.x) p.x = 512 - p.x;
      if (axes.y) p.y = 384 - p.y;
    }
  };
  const taikoRandom = map.mode === 1 && randomMod && netSeed !== undefined ? new NetRandom(netSeed) : null;
  // TaikoModSwap: centres become rims and back, before or after Random in mod order.
  const swapAt = mods.findIndex((m) => m.acronym.toUpperCase() === "SW"),
    randomAt = mods.findIndex((m) => m.acronym.toUpperCase() === "RD");
  const swapColour = (o: HitObject) => {
    o.sound = o.sound & 10 ? o.sound & ~10 : o.sound | 8;
  };
  for (const o of map.objects) {
    transform(o);
    for (const p of [...o.path, ...(o.controlPoints ?? [])]) transform(p);
    if (map.mode === 3) {
      const lane = lanes[Math.min(keys - 1, Math.floor((o.x * keys) / 512))];
      o.x = ((lane + 0.5) * 512) / keys;
    } else if (map.mode === 1 && (taikoRandom || swapAt >= 0) && !(o.type & (2 | 8 | 128))) {
      if (swapAt >= 0 && !(taikoRandom && swapAt > randomAt)) swapColour(o);
      if (taikoRandom) {
        // TaikoModRandom: every hit becomes centre (0) or rim at random.
        const rim = taikoRandom.nextBelow(2) !== 0;
        o.sound = (o.sound & ~10) | (rim ? 8 : 0);
        if (swapAt > randomAt) swapColour(o);
      }
    } else if (has("RD") && map.mode === 0) {
      const dx = (random() - 0.5) * 100,
        dy = (random() - 0.5) * 80;
      const minX = Math.min(o.x, ...o.path.map((p) => p.x)),
        maxX = Math.max(o.x, ...o.path.map((p) => p.x)),
        minY = Math.min(o.y, ...o.path.map((p) => p.y)),
        maxY = Math.max(o.y, ...o.path.map((p) => p.y));
      const tx = Math.max(-minX, Math.min(512 - maxX, dx)),
        ty = Math.max(-minY, Math.min(384 - maxY, dy));
      o.x += tx;
      o.y += ty;
      for (const p of [...o.path, ...(o.controlPoints ?? [])]) {
        p.x += tx;
        p.y += ty;
      }
    }
  }
  applyStacking(map);
  return map;
}
/** Integrated inherited SV; no discontinuity at timing changes. */
export function scrollPosition(
  timing: readonly TimingPoint[],
  time: number,
  mode: "mania" | "taiko" = "mania",
  baseBeatLength?: number,
): number {
  let previous = 0,
    position = 0,
    sv = 1,
    beat = 500;
  for (const t of timing) {
    if (t.time > time) break;
    position +=
      (t.time - previous) *
      sv *
      (mode === "taiko"
        ? 500 / beat
        : baseBeatLength === undefined
          ? 1
          : baseBeatLength / beat);
    previous = t.time;
    if (t.uninherited) {
      beat = t.beatLength;
      sv = 1;
    } else sv = Math.max(0.1, Math.min(10, -100 / t.beatLength));
  }
  return (
    position +
    (time - previous) *
      sv *
      (mode === "taiko"
        ? 500 / beat
        : baseBeatLength === undefined
          ? 1
          : baseBeatLength / beat)
  );
}
