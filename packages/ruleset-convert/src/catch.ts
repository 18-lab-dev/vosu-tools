import { pathPosition } from "@vosu-tools/osu-parse";
import {
  f32,
  precisionAdjustedBeatLength,
  timingPointAt,
  type LegacyBeatmap,
  type LegacyObject,
} from "./legacy";
import { LegacyRandom } from "./random";

/**
 * osu!catch objects as lazer builds them from an osu!-format beatmap (native
 * catch maps and osu! converts alike): `CatchBeatmapConverter`, the juice
 * stream / banana shower nesting and `CatchBeatmapProcessor` (seeded tiny
 * droplet and banana offsets, Hard Rock offsets, hyper-dash marking).
 * Ported from ppy/osu 2026.1005.0-lazer (MIT).
 */

export type CatchKind = "fruit" | "droplet" | "tiny" | "banana";

export interface CatchObject {
  kind: CatchKind;
  time: number;
  /** Final playfield x (0-512) after offsets. */
  x: number;
  /** This fruit/droplet needs a hyper-dash to reach the next one. */
  hyper: boolean;
  /**
   * `IndexInBeatmap`: the index of the top-level object it belongs to. Sets
   * the combo colour (`index + 1`) and the fruit kind (`index % 4`).
   */
  index: number;
  /** Catching it ends a combo, so the catcher's plate is cleared. */
  lastInCombo: boolean;
}

export interface CatchOptions {
  /** Circle size after difficulty mods (sets the catcher width). */
  circleSize: number;
  /** Hard Rock's random fruit offsets. */
  hardRock?: boolean;
}

const playfieldWidth = 512;
const rngSeed = 1337;
const baseSize = f32(106.75);
const allowedCatchRange = f32(0.8);
const baseDashSpeed = 1;

interface Palpable {
  kind: CatchKind;
  time: number;
  originalX: number;
  xOffset: number;
  hyper: boolean;
  index?: number;
  lastInCombo?: boolean;
}
interface TopLevel {
  object: LegacyObject;
  kind: "fruit" | "stream" | "shower";
  self?: Palpable;
  nested: Palpable[];
}

const effectiveX = (p: Palpable): number =>
  Math.min(playfieldWidth, Math.max(0, f32(p.originalX + p.xOffset)));

const tailLeniency = -36;

interface SliderEvent {
  type: "head" | "tick" | "repeat" | "lastTick" | "tail";
  time: number;
  progress: number;
}

/** `SliderEventGenerator.Generate`, without the events catch ignores. */
function sliderEvents(
  startTime: number,
  spanDuration: number,
  velocity: number,
  tickDistance: number,
  totalDistance: number,
  spanCount: number,
): SliderEvent[] {
  const length = Math.min(100000, totalDistance);
  tickDistance = Math.min(length, Math.max(0, tickDistance));
  const minDistanceFromEnd = velocity * 10;
  const events: SliderEvent[] = [
    { type: "head", time: startTime, progress: 0 },
  ];
  for (let span = 0; span < spanCount; span++) {
    const spanStart = startTime + span * spanDuration,
      reversed = span % 2 === 1;
    if (tickDistance !== 0) {
      const ticks: SliderEvent[] = [];
      for (let d = tickDistance; d <= length; d += tickDistance) {
        if (d >= length - minDistanceFromEnd) break;
        const progress = d / length,
          timeProgress = reversed ? 1 - progress : progress;
        ticks.push({
          type: "tick",
          time: spanStart + timeProgress * spanDuration,
          progress,
        });
      }
      if (reversed) ticks.reverse();
      events.push(...ticks);
    }
    if (span < spanCount - 1)
      events.push({
        type: "repeat",
        time: spanStart + spanDuration,
        progress: (span + 1) % 2,
      });
  }
  const totalDuration = spanCount * spanDuration,
    finalSpan = spanCount - 1,
    finalSpanStart = startTime + finalSpan * spanDuration,
    lastTickTime = Math.max(
      startTime + totalDuration / 2,
      finalSpanStart + spanDuration + tailLeniency,
    );
  let lastTickProgress = (lastTickTime - finalSpanStart) / spanDuration;
  if (spanCount % 2 === 0) lastTickProgress = 1 - lastTickProgress;
  events.push({
    type: "lastTick",
    time: lastTickTime,
    progress: lastTickProgress,
  });
  events.push({
    type: "tail",
    time: startTime + totalDuration,
    progress: spanCount % 2,
  });
  return events;
}

function juiceStream(map: LegacyBeatmap, object: LegacyObject): Palpable[] {
  const timingPoint = timingPointAt(map.points, object.time),
    velocity =
      (100 * map.sliderMultiplier) /
      precisionAdjustedBeatLength(
        object.sliderVelocity,
        timingPoint.beatLength,
        "fruits",
      ),
    tickDistanceMultiplier =
      map.formatVersion < 8 ? 1 / object.sliderVelocity : 1,
    tickDistance =
      ((velocity * timingPoint.beatLength) / map.sliderTickRate) *
      tickDistanceMultiplier,
    distance = object.distance,
    spans = object.spans,
    spanDuration = (spans * distance) / velocity / spans;
  const streamX = Math.min(playfieldWidth, Math.max(0, object.x)),
    origin = object.path[0] ?? { x: object.x, y: object.y },
    xAt = (progress: number) =>
      f32(streamX + f32(pathPosition(object.path, progress).x - origin.x));
  const nested: Palpable[] = [];
  const add = (kind: CatchKind, time: number, x: number) =>
    nested.push({ kind, time, originalX: x, xOffset: 0, hyper: false });
  let last: SliderEvent | undefined;
  for (const e of sliderEvents(
    object.time,
    spanDuration,
    velocity,
    tickDistance,
    distance,
    spans,
  )) {
    if (last) {
      const sinceLastTick = Math.trunc(e.time) - Math.trunc(last.time);
      if (sinceLastTick > 80) {
        let timeBetweenTiny = sinceLastTick;
        while (timeBetweenTiny > 100) timeBetweenTiny /= 2;
        for (let t = timeBetweenTiny; t < sinceLastTick; t += timeBetweenTiny)
          add(
            "tiny",
            t + last.time,
            xAt(
              last.progress +
                (t / sinceLastTick) * (e.progress - last.progress),
            ),
          );
      }
    }
    last = e;
    if (e.type === "tick") add("droplet", e.time, xAt(e.progress));
    else if (e.type !== "lastTick") add("fruit", e.time, xAt(e.progress));
  }
  return nested;
}

function bananas(object: LegacyObject): Palpable[] {
  const start = Math.trunc(object.time),
    end = Math.trunc(object.endTime);
  let spacing = f32(object.endTime - object.time);
  while (spacing > 100) spacing = f32(spacing / 2);
  if (spacing <= 0) return [];
  const out: Palpable[] = [];
  for (let time = f32(start); time <= end; time = f32(time + spacing))
    out.push({ kind: "banana", time, originalX: 0, xOffset: 0, hyper: false });
  return out;
}

function applyOffset(position: number, amount: number): number {
  if (amount > 0) {
    if (f32(position + amount) < playfieldWidth)
      position = f32(position + amount);
  } else if (f32(position + amount) > 0) position = f32(position + amount);
  return position;
}

function applyRandomOffset(
  position: number,
  maxOffset: number,
  rng: LegacyRandom,
): number {
  const right = rng.nextBool();
  const rand = Math.min(20, f32(rng.nextInRange(0, Math.max(0, maxOffset))));
  if (right)
    return f32(position + rand) <= playfieldWidth
      ? f32(position + rand)
      : f32(position - rand);
  return f32(position - rand) >= 0
    ? f32(position - rand)
    : f32(position + rand);
}

/** Every palpable catch object of an osu!-format beatmap, in lazer's order. */
export function convertToCatch(
  map: LegacyBeatmap,
  options: CatchOptions,
): CatchObject[] {
  const top: TopLevel[] = map.objects.map((object) => {
    if (object.kind === "slider")
      return { object, kind: "stream", nested: juiceStream(map, object) };
    if (object.kind === "spinner" || object.kind === "hold")
      return { object, kind: "shower", nested: bananas(object) };
    return {
      object,
      kind: "fruit",
      self: {
        kind: "fruit",
        time: object.time,
        originalX: object.x,
        xOffset: 0,
        hyper: false,
      },
      nested: [],
    };
  });

  // CatchHitObject.UpdateComboInformation and CatchBeatmapProcessor.PostProcess:
  // banana showers never start a combo and always end one; the last nested
  // object carries its parent's end of combo.
  top.forEach((entry, index) => {
    const startsCombo =
      entry.kind !== "shower" &&
      (entry.object.newCombo ||
        index === 0 ||
        top[index - 1].kind === "shower");
    if (startsCombo && index > 0) markLastInCombo(top[index - 1]);
    if (entry.kind === "shower") markLastInCombo(entry);
    for (const p of entry.self ? [entry.self] : entry.nested) p.index = index;
  });

  // CatchBeatmapProcessor.ApplyPositionOffsets
  const rng = new LegacyRandom(rngSeed);
  let lastPosition: number | null = null,
    lastStartTime = 0;
  for (const entry of top) {
    if (entry.kind === "fruit") {
      const fruit = entry.self!;
      if (!options.hardRock) continue;
      let offsetPosition = fruit.originalX;
      const startTime = fruit.time;
      if (lastPosition === null || lastPosition === 0) {
        lastPosition = offsetPosition;
        lastStartTime = startTime;
        continue;
      }
      const positionDiff = f32(offsetPosition - lastPosition),
        timeDiff = Math.trunc(startTime - lastStartTime);
      if (timeDiff > 1000) {
        lastPosition = offsetPosition;
        lastStartTime = startTime;
        continue;
      }
      if (positionDiff === 0) {
        offsetPosition = applyRandomOffset(offsetPosition, timeDiff / 4, rng);
        fruit.xOffset = f32(offsetPosition - fruit.originalX);
        continue;
      }
      if (Math.abs(positionDiff) < Math.trunc(timeDiff / 3))
        offsetPosition = applyOffset(offsetPosition, positionDiff);
      fruit.xOffset = f32(offsetPosition - fruit.originalX);
      lastPosition = offsetPosition;
      lastStartTime = startTime;
    } else if (entry.kind === "shower") {
      for (const banana of entry.nested) {
        banana.xOffset = f32(rng.nextDouble() * playfieldWidth);
        rng.next(); // banana type
        rng.next(); // banana rotation
        rng.next(); // banana colour
      }
    } else {
      const controls = entry.object.controlPoints,
        first = controls[0] ?? entry.object,
        lastControl = controls[controls.length - 1] ?? entry.object;
      // Stable's quirk, kept by lazer: the last control point, not the path end.
      lastPosition = f32(entry.object.x + f32(lastControl.x - first.x));
      lastStartTime = entry.object.time;
      for (const nested of entry.nested) {
        if (nested.kind === "tiny")
          nested.xOffset = Math.min(
            f32(playfieldWidth - nested.originalX),
            Math.max(-nested.originalX, rng.nextInRange(-20, 20)),
          );
        else if (nested.kind === "droplet") rng.next(); // droplet rotation
      }
    }
  }

  // CatchBeatmapProcessor.initialiseHyperDash
  const all: Palpable[] = [];
  for (const entry of top) {
    if (entry.self) all.push(entry.self);
    all.push(...entry.nested);
  }
  const palpable = all
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p.time - b.p.time || a.index - b.index)
    .map(({ p }) => p)
    .filter((p) => p.kind === "fruit" || p.kind === "droplet");
  const scale = f32(
    f32(f32(1 - f32(0.7) * ((f32(options.circleSize) - 5) / 5)) / 2) * 2,
  );
  let halfCatcherWidth: number = f32(
    f32(f32(baseSize * Math.abs(scale)) * allowedCatchRange) / 2,
  );
  halfCatcherWidth /= allowedCatchRange;
  let lastDirection = 0,
    lastExcess = halfCatcherWidth;
  const grace = f32(f32(1000 / 60) / 4);
  for (let i = 0; i < palpable.length - 1; i++) {
    const current = palpable[i],
      next = palpable[i + 1];
    const thisDirection = effectiveX(next) > effectiveX(current) ? 1 : -1;
    const timeToNext = f32(
      Math.trunc(next.time) - Math.trunc(current.time) - grace,
    );
    const distanceToNext =
      Math.abs(f32(effectiveX(next) - effectiveX(current))) -
      (lastDirection === thisDirection ? lastExcess : halfCatcherWidth);
    const distanceToHyper = f32(timeToNext * baseDashSpeed - distanceToNext);
    if (distanceToHyper < 0) {
      current.hyper = true;
      lastExcess = halfCatcherWidth;
    } else
      lastExcess = Math.min(halfCatcherWidth, Math.max(0, distanceToHyper));
    lastDirection = thisDirection;
  }

  return all.map((p) => ({
    kind: p.kind,
    time: p.time,
    x: effectiveX(p),
    hyper: p.hyper,
    index: p.index ?? 0,
    lastInCombo: p.lastInCombo ?? false,
  }));
}

function markLastInCombo(entry: TopLevel): void {
  const last = entry.self ?? entry.nested[entry.nested.length - 1];
  if (last) last.lastInCombo = true;
}
