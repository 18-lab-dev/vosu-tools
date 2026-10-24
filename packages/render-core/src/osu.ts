/**
 * osu!'s legacy spinners, slider balls and follow circles, laid out as
 * osu!lazer lays them out. Ported from ppy/osu at 2026.1005.0-lazer (MIT):
 * osu.Game.Rulesets.Osu/Skinning/Legacy (`OsuLegacySkinTransformer`,
 * `LegacySpinner`, `LegacyOldStyleSpinner`, `LegacyNewStyleSpinner`,
 * `LegacySliderBall`, `LegacyFollowCircle`), `FollowCircle`,
 * `DrawableSliderBall`, `DrawableSpinner` and `SpinnerRotationTracker`, with
 * the spinning and slider following of `OsuAutoGenerator` (the preview has no
 * input, so it plays like autoplay).
 *
 * Positions are in osu! pixels of render-core's world (the 640×480 view
 * centred on (256, 192)). Lazer's legacy spinner is a 640×480 box centred
 * 8 osu! pixels above the playfield's centre (it undoes the playfield's
 * storyboard shift), so the box's centre is (256, 184).
 */
import type { Beatmap, HitObject, Point } from "@vosu-tools/osu-parse";
import { pathPosition } from "@vosu-tools/osu-parse";
import type { AtlasRegion, Skin } from "./skin";

/** Emits one instance (scene.ts `add`). */
export type OsuEmit = (
  x: number,
  y: number,
  w: number,
  h: number,
  start: number,
  end: number,
  from: number,
  until: number,
  colour: readonly number[],
  shape?: number,
  motion?: number,
  a?: number,
  b?: number,
  c?: number,
  asset?: string,
  p?: number,
  q?: number,
  r?: number,
  custom?: readonly [number, number, number, number],
  still?: boolean,
  crop?: readonly [number, number],
  rows?: readonly [number, number],
  fps?: number,
) => void;

/** `LegacySpinner.SPRITE_SCALE`. */
const SPRITE_SCALE = 0.625;
/** `LegacySpinner.SPINNER_TOP_OFFSET` and `SPINNER_Y_CENTRE`, box units. */
const TOP_OFFSET = 45 - 16;
const Y_CENTRE = TOP_OFFSET + 219;
/** The legacy spinner's 640×480 box, top-left corner in osu! pixels. */
const BOX_X = 256 - 320;
const BOX_Y = 184 - 240;
/** `OsuAutoGenerator`: 0.05 rad/ms (about 477 RPM), degrees per ms. */
export const AUTO_SPIN = (0.05 * 180) / Math.PI;
/** `OsuLegacySkinTransformer.MAX_FOLLOW_CIRCLE_AREA_SIZE`: 3 × the 128-pixel object. */
const MAX_BALL_AREA = 128 * 3;
/** `LegacyOldStyleSpinner`'s full metre, box units. */
const METRE_HEIGHT = 692 * SPRITE_SCALE;

/**
 * A skin.ini boolean as `LegacySkin` reads it: true/false, else any integer
 * (non-zero is true); anything else is unset.
 */
export function legacyBool(value: string | undefined): boolean | undefined {
  const text = value?.trim();
  if (text === undefined) return undefined;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  return /^[+-]?\d+$/.test(text) ? Number(text) !== 0 : undefined;
}

/** Instance kinds the shader animates (shader.ts). */
export const SPINNER_PART = 37;
export const FOLLOW_CIRCLE = 40;
export const SLIDER_BALL = 41;
/** `SPINNER_PART` roles (motion.y). */
export const SpinnerRole = {
  static: 0,
  turn: 1,
  approach: 2,
  clear: 3,
  spinIn: 4,
  spinOut: 5,
  rpm: 6,
  /** New-style parts: scaled with progress, turned by motion.w. */
  scaled: 8,
  glow: 9,
  middle: 10,
} as const;

/** `IBeatmapDifficultyInfo.DifficultyRange(difficulty, min, mid, max)`. */
function difficultyRange(d: number, min: number, mid: number, max: number) {
  if (d > 5) return mid + ((max - mid) * (d - 5)) / 5;
  if (d < 5) return mid + ((mid - min) * (d - 5)) / 5;
  return mid;
}

export interface SpinnerTiming {
  /** `Spinner.SpinsRequired`. */
  required: number;
  /** Every spinner tick, bonus ticks included. */
  ticks: number;
  /** ms per full spin under autoplay. */
  spin: number;
  /** When autoplay's progress reaches 1 (Infinity when it never does). */
  completed: number;
}

/** `Spinner.ApplyDefaultsToSelf` / `CreateNestedHitObjects` under autoplay. */
export function spinnerTiming(od: number, o: HitObject): SpinnerTiming {
  const seconds = (o.endTime - o.time) / 1000,
    minRps = difficultyRange(od, 90, 150, 225) / 60,
    maxRps = difficultyRange(od, 250, 380, 430) / 60,
    required = Math.trunc(minRps * seconds + 0.0001),
    bonus = Math.max(0, Math.trunc(maxRps * seconds + 0.0001) - required - 2),
    spin = 360 / AUTO_SPIN,
    completed = o.time + required * spin;
  return {
    required,
    ticks: bonus + required + 2,
    spin,
    completed: completed < o.endTime ? completed : Infinity,
  };
}

/**
 * `OsuAutoGenerator.calcSpinnerStartPosAndDirection`: autoplay turns
 * anticlockwise (−1) when it enters from outside the 50-pixel spin circle.
 */
export function spinDirection(previous: Point): number {
  return Math.hypot(256 - previous.x, 192 - previous.y) > 50 ? -1 : 1;
}

/** `SpinnerRotationTracker`'s damped rotation of autoplay's spin, degrees. */
export function spinnerTurn(now: number, start: number, end: number): number {
  const tau = -1 / Math.log(0.99);
  if (now <= start) return 0;
  const t = Math.min(now, end) - start,
    r = AUTO_SPIN * (t - tau * (1 - Math.exp(-t / tau)));
  if (now <= end) return r;
  const target = AUTO_SPIN * (end - start);
  return target - (target - r) * Math.exp(-(now - end) / tau);
}

const colourOf = (value: string | undefined): number[] | undefined =>
  value
    ?.split(",")
    .slice(0, 3)
    .map((c) => Number(c.trim()) / 255);

/**
 * A legacy spinner: `LegacyNewStyleSpinner` when the skin itself has
 * spinner-top and no spinner-background, `LegacyOldStyleSpinner` when it has
 * spinner-background; a skin with neither takes the built-in look's style.
 */
export function spinner(
  add: OsuEmit,
  o: HitObject,
  map: Beatmap,
  preempt: number,
  previous: Point,
  regions: Map<string, AtlasRegion>,
  skin: Skin | undefined,
): void {
  const owned = (name: string) =>
    regions.has(name) && !skin?.fallback?.has(name);
  const timing = spinnerTiming(map.difficulty.od, o),
    direction = spinDirection(previous),
    fadeIn = 400 * Math.min(1, preempt / 450),
    from = o.time - fadeIn,
    until = o.endTime + 240,
    completed = timing.completed;
  const size = (name: string, scale = SPRITE_SCALE) => {
    const region = regions.get(name);
    return [
      (region?.width ?? 0) * scale,
      (region?.height ?? 0) * scale,
    ] as const;
  };
  const part = (
    name: string,
    x: number,
    y: number,
    role: number,
    parameter = 0,
    colour: readonly number[] = [1, 1, 1],
    window: readonly [number, number] = [from, until],
    scale = SPRITE_SCALE,
    shape = 10,
  ) => {
    if (!regions.has(name)) return;
    const [w, h] = size(name, scale);
    add(
      x,
      y,
      w,
      h,
      o.time,
      o.endTime,
      window[0],
      window[1],
      colour,
      shape,
      SPINNER_PART,
      role,
      completed === Infinity ? 1e9 : completed,
      parameter,
      name,
      0,
      0,
      0,
      undefined,
      true,
    );
  };
  const centreY = BOX_Y + Y_CENTRE;
  // The first skin with either image decides (the built-in look comes last).
  const newStyle =
    owned("spinner-top") || owned("spinner-background")
      ? owned("spinner-top") && !owned("spinner-background")
      : regions.has("spinner-top") && !regions.has("spinner-background");
  if (newStyle) {
    // LegacyNewStyleSpinner: a container scaled with progress holds the glow,
    // the bottom (a third of the top's turn), the top (half the turn when
    // spinner-middle2 exists), middle2 (the full turn) and the fixed middle,
    // which turns red over the spinner.
    const turn = regions.has("spinner-middle2") ? 0.5 : 1;
    // The glow flashes white on each bonus tick (FlashColour, 200 ms).
    const glow = [3 / 255, 151 / 255, 1] as const,
      bonus: number[] = [];
    for (let k = timing.required + 2; k < timing.ticks; k++) {
      const time = o.time + (k + 1) * timing.spin;
      if (time < o.endTime) bonus.push(time);
    }
    const flashes = [-1e9, ...bonus];
    for (let i = 0; i < flashes.length; i++)
      part(
        "spinner-glow",
        256,
        centreY,
        SpinnerRole.glow,
        flashes[i],
        glow,
        [Math.max(from, flashes[i]), flashes[i + 1] ?? until],
        SPRITE_SCALE,
        13,
      );
    part(
      "spinner-bottom",
      256,
      centreY,
      SpinnerRole.scaled,
      direction * (turn / 3),
    );
    part("spinner-top", 256, centreY, SpinnerRole.scaled, direction * turn);
    part("spinner-middle2", 256, centreY, SpinnerRole.scaled, direction);
    part("spinner-middle", 256, centreY, SpinnerRole.middle);
    // Only a skin's own spinner-top brings the approach circle.
    if (owned("spinner-top"))
      part(
        "spinner-approachcircle",
        256,
        centreY,
        SpinnerRole.approach,
        0,
        undefined,
        undefined,
        SPRITE_SCALE * 1.86,
      );
  } else {
    // LegacyOldStyleSpinner: background, the turning disc, the metre and the
    // approach circle, each at SPRITE_SCALE in the box.
    const colours = skin?.sections.get("Colours")?.[0];
    part(
      "spinner-background",
      256,
      centreY,
      SpinnerRole.static,
      0,
      colourOf(colours?.SpinnerBackground) ?? [100 / 255, 100 / 255, 100 / 255],
    );
    part("spinner-circle", 256, centreY, SpinnerRole.turn, direction);
    metre(add, o, timing, regions, skin, from, until);
    part(
      "spinner-approachcircle",
      256,
      centreY,
      SpinnerRole.approach,
      0,
      undefined,
      undefined,
      SPRITE_SCALE * 1.86,
    );
  }
  // LegacySpinner: the RPM box slides up 50 units while the spinner fades in,
  // "spin" fades in over the second half of that and fades over 300 ms from
  // each spin (spinner tick) autoplay completes, "clear" pops in on completion.
  if (regions.has("spinner-rpm")) {
    const [w, h] = size("spinner-rpm");
    add(
      256 - 87 + w / 2,
      BOX_Y + 445 + h / 2,
      w,
      h,
      o.time,
      o.endTime,
      from,
      until,
      [1, 1, 1],
      10,
      SPINNER_PART,
      SpinnerRole.rpm,
      0,
      0,
      "spinner-rpm",
      0,
      0,
      0,
      undefined,
      true,
    );
  }
  spin(part, o, timing, fadeIn);
  if (completed !== Infinity)
    part(
      "spinner-clear",
      256,
      BOX_Y + TOP_OFFSET + 115,
      SpinnerRole.clear,
      0,
      undefined,
      [Math.min(completed, o.endTime - 400), o.endTime],
    );
}

/** "spinner-spin": its fade in, then a fade from every completed spin. */
function spin(
  part: (
    name: string,
    x: number,
    y: number,
    role: number,
    parameter?: number,
    colour?: readonly number[],
    window?: readonly [number, number],
  ) => void,
  o: HitObject,
  timing: SpinnerTiming,
  fadeIn: number,
) {
  const y = BOX_Y + TOP_OFFSET + 335,
    hits: number[] = [];
  for (let k = 1; k <= timing.ticks; k++) {
    const time = o.time + k * timing.spin;
    if (time >= o.endTime) break;
    hits.push(time);
  }
  if (!hits.length) {
    // No spin completes: FadeOutFromOne over the spinner's last 400 ms.
    const last = Math.min(400, o.endTime - o.time);
    part("spinner-spin", 256, y, SpinnerRole.spinIn, 0, undefined, [
      o.time - fadeIn / 2,
      o.endTime - last,
    ]);
    part(
      "spinner-spin",
      256,
      y,
      SpinnerRole.spinOut,
      o.endTime - last,
      [1, 1, 1, 1],
      [o.endTime - last, o.endTime],
    );
    return;
  }
  part("spinner-spin", 256, y, SpinnerRole.spinIn, 0, undefined, [
    o.time - fadeIn / 2,
    hits[0],
  ]);
  // Each tick's FadeOut(300) starts from the alpha the previous one left.
  let alpha = 1;
  for (let i = 0; i < hits.length && alpha > 0.004; i++) {
    const next = hits[i + 1] ?? o.endTime + 240;
    part(
      "spinner-spin",
      256,
      y,
      SpinnerRole.spinOut,
      hits[i],
      [1, 1, 1, alpha],
      [hits[i], next],
    );
    alpha *= Math.max(0, 1 - (next - hits[i]) / 300);
  }
}

/**
 * `LegacyOldStyleSpinner`'s metre: a masked view of the image's bottom,
 * one tenth of 692 units per bar. Lazer adds a blinking extra bar at random
 * (`SpinnerNoBlink` off): drawn here as its most likely frame, rounding the
 * progress to the nearest bar (capped at 99 %).
 */
function metre(
  add: OsuEmit,
  o: HitObject,
  timing: SpinnerTiming,
  regions: Map<string, AtlasRegion>,
  skin: Skin | undefined,
  from: number,
  until: number,
) {
  const region = regions.get("spinner-metre");
  if (!region) return;
  const blink = !legacyBool(skin?.sections.get("General")?.[0]?.SpinnerNoBlink);
  const W = (region.width ?? 0) * SPRITE_SCALE,
    H = (region.height ?? 0) * SPRITE_SCALE,
    full = timing.required * timing.spin;
  const bars = (progress: number) => {
    const p = (blink ? Math.min(0.99, progress) : progress) * 10;
    return Math.min(10, Math.floor(p) + (blink && p % 1 >= 0.5 ? 1 : 0));
  };
  // When each bar count starts showing.
  const changes: [number, number][] = [[from, bars(timing.required ? 0 : 1)]];
  if (timing.required)
    for (let k = 1; k <= 10; k++) {
      const threshold = blink ? (k - 0.5) / 10 : k / 10;
      if (blink && threshold > 0.99) break;
      const time = o.time + threshold * full;
      if (time < o.endTime) changes.push([time, bars(threshold + 1e-9)]);
    }
  for (let i = 0; i < changes.length; i++) {
    const [start, count] = changes[i],
      visible = Math.min(H, H - (METRE_HEIGHT - (count / 10) * METRE_HEIGHT)),
      top = H - visible;
    if (visible <= 0) continue;
    add(
      BOX_X + W / 2,
      BOX_Y + TOP_OFFSET + top + visible / 2,
      W,
      visible,
      o.time,
      o.endTime,
      start,
      changes[i + 1]?.[0] ?? until,
      [1, 1, 1],
      10,
      SPINNER_PART,
      SpinnerRole.static,
      0,
      0,
      "spinner-metre",
      0,
      0,
      0,
      undefined,
      true,
      undefined,
      [top / H, 1],
    );
  }
}

/** A path piece of a slider span: from `a` at `start` to `b` at `end`. */
interface Piece {
  a: Point;
  b: Point;
  start: number;
  end: number;
}

/**
 * The ball's path over the slider (`DrawableSliderBall.UpdateProgress`),
 * one piece per path segment and span, in time order.
 */
function ballPieces(o: HitObject, offset: number): Piece[] {
  const pieces: Piece[] = [];
  for (let repeat = 0; repeat < o.repeats; repeat++) {
    const reverse = repeat % 2 === 1,
      spanStart = o.time + o.span * repeat;
    let cumulative = 0;
    const span: Piece[] = [];
    for (let i = 1; i < o.path.length; i++) {
      const a = o.path[i - 1],
        b = o.path[i],
        length = Math.hypot(b.x - a.x, b.y - a.y),
        first = cumulative / Math.max(o.length, 1),
        last = (cumulative + length) / Math.max(o.length, 1);
      cumulative += length;
      const start = spanStart + (reverse ? 1 - last : first) * o.span,
        end = spanStart + (reverse ? 1 - first : last) * o.span,
        p = { x: a.x - offset, y: a.y - offset },
        q = { x: b.x - offset, y: b.y - offset };
      span.push(
        reverse ? { a: q, b: p, start, end } : { a: p, b: q, start, end },
      );
    }
    if (reverse) span.reverse();
    pieces.push(...span);
  }
  return pieces;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/** A follow circle segment: from `time`, a press (0), tick pop (1) or end (2). */
interface FollowEvent {
  time: number;
  type: 0 | 1 | 2;
  /** Press: time left in the slider; end: the scale it starts from. */
  parameter: number;
}

/**
 * `LegacyFollowCircle` under autoplay (tracking from the start): it grows
 * from 1 to 2 over 180 ms (out) while fading in over 60, pops to 2.2 easing
 * back over 200 ms on every tick and repeat once fully grown, and at the end
 * grows to 1.6 (out) while fading (in) over 200 ms.
 */
export function followEvents(o: HitObject): FollowEvent[] {
  const events: FollowEvent[] = [
    { time: o.time, type: 0, parameter: o.endTime - o.time },
  ];
  const scaleAt = (time: number) => {
    const last = events[events.length - 1],
      dt = time - last.time;
    return last.type === 0
      ? 1 +
          easeOut(
            Math.min(1, dt / Math.max(1e-9, Math.min(180, last.parameter))),
          )
      : 2.2 - 0.2 * Math.min(1, dt / 200);
  };
  const pops: number[] = [];
  for (let repeat = 0; repeat < o.repeats; repeat++) {
    const reverse = repeat % 2 === 1,
      spanStart = o.time + o.span * repeat;
    for (const t of o.ticks)
      pops.push(spanStart + (reverse ? 1 - t : t) * o.span);
    if (repeat < o.repeats - 1) pops.push(spanStart + o.span);
  }
  pops.sort((a, b) => a - b);
  for (const time of pops)
    if (time < o.endTime && scaleAt(time) >= 2 - 1e-6)
      events.push({ time, type: 1, parameter: 0 });
  events.push({ time: o.endTime, type: 2, parameter: scaleAt(o.endTime) });
  return events;
}

/** The legacy slider ball (under the follow circle) for slider `o`. */
export function sliderBall(
  add: OsuEmit,
  o: HitObject,
  offset: number,
  combo: readonly number[],
  regions: Map<string, AtlasRegion>,
  skin: Skin | undefined,
  radius: number,
  preempt: number,
): void {
  // Both animations play from DrawableSlider's AnimationStartTime (its
  // initial transforms: start time minus preempt).
  const animationStart = o.time - preempt;
  // OsuHitObject.Scale (CalculateScaleFromCircleSize, with stable's fudge).
  const scale = (radius / 64) * 1.00041;
  const pieces = ballPieces(o, offset),
    end = pathPosition(o.path, o.repeats % 2 ? 1 : 0),
    endPoint = { x: end.x - offset, y: end.y - offset };
  // GetTextures: an animation's frames (sliderb0, sliderb1, ...) replace
  // the plain image, so its first frame sets the size.
  const fit = (name: string) => {
    const region =
        regions.get(name === "sliderb" ? "sliderb0" : `${name}-0`) ??
        regions.get(name),
      width = region?.width ?? 0,
      height = region?.height ?? 0,
      crop = [
        Math.min(1, MAX_BALL_AREA / Math.max(width, 1e-9)),
        Math.min(1, MAX_BALL_AREA / Math.max(height, 1e-9)),
      ] as const;
    return {
      w: width * crop[0],
      h: height * crop[1],
      crop: crop[0] < 1 || crop[1] < 1 ? crop : undefined,
    };
  };
  if (regions.has("sliderfollowcircle")) {
    const { w, h, crop } = fit("sliderfollowcircle"),
      events = followEvents(o);
    // The content is drawn at half its size; the circle's scale (1 to 2.2)
    // applies on top, so 2 is the image at the object's scale.
    const size = [w * 0.5 * scale, h * 0.5 * scale];
    const emit = (
      piece: Piece,
      event: FollowEvent,
      from: number,
      until: number,
      shown = until,
    ) => {
      const at = (time: number) => {
        const f = Math.max(
          0,
          Math.min(
            1,
            (time - piece.start) / Math.max(0.01, piece.end - piece.start),
          ),
        );
        return {
          x: piece.a.x + (piece.b.x - piece.a.x) * f,
          y: piece.a.y + (piece.b.y - piece.a.y) * f,
        };
      };
      const p = at(from),
        q = at(until);
      add(
        p.x,
        p.y,
        size[0],
        size[1],
        from,
        until,
        from,
        shown,
        [event.time, event.type, event.parameter],
        10,
        FOLLOW_CIRCLE,
        q.x,
        q.y,
        animationStart,
        "sliderfollowcircle",
        0,
        0,
        0,
        undefined,
        false,
        crop,
      );
    };
    // Half-open pieces (0.5 ms survives float32 times), so neighbours never
    // draw together.
    for (let k = 0; k < events.length - 1; k++) {
      const event = events[k],
        next = events[k + 1].time;
      for (const piece of pieces) {
        const from = Math.max(piece.start, event.time),
          until = Math.min(piece.end, next);
        if (until > from) emit(piece, event, from, until, until - 0.5);
      }
    }
    // The end: in place, growing and fading while the slider fades (240 ms).
    emit(
      { a: endPoint, b: endPoint, start: o.endTime, end: o.endTime + 200 },
      events[events.length - 1],
      o.endTime,
      o.endTime + 200,
    );
  }
  const colours = skin?.sections.get("Colours")?.[0],
    tint = legacyBool(skin?.sections.get("General")?.[0]?.AllowSliderBallTint)
      ? combo
      : (colourOf(colours?.SliderBall) ?? [1, 1, 1]);
  // LegacySliderBall: sliderb-nd (very dark) under the ball, sliderb-spec
  // (additive) over it; only the ball turns with the path. Its frames last
  // max(0.15 / velocity, 1) × 16.67 ms.
  const velocity = o.length / Math.max(1e-9, o.span),
    fps = 1000 / (Math.max(0.15 / Math.max(velocity, 1e-9), 1) * (1000 / 60));
  for (const [name, colour, kind, shape] of [
    ["sliderb-nd", [5 / 255, 5 / 255, 5 / 255], 5, 10],
    ["sliderb", tint, SLIDER_BALL, 10],
    ["sliderb-spec", [1, 1, 1], 5, 13],
  ] as const) {
    if (!regions.has(name)) continue;
    const { w, h, crop } = fit(name);
    for (const [i, piece] of pieces.entries())
      add(
        piece.a.x,
        piece.a.y,
        w * scale,
        h * scale,
        piece.start,
        piece.end,
        piece.start,
        i < pieces.length - 1 ? piece.end - 0.5 : o.endTime - 0.5,
        colour,
        shape,
        kind,
        piece.b.x,
        piece.b.y,
        animationStart,
        name,
        0,
        0,
        0,
        undefined,
        false,
        crop,
        undefined,
        name === "sliderb" ? fps : undefined,
      );
  }
}
