/**
 * osu! (standard) judgement simulation, following lazer's gameplay code
 * (ppy/osu, MIT): hit windows, note lock (`StartTimeOrderedHitPolicy`, or the
 * classic `LegacyHitPolicy`), slider tracking (`SliderInputManager`), slider
 * events (`SliderEventGenerator`, 36 ms tail leniency) and spinner spins
 * (`SpinnerRotationTracker`, `SpinnerSpinHistory`). osu!stable replays are
 * judged the way lazer imports them, with the Classic mod's rules, and scored
 * with stable's ScoreV1.
 */
import type { Beatmap, Point } from "@vosu-tools/osu-parse";
import {
  f32,
  legacyBeatmap,
  precisionAdjustedBeatLength,
  timingPointAt,
} from "@vosu-tools/ruleset-convert";
import type { Replay, ReplayFrame } from "./index";
import {
  clientOf,
  lazerMultiplier,
  legacyMultiplier,
  peppyStars,
  type HealthInfo,
  type HitResult,
  type Outcome,
  type Rules,
} from "./scoring";
import { replayMods, replayRate } from "./mods";
import { judgeWithHealth } from "./health";
import type { Result, Simulation } from "./simulation";

/** `IBeatmapDifficultyInfo.DifficultyRange`: values at difficulty 0, 5 and 10. */
export const difficultyRange = (d: number, min: number, mid: number, max: number) =>
  d > 5 ? mid + ((max - mid) * (d - 5)) / 5 : d < 5 ? mid + ((mid - min) * (d - 5)) / 5 : mid;

/** `OsuHitWindows`: great, ok and meh, floored to whole milliseconds then 0.5 under. */
export function osuHitWindows(od: number): [number, number, number] {
  const d = f32(od);
  return [
    Math.floor(difficultyRange(d, 80, 50, 20)) - 0.5,
    Math.floor(difficultyRange(d, 140, 100, 60)) - 0.5,
    Math.floor(difficultyRange(d, 200, 150, 100)) - 0.5,
  ];
}
const MISS_WINDOW = 400;
const TAIL_LENIENCY = -36;
const FOLLOW_AREA = f32(2.4);
const CENTRE = { x: 256, y: 192 };

/** `CalculateScaleFromCircleSize(cs, applyFudge: true)`. */
export function osuScale(cs: number): number {
  const range = (f32(cs) - 5) / 5;
  return f32(f32(f32(1 - f32(0.7) * range) / 2) * f32(1.00041));
}

type Action = 0 | 1;
const LEFT: Action = 0,
  RIGHT: Action = 1;
const actionsOf = (keys: number): Action[] => {
  const out: Action[] = [];
  if (keys & 5) out.push(LEFT);
  if (keys & 10) out.push(RIGHT);
  return out;
};

interface CircleLike {
  start: number;
  x: number;
  y: number;
  judged: boolean;
  hit: boolean;
  hitAction: Action | null;
  /** Index of the owning object in `tops`. */
  owner: number;
  /** A slider's head rather than a hit circle. */
  head: boolean;
}
interface Nested {
  kind: "tick" | "repeat" | "tail";
  time: number;
  judged: boolean;
  hit: boolean;
}
interface Base {
  index: number;
  start: number;
  end: number;
  stack: number;
  judged: boolean;
}
interface Circle extends Base {
  kind: "circle";
  circle: CircleLike;
}
interface Slider extends Base {
  kind: "slider";
  circle: CircleLike;
  /** Stacked start position; path points are relative to it. */
  x: number;
  y: number;
  path: Point[];
  lengths: number[];
  distance: number;
  spans: number;
  duration: number;
  nested: Nested[];
  ticks: Nested[];
  repeats: Nested[];
  tail: Nested;
  tracking: boolean;
  acceptAnyAfter: number | null;
  lastPressed: Action[];
}
interface Spinner extends Base {
  kind: "spinner";
  circle: null;
  spinsRequired: number;
  ticks: { bonus: boolean; judged: boolean }[];
  lastAngle: number | null;
  completedSpins: number;
  history: SpinHistory;
}
type Top = Circle | Slider | Spinner;

/** `SpinnerSpinHistory`, forward playback only (single-precision like lazer). */
class SpinHistory {
  completed = 0;
  private accumulated = 0;
  private atLastCompletion = 0;
  private currentMax = 0;
  get total(): number {
    return f32(360 * this.completed + this.currentMax);
  }
  report(delta: number): void {
    if (delta === 0) return;
    this.accumulated = f32(this.accumulated + delta);
    const current = () => f32(this.accumulated - this.atLastCompletion);
    this.currentMax = Math.max(this.currentMax, Math.abs(current()));
    while (this.currentMax >= 360) {
      const direction = Math.sign(current());
      this.completed++;
      this.atLastCompletion = f32(this.atLastCompletion + direction * 360);
      this.currentMax = Math.abs(current());
    }
  }
}

/** Position along `path` at `distance`, clamped to its ends. */
function along(slider: Slider, distance: number): Point {
  const { path, lengths } = slider;
  if (path.length < 2) return path[0] ?? { x: 0, y: 0 };
  const d = Math.min(Math.max(distance, 0), lengths[lengths.length - 1]);
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < d) i++;
  const span = lengths[i] - lengths[i - 1],
    t = span > 0 ? (d - lengths[i - 1]) / span : 0;
  return {
    x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
    y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
  };
}
/** `CurvePositionAt`, absolute: `progress` runs 0..1 over every span. */
function ballAt(slider: Slider, progress: number): Point {
  const spanProgress = progress * slider.spans;
  let p = spanProgress % 1;
  if (Math.trunc(spanProgress) % 2 === 1) p = 1 - p;
  const local = along(slider, p * slider.distance);
  return { x: slider.x + local.x, y: slider.y + local.y };
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Interpolated cursor (lazer's `Interpolation.ValueAt` between replay frames). */
function cursorAt(frames: readonly ReplayFrame[], index: number, time: number): Point {
  const a = frames[index],
    b = frames[Math.min(index + 1, frames.length - 1)];
  if (!a) return { x: 256, y: 192 };
  if (!b || b.time === a.time) return { x: a.x, y: a.y };
  const t = (time - a.time) / (b.time - a.time);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export interface OsuSimulationOptions {
  /** The map's difficulty before mods: stable's ScoreV1 multiplier uses it. */
  baseDifficulty: Beatmap["difficulty"];
}

/**
 * Judges an osu! replay on `map` (mods applied, stacked). Results, combo and
 * score follow the client that set the replay; `verify` (via `judgeWithHealth`) compares them with
 * the recorded header and, for lazer, its statistics.
 */
export function simulateOsu(replay: Replay, map: Beatmap, options: OsuSimulationOptions): Simulation {
  if (replay.mode !== 0 || map.mode !== 0) throw new Error("Not an osu! replay on an osu! map");
  const client = clientOf(replay),
    mods = replayMods(replay),
    has = (a: string) => mods.some((m) => m.acronym === a);
  if (has("RX") || has("AP") || has("AT") || has("CN"))
    throw new Error("Relax, Autopilot and autoplay replays are not judged from input");
  const classic = client === "stable" || has("CL");
  const legacy = legacyBeatmap(map);
  const scale = osuScale(legacy.cs),
    radius = 64 * scale,
    stackStep = f32(scale * -6.4);
  const preempt = difficultyRange(legacy.ar, 1800, 1200, 450);
  const [great, ok, meh] = osuHitWindows(legacy.od);
  const rate = replayRate(replay);

  // Objects, nested events and lazer's autoplay order (for its maxima).
  const tops: Top[] = [];
  const perfect: Outcome[] = [];
  const outcomes: Outcome[] = [];
  const v1 = (value: number, combo: Outcome["v1"]["combo"], multiplied = false, bonus = false) => ({
    value,
    combo,
    multiplied,
    bonus,
  });
  const headMax: HitResult = classic ? "large_tick_hit" : "great";
  const tailMax: HitResult = classic ? "small_tick_hit" : "slider_tail_hit";
  // Combo information (`OsuHitObject.UpdateComboInformation`): spinners never
  // start a combo, and whatever follows one does; nested objects have none.
  const combos = legacy.objects.map((o, i) => ({
    newCombo: o.newCombo || i === 0 || legacy.objects[i - 1].kind === "spinner",
    lastInCombo: false,
  }));
  combos.forEach((c, i) => {
    const next = legacy.objects[i + 1];
    if (next && next.kind !== "spinner" && (combos[i + 1].newCombo || legacy.objects[i].kind === "spinner"))
      c.lastInCombo = true;
  });
  const topHp = (top: Top): HealthInfo => ({
    object: top.kind,
    end: top.end,
    top: true,
    ...combos[top.index],
  });
  const nestedHp = (object: HealthInfo["object"], end: number): HealthInfo => ({ object, end, top: false });
  const perfectOf = (top: Top, max: HitResult, hp: HealthInfo) =>
    perfect.push({
      time: top.start,
      note: top.index,
      type: max,
      max,
      count: null,
      offset: null,
      x: 0,
      y: 0,
      v1: v1(0, "none"),
      hp,
    });
  legacy.objects.forEach((o, index) => {
    const stack = map.objects[index]?.stack ?? 0,
      offset = stack * stackStep;
    if (o.kind === "circle" || o.kind === "hold") {
      const circle: CircleLike = {
        start: o.time,
        x: o.x + offset,
        y: o.y + offset,
        judged: false,
        hit: false,
        hitAction: null,
        owner: tops.length,
        head: false,
      };
      const top: Circle = { kind: "circle", index, start: o.time, end: o.time, stack, judged: false, circle };
      tops.push(top);
      perfectOf(top, "great", topHp(top));
    } else if (o.kind === "slider") {
      const timing = timingPointAt(legacy.points, o.time);
      const velocity =
        (100 * legacy.sliderMultiplier) /
        precisionAdjustedBeatLength(o.sliderVelocity, timing.beatLength, "osu");
      const tickDistance =
        ((velocity * timing.beatLength) / legacy.sliderTickRate) *
        (legacy.formatVersion < 8 ? 1 / o.sliderVelocity : 1);
      const spans = o.spans,
        spanDuration = o.distance / velocity,
        duration = spans * spanDuration;
      const first = o.path[0] ?? { x: o.x, y: o.y };
      const path = o.path.map((p) => ({ x: p.x - first.x, y: p.y - first.y }));
      const lengths = [0];
      for (let i = 1; i < path.length; i++)
        lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
      const nested: Nested[] = [],
        ticks: Nested[] = [],
        repeats: Nested[] = [];
      const length = Math.min(100000, o.distance),
        step = Math.min(Math.max(tickDistance, 0), length),
        minFromEnd = velocity * 10;
      for (let span = 0; span < spans; span++) {
        const spanStart = o.time + span * spanDuration,
          reversed = span % 2 === 1,
          spanTicks: Nested[] = [];
        if (step !== 0)
          for (let d = step; d <= length; d += step) {
            if (d >= length - minFromEnd) break;
            const progress = d / length;
            spanTicks.push({
              kind: "tick",
              time: spanStart + (reversed ? 1 - progress : progress) * spanDuration,
              judged: false,
              hit: false,
            });
          }
        if (reversed) spanTicks.reverse();
        nested.push(...spanTicks);
        ticks.push(...spanTicks);
        if (span < spans - 1) {
          const repeat: Nested = {
            kind: "repeat",
            time: o.time + (span + 1) * spanDuration,
            judged: false,
            hit: false,
          };
          nested.push(repeat);
          repeats.push(repeat);
        }
      }
      const tail: Nested = { kind: "tail", time: o.time + duration, judged: false, hit: false };
      nested.push(tail);
      const x = o.x + offset,
        y = o.y + offset;
      const top: Slider = {
        kind: "slider",
        index,
        start: o.time,
        end: o.time + duration,
        stack,
        judged: false,
        circle: { start: o.time, x, y, judged: false, hit: false, hitAction: null, owner: tops.length, head: true },
        x,
        y,
        path,
        lengths,
        distance: o.distance,
        spans,
        duration,
        nested,
        ticks,
        repeats,
        tail,
        tracking: false,
        acceptAnyAfter: null,
        lastPressed: [],
      };
      tops.push(top);
      perfectOf(top, headMax, nestedHp("slider_head", top.start));
      for (const n of nested)
        perfectOf(top, n.kind === "tail" ? tailMax : "large_tick_hit", nestedHp(`slider_${n.kind}`, n.time));
      perfectOf(top, classic ? "great" : "ignore_hit", topHp(top));
    } else {
      const end = Math.max(o.time, o.endTime),
        seconds = (end - o.time) / 1000;
      const spinsRequired = Math.trunc(
        (difficultyRange(legacy.od, 90, 150, 225) / 60) * seconds + 0.0001,
      );
      const maximumBonus = Math.max(
        0,
        Math.trunc((difficultyRange(legacy.od, 250, 380, 430) / 60) * seconds + 0.0001) -
          spinsRequired -
          2,
      );
      const ticks = Array.from({ length: maximumBonus + spinsRequired + 2 }, (_, i) => ({
        bonus: i >= spinsRequired + 2,
        judged: false,
      }));
      const top: Spinner = {
        kind: "spinner",
        index,
        start: o.time,
        end,
        stack: 0,
        judged: false,
        circle: null,
        spinsRequired,
        ticks,
        lastAngle: null,
        completedSpins: 0,
        history: new SpinHistory(),
      };
      tops.push(top);
      for (const t of ticks)
        perfectOf(
          top,
          t.bonus ? "large_bonus" : "small_bonus",
          nestedHp(t.bonus ? "spinner_bonus" : "spinner_tick", end),
        );
      perfectOf(top, "great", topHp(top));
    }
  });

  const COUNT: Partial<Record<HitResult, Result>> = { great: "n300", ok: "n100", meh: "n50", miss: "miss" };
  const VALUE: Partial<Record<HitResult, number>> = { great: 300, ok: 100, meh: 50 };
  const record = (
    top: Top,
    time: number,
    type: HitResult,
    max: HitResult,
    at: Point,
    offset: number | null,
    score: Outcome["v1"],
    hp: HealthInfo,
  ) =>
    outcomes.push({
      time,
      note: top.index,
      type,
      max,
      count: COUNT[max] ? (COUNT[type] ?? null) : null,
      offset,
      x: at.x,
      y: at.y,
      v1: score,
      hp,
    });
  const isHit = (r: HitResult) => r !== "miss" && r !== "large_tick_miss" && r !== "small_tick_miss" && r !== "ignore_miss";

  // Input and update state.
  const frames = replay.frames;
  let actions: Action[] = [],
    cursor: Point = { x: 256, y: 192 },
    now = -Infinity;
  const active: Top[] = [];
  let nextTop = 0;

  const resultFor = (offset: number): HitResult | null => {
    const o = Math.abs(offset);
    return o <= great ? "great" : o <= ok ? "ok" : o <= meh ? "meh" : o <= MISS_WINDOW ? "miss" : null;
  };
  const allJudged = (top: Top) => top.judged;
  const circleLikes = () => active.flatMap((top) => (top.circle ? [top.circle] : []));

  /** `StartTimeOrderedHitPolicy` / `LegacyHitPolicy`: may `c` be hit now? */
  function hittable(c: CircleLike): boolean {
    if (!classic) {
      let blocking: CircleLike | null = null;
      for (const other of circleLikes()) if (other.start < c.start) blocking = other;
      if (blocking && !blocking.judged && now < blocking.start) return false;
      return true;
    }
    const alive = active.filter((top) => top.start - preempt <= now);
    const owner = tops[c.owner];
    if (!c.head) {
      const index = alive.indexOf(owner);
      if (index > 0) {
        const previous = alive[index - 1];
        if (previous.stack > 0 && !allJudged(previous)) return false;
      }
    }
    for (const test of alive) {
      if (allJudged(test)) continue;
      if (test === owner && !c.head) break;
      if (test.end + 3 < c.start) return false;
    }
    return Math.abs(c.start - now) < MISS_WINDOW;
  }

  function judgeCircle(c: CircleLike, type: HitResult, offset: number | null): void {
    c.judged = true;
    c.hit = isHit(type);
    const owner = tops[c.owner];
    const hp = c.head ? nestedHp("slider_head", c.start) : topHp(owner);
    if (c.head && classic)
      record(owner, now, type, "large_tick_hit", c, offset, v1(30, c.hit ? "increase" : "break"), hp);
    else
      record(owner, now, type, "great", c, offset, v1(VALUE[type] ?? 0, c.hit ? "increase" : "break", true), hp);
    if (!c.head) owner.judged = true;
    // `StartTimeOrderedHitPolicy.HandleHit`: earlier circles miss once a later one is judged.
    if (!classic)
      for (const other of circleLikes())
        if (other.start < c.start && !other.judged) judgeCircle(other, missOf(other), null);
    if (owner.kind === "slider") postProcessHead(owner);
  }
  const missOf = (c: CircleLike): HitResult => (c.head && classic ? "large_tick_miss" : "miss");

  function press(action: Action): void {
    for (const top of active) {
      const c = top.circle;
      if (!c || c.judged || top.start - preempt > now) continue;
      if ((cursor.x - c.x) ** 2 + (cursor.y - c.y) ** 2 > radius * radius) continue;
      const offset = now - c.start;
      let result = resultFor(offset);
      if (c.head && classic) result = result && result !== "miss" ? "large_tick_hit" : "large_tick_miss";
      if (result && hittable(c)) judgeCircle(c, result, isHit(result) ? offset : null);
      c.hitAction ??= action;
      return;
    }
  }

  function inFollowArea(s: Slider, expanded: boolean): boolean {
    const r = expanded ? f32(f32(radius) * FOLLOW_AREA) : radius;
    const ball = ballAt(s, clamp01((now - s.start) / s.duration));
    return (cursor.x - ball.x) ** 2 + (cursor.y - ball.y) ** 2 <= r * r;
  }
  function updateTracking(s: Slider, validPosition: boolean): void {
    const hitAction = s.circle.hitAction;
    if (hitAction === null) s.acceptAnyAfter = null;
    if (hitAction !== null && s.acceptAnyAfter === null) {
      const other = hitAction === RIGHT ? LEFT : RIGHT;
      if (!s.lastPressed.includes(other)) s.acceptAnyAfter = now;
    }
    s.lastPressed = [...actions];
    const restricted = hitAction !== null && (s.acceptAnyAfter === null || now <= s.acceptAnyAfter);
    const validAction = actions.some((a) => !restricted || a === hitAction);
    s.tracking = (!s.judged || now <= s.end) && validPosition && validAction;
  }
  function judgeNested(s: Slider, n: Nested, hit: boolean): void {
    n.judged = true;
    n.hit = hit;
    const at = ballAt(s, clamp01((n.time - s.start) / s.duration));
    if (n.kind === "tail")
      record(
        s,
        now,
        hit ? tailMax : classic ? "small_tick_miss" : "ignore_miss",
        tailMax,
        at,
        null,
        v1(30, hit ? "increase" : "none"),
        nestedHp("slider_tail", n.time),
      );
    else
      record(
        s,
        now,
        hit ? "large_tick_hit" : "large_tick_miss",
        "large_tick_hit",
        at,
        null,
        v1(n.kind === "tick" ? 10 : 30, hit ? "increase" : "break"),
        nestedHp(n.kind === "tick" ? "slider_tick" : "slider_repeat", n.time),
      );
  }
  /** `SliderInputManager.PostProcessHeadJudgement`: a late head settles passed ticks. */
  function postProcessHead(s: Slider): void {
    if (!s.circle.hit || !inFollowArea(s, true)) return;
    const passed: Nested[] = [];
    for (const n of s.nested) {
      if (n.judged) continue;
      if (n.time > now) break;
      passed.push(n);
    }
    const r = f32(f32(radius) * FOLLOW_AREA);
    let allInRange = true;
    for (const n of passed) {
      const at = ballAt(s, clamp01((n.time - s.start) / s.duration));
      if ((at.x - cursor.x) ** 2 + (at.y - cursor.y) ** 2 > r * r) {
        allInRange = false;
        break;
      }
    }
    for (const n of passed) judgeNested(s, n, allInRange);
    updateTracking(s, allInRange || inFollowArea(s, false));
  }
  /** `SliderInputManager.TryJudgeNestedObject`. */
  function tryNested(s: Slider, n: Nested): void {
    if (n.judged) return;
    const offset = now - n.time;
    if (n.kind === "tail") {
      if (offset < TAIL_LENIENCY) return;
      const lastTick = s.nested.findLast((x) => x.kind !== "tail");
      if (lastTick && !lastTick.judged) return;
    } else if (offset < 0) return;
    if (!s.circle.judged) return;
    if (s.tracking) judgeNested(s, n, true);
    else if (offset >= 0) judgeNested(s, n, false);
  }
  function updateSlider(s: Slider): void {
    updateTracking(s, inFollowArea(s, s.tracking));
    for (const n of s.ticks) tryNested(s, n);
    for (const n of s.repeats) tryNested(s, n);
    tryNested(s, s.tail);
    if (!s.circle.judged && now - s.start > meh) judgeCircle(s.circle, missOf(s.circle), null);
    if (s.judged || !s.tail.judged || now < s.end) return;
    s.judged = true;
    const end = ballAt(s, 1);
    if (classic) {
      const total = s.nested.length + 1,
        hits = s.nested.filter((n) => n.hit).length + (s.circle.hit ? 1 : 0);
      const type: HitResult =
        hits === total ? "great" : hits === 0 ? "miss" : hits / total >= 0.5 ? "ok" : "meh";
      record(s, now, type, "great", end, null, v1(VALUE[type] ?? 0, "none", true), topHp(s));
    } else {
      const any = s.circle.hit || s.nested.some((n) => n.hit);
      record(s, now, any ? "ignore_hit" : "ignore_miss", "ignore_hit", end, null, v1(0, "none"), topHp(s));
    }
  }
  function updateSpinner(s: Spinner): void {
    const spinnable = s.start <= now && now < s.end;
    const tracking = spinnable && !s.judged && actions.length > 0;
    const angle = f32(-((Math.atan2(cursor.x - CENTRE.x, cursor.y - CENTRE.y) * 180) / Math.PI));
    if (s.lastAngle !== null) {
      let delta = f32(angle - s.lastAngle);
      if (delta > 180) delta = f32(delta - 360);
      if (delta < -180) delta = f32(delta + 360);
      if (tracking) s.history.report(f32(delta * Math.abs(rate)));
    }
    s.lastAngle = angle;
    const progress = s.spinsRequired === 0 ? 1 : Math.min(1, s.history.total / 360 / s.spinsRequired);
    if (now >= s.start && now >= s.end && !s.judged) {
      for (const tick of s.ticks)
        if (!tick.judged) {
          tick.judged = true;
          const max: HitResult = tick.bonus ? "large_bonus" : "small_bonus";
          record(
            s,
            now,
            "ignore_miss",
            max,
            CENTRE,
            null,
            v1(0, "none", false, true),
            nestedHp(tick.bonus ? "spinner_bonus" : "spinner_tick", s.end),
          );
        }
      const type: HitResult =
        progress >= 1 ? "great" : progress > 0.9 ? "ok" : progress > 0.75 ? "meh" : "miss";
      s.judged = true;
      record(
        s,
        now,
        type,
        "great",
        CENTRE,
        null,
        v1(VALUE[type] ?? 0, isHit(type) ? "increase" : "break", true),
        topHp(s),
      );
    }
    const spins = Math.trunc(s.history.total / 360);
    while (s.completedSpins < spins) {
      const tick = s.ticks.find((t) => !t.judged);
      if (tick) {
        tick.judged = true;
        const type: HitResult = tick.bonus ? "large_bonus" : "small_bonus";
        record(
          s,
          now,
          type,
          type,
          CENTRE,
          null,
          v1(tick.bonus ? 1100 : 100, "none", false, true),
          nestedHp(tick.bonus ? "spinner_bonus" : "spinner_tick", s.end),
        );
      }
      s.completedSpins++;
    }
  }

  // Update times: every frame, plus every moment lazer judges something.
  const extra: number[] = [];
  for (const top of tops) {
    if (top.kind === "circle") extra.push(top.start + meh + 0.5);
    else if (top.kind === "slider") {
      extra.push(top.start + meh + 0.5, top.end + TAIL_LENIENCY, top.end);
      for (const n of top.nested) extra.push(n.time);
    } else extra.push(top.end);
  }
  extra.sort((a, b) => a - b);
  let frameIndex = -1,
    extraIndex = 0,
    previousActions: Action[] = [];
  while (frameIndex + 1 < frames.length || extraIndex < extra.length) {
    const nextFrame = frames[frameIndex + 1]?.time ?? Infinity;
    const isFrame = nextFrame <= (extra[extraIndex] ?? Infinity);
    if (isFrame) {
      frameIndex++;
      now = nextFrame;
      while (extraIndex < extra.length && extra[extraIndex] <= now) extraIndex++;
    } else now = extra[extraIndex++];
    const frame = frames[frameIndex];
    cursor = cursorAt(frames, Math.max(0, frameIndex), now);
    actions = frame ? actionsOf(frame.keys) : [];
    while (nextTop < tops.length && tops[nextTop].start - preempt <= now) active.push(tops[nextTop++]);
    if (isFrame) {
      for (const action of actions) if (!previousActions.includes(action)) press(action);
      previousActions = actions;
    }
    for (const top of active) {
      if (top.kind === "circle") {
        if (!top.circle.judged && now - top.start > meh) judgeCircle(top.circle, "miss", null);
      } else if (top.kind === "slider") updateSlider(top);
      else updateSpinner(top);
    }
    for (let i = active.length - 1; i >= 0; i--)
      if (active[i].judged && now > active[i].end + 1000) active.splice(i, 1);
  }

  const v1Multiplier = has("SV2")
    ? null
    : peppyStars(map, options.baseDifficulty) * legacyMultiplier(0, mods);
  const rules: Rules = {
    mode: 0,
    client,
    v1Multiplier: client === "stable" ? v1Multiplier : null,
    lazerMultiplier: lazerMultiplier(0, mods, replay.version),
  };
  const warnings: string[] = [];
  const unjudged = tops.filter((t) => !t.judged).length;
  if (unjudged) warnings.push(`${unjudged} objects were never judged (replay ends early)`);
  return judgeWithHealth(replay, { mode: 0, map, mods, classic }, perfect, outcomes, rules, warnings);
}
