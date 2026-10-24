/**
 * osu!taiko with legacy skins, laid out as osu!lazer lays it out. Ported from
 * ppy/osu at 2026.1005.0-lazer (MIT): `TaikoPlayfieldAdjustmentContainer`,
 * `TaikoPlayfield`, `DrawableTaikoRuleset` (scroller, time range), the
 * overlapping scroll algorithm, and osu.Game.Rulesets.Taiko/Skinning/Legacy
 * (`LegacyTaikoScroller`, `TaikoLegacyPlayfieldBackgroundRight`,
 * `LegacyInputDrum`, `TaikoLegacyHitTarget`, `LegacyCirclePiece`,
 * `LegacyDrumRoll`, `LegacyBarLine`, `LegacySwell`, `LegacyHitExplosion`),
 * with `DrawableHit`'s hit animation and `DrawableDrumRoll`'s colours.
 *
 * Positions are computed in lazer units and converted to render-core's world
 * (the 640×480 view centred on osu! pixel (256, 192)). The layout depends on
 * the window's aspect ratio, so a resize recompiles the scene.
 */
import {
  timingAt,
  taikoVelocity,
  type Beatmap,
  type HitObject,
} from "@vosu-tools/osu-parse";
import { hasFrames, type AtlasRegion, type Skin } from "./skin";
import {
  taikoJudgements,
  taikoNoteResults,
  type JudgementEvent,
  type Marks,
} from "./judgements";
import { drumFlashes } from "./gameplay";
import type { InputFrame } from "./scene";

/** Emits one instance (scene.ts `add`). */
export type Emit = (
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

/** Lazer's game space for a window of `aspect` (a 1024×768 draw-size-preserving container). */
export function gameSpace(aspect: number): { width: number; height: number } {
  return aspect >= 4 / 3
    ? { width: 768 * aspect, height: 768 }
    : { width: 1024, height: 1024 / aspect };
}

/** Lazer game-space units per render-core world unit (768 / 480). */
export const SPACE_SCALE = 1.6;

export interface TaikoLayout {
  space: { width: number; height: number };
  /** Playfield scale (1 between 5:4 and 16:9). */
  scale: number;
  /** Playfield top in game space. */
  top: number;
  /** Playfield width in its own units. */
  width: number;
  /** `ComputeTimeRange`, ms. */
  timeRange: number;
  /** Scroll length (the hit object container's width), playfield units. */
  length: number;
}

const BASE_HEIGHT = 200,
  MAXIMUM_ASPECT = 16 / 9,
  MINIMUM_ASPECT = 5 / 4,
  /** Hit position: input drum (180) + hit target width / 2 (100) - 24. */
  HIT_X = 256,
  /** The masked hit object area starts after the input drum. */
  MASK_X = 180,
  DEFAULT_SIZE = 0.475 * BASE_HEIGHT,
  STRONG_SIZE = (0.475 / 0.65) * BASE_HEIGHT,
  CIRCLE_PIECE = 128,
  MAX_CIRCLE_SPRITE = 160;

/** `TaikoPlayfieldAdjustmentContainer` with the playfield aspect range locked (lazer's default). */
export function taikoLayout(aspect: number): TaikoLayout {
  const space = gameSpace(aspect),
    current = space.width / space.height;
  let relative = BASE_HEIGHT / 768;
  if (current > MAXIMUM_ASPECT) relative *= current / MAXIMUM_ASPECT;
  else if (current < MINIMUM_ASPECT) relative *= current / MINIMUM_ASPECT;
  relative = Math.min(relative, 1 / 3);
  const scale = (space.height / 768) * (relative / (BASE_HEIGHT / 768)),
    width = space.width / scale,
    clamped = Math.min(MAXIMUM_ASPECT, Math.max(MINIMUM_ASPECT, current));
  return {
    space,
    scale,
    top: (135 / 480) * space.height,
    width,
    timeRange: (((clamped * 480 - 160) / 100) * 1000) / 1.4,
    length: width - HIT_X,
  };
}

/**
 * Image display size; larger images are cropped to `max` around their centre
 * like osu!'s `WithMaximumSize`. Returns the size and the kept fractions.
 */
export function capped(
  uv: AtlasRegion | undefined,
  max = Infinity,
): { w: number; h: number; crop?: [number, number] } {
  const w = uv?.width ?? 0,
    h = uv?.height ?? 0;
  if (w <= max && h <= max) return { w, h };
  const cw = Math.min(w, max),
    ch = Math.min(h, max);
  return {
    w: cw,
    h: ch,
    crop: [cw / Math.max(w, 1e-9), ch / Math.max(h, 1e-9)],
  };
}
const fit = (uv: AtlasRegion | undefined): [number, number] => [
  uv?.width ?? 0,
  uv?.height ?? 0,
];

const disallowZeroAlpha = (c: readonly number[]) =>
  c.length > 3 && c[3] === 0 ? [c[0], c[1], c[2], 1] : c;

export interface TaikoScene {
  /** World x left of which scrolling hit objects are masked. */
  clipX: number;
}

/**
 * Emits osu!taiko for `aspect`. `barLines` are the bar line times
 * (`BarLineGenerator`). Instances are emitted in lazer's draw order. With a
 * replay's `judgements`, notes are hit or missed when the replay says, and
 * explosions and judgements follow its results.
 */
export function compileTaiko(
  map: Beatmap,
  options: {
    noteSpeed?: number;
    judgements?: readonly JudgementEvent[];
    taikoTopArea?: boolean;
    input?: readonly InputFrame[];
  },
  regions: Map<string, AtlasRegion>,
  skin: Skin | undefined,
  add: Emit,
  aspect: number,
  barLines: readonly number[],
  marks?: Marks,
): TaikoScene {
  const layout = taikoLayout(aspect),
    { space, scale: k, top } = layout,
    s = k / SPACE_SCALE;
  /** Game space to world. */
  const wx = (x: number) => 256 + (x - space.width / 2) / SPACE_SCALE,
    wy = (y: number) => 192 + (y - space.height / 2) / SPACE_SCALE;
  /** Playfield units to world. */
  const px = (x: number) => wx(x * k),
    py = (y: number) => wy(top + y * k);
  const hitX = px(HIT_X),
    midY = py(BASE_HEIGHT / 2),
    noteSpeed = options.noteSpeed ?? 1;
  /** Overlapping scroll: world units per ms for an object at `time`. */
  const velocity = (time: number) =>
    (taikoVelocity(map, time, noteSpeed) / 0.14 / layout.timeRange) *
    layout.length *
    s;
  const forever = [-1e9, 1e9] as const,
    white = [1, 1, 1] as const;
  const style = skin?.style?.taiko;

  // LegacyTaikoScroller: a strip above the playfield, 1/20 of the playfield
  // into it, scrolling left at 0.1 units/ms; behind everything. Optional
  // (`taikoTopArea`): without it the scene starts at the playfield's top.
  const scroller =
    options.taikoTopArea === false ? undefined : regions.get("taiko-slider");
  if (scroller) {
    const [sw, sh] = fit(scroller),
      height = top + (BASE_HEIGHT * k) / 20,
      width = (height * sw) / Math.max(sh, 1e-9);
    for (let i = 0; i <= Math.ceil(space.width / width); i++)
      add(
        wx(i * width + width / 2),
        wy(height / 2),
        width / SPACE_SCALE,
        height / SPACE_SCALE,
        0,
        0,
        ...forever,
        white,
        4,
        23,
        0.1 / SPACE_SCALE,
        width / SPACE_SCALE,
        0,
        "taiko-slider",
      );
  }

  // TaikoLegacyPlayfieldBackgroundRight: the whole playfield, with its kiai glow.
  const right = regions.has("taiko-bar-right");
  if (right) {
    add(
      wx(space.width / 2),
      py(BASE_HEIGHT / 2),
      space.width / SPACE_SCALE,
      BASE_HEIGHT * s,
      0,
      0,
      ...forever,
      white,
      4,
      0,
      0,
      0,
      0,
      "taiko-bar-right",
    );
    if (regions.has("taiko-bar-right-glow"))
      for (const [start, end] of kiaiSections(map))
        add(
          wx(space.width / 2),
          py(BASE_HEIGHT / 2),
          space.width / SPACE_SCALE,
          BASE_HEIGHT * s,
          0,
          0,
          ...forever,
          white,
          4,
          28,
          start,
          end,
          200,
          "taiko-bar-right-glow",
        );
  } else
    add(
      wx(space.width / 2),
      py(BASE_HEIGHT / 2),
      space.width / SPACE_SCALE,
      BASE_HEIGHT * s,
      0,
      0,
      ...forever,
      [0.09, 0.09, 0.1],
      4,
    );

  // LegacyInputDrum's bar, at its own size from the playfield's top-left
  // (drawn through a proxy beneath the hit objects).
  const barLeft = regions.get("taiko-bar-left");
  if (barLeft) {
    const [w, h] = fit(barLeft);
    add(
      px(w / 2),
      py(h / 2),
      w * s,
      h * s,
      0,
      0,
      ...forever,
      white,
      4,
      0,
      0,
      0,
      0,
      "taiko-bar-left",
    );
    // LegacyInputDrum's half drums flash on the replay's presses.
    if (options.input && marks)
      drumFlashes(options.input, marks, px, py, s, skin?.version ?? 1);
  }

  // DrawableTaikoMascot above the drum, with the strip above the playfield.
  if (marks && options.taikoTopArea !== false)
    taikoMascot(
      map,
      options.judgements,
      marks,
      px,
      py,
      s,
      Math.min(0, (map.objects[0]?.time ?? 0) - 2000),
      map.duration + 3000,
    );

  // LegacyKiaiGlow behind the explosions and hit target.
  if (marks) taikoKiaiGlow(map, options.judgements, marks, hitX, midY, s);

  // LegacyHitExplosion under the hit target: fades in for 120 ms and out for
  // 180 ms, popping 0.6 → 1.1 → 0.9 → 1 when not animated. A replay's results
  // pick the explosion (taiko-hit0/100/300); previews show great hits.
  const judged =
    options.judgements && marks
      ? taikoJudgements({
          events: options.judgements,
          marks,
          skin,
          x: hitX,
          y: midY,
          scale: s,
        })
      : undefined;
  // Without a replay, lazer's autoplay hits every note (Great): skins without
  // explosions of their own show its judgements.
  const autoJudged =
    !options.judgements && marks
      ? taikoJudgements({
          events: map.objects.flatMap((o, i): JudgementEvent[] =>
            o.type & (2 | 8)
              ? []
              : [
                  {
                    time: o.time,
                    result: "great",
                    note: i,
                    object: "hit",
                    x: 0,
                    y: 0,
                    combo: i + 1,
                  },
                ],
          ),
          marks,
          skin,
          x: hitX,
          y: midY,
          scale: s,
        })
      : undefined;
  const results = options.judgements
    ? taikoNoteResults(options.judgements)
    : undefined;
  const explosion = judged ? undefined : regions.get("taiko-hit300");
  judged?.explosions();
  if (explosion)
    for (const o of map.objects) {
      if (o.type & (2 | 8)) continue;
      const big = !!(o.sound & 4),
        asset =
          big && regions.has("taiko-hit300k")
            ? "taiko-hit300k"
            : "taiko-hit300",
        region = regions.get(asset)!,
        // GetAnimation(hitName, animatable, not looping): the frames (even a
        // single name-0) replace the plain image, at 60 fps.
        [w, h] = fit(
          hasFrames(region) ? (regions.get(`${asset}-0`) ?? region) : region,
        );
      add(
        hitX,
        midY,
        w * s,
        h * s,
        o.time,
        o.time + 300,
        o.time,
        o.time + 300,
        white,
        0,
        27,
        (region.count ?? 1) > 1 ? 0 : 1,
        0,
        0,
        asset,
        0,
        0,
        0,
        undefined,
        false,
        undefined,
        undefined,
        60,
      );
    }

  // TaikoLegacyHitTarget, at the hit position.
  if (regions.has("taikobigcircle")) {
    for (const [asset, factor, alpha] of [
      ["approachcircle", 0.83, 0.47],
      ["taikobigcircle", 0.8, 0.22],
    ] as const) {
      const [w, h] = fit(regions.get(asset));
      if (w > 0)
        add(
          hitX,
          midY,
          w * factor * s,
          h * factor * s,
          0,
          0,
          ...forever,
          [1, 1, 1, alpha],
          4,
          0,
          0,
          0,
          0,
          asset,
          0,
          0,
          0,
          undefined,
          true,
        );
    }
  } else
    add(
      hitX,
      midY,
      DEFAULT_SIZE * s,
      DEFAULT_SIZE * s,
      0,
      0,
      ...forever,
      [1, 1, 1, 0.5],
      1,
    );

  // Bar lines (LegacyBarLine: the image filled into 2 × 0.88 of the height,
  // fading over 150 ms once they pass the hit position; not masked).
  const barLine = regions.get("taiko-barline");
  for (const time of barLines) {
    const v = velocity(time);
    if (barLine) {
      const [bw, bh] = fit(barLine),
        fill = Math.max(
          2 / Math.max(bw, 1e-9),
          (0.88 * BASE_HEIGHT) / Math.max(bh, 1e-9),
        ),
        w = bw * fill * s,
        h = bh * fill * s;
      add(
        hitX - w / 2,
        midY,
        w,
        h,
        time,
        time + 150,
        time - 1e5,
        time + 150,
        white,
        4,
        31,
        v,
        0,
        0,
        "taiko-barline",
      );
    } else
      add(
        hitX - s,
        midY,
        2 * s,
        0.88 * BASE_HEIGHT * s,
        time,
        time + 150,
        time - 1e5,
        time + 150,
        [0.35, 0.35, 0.38, 0.55],
        4,
        31,
        v,
      );
  }

  /** LegacyCirclePiece's two layers, scaled to the drawable's height. */
  const circle = (big: boolean, layer: "circle" | "circleoverlay") => {
    const asset =
        big && regions.has(`taikobig${layer}`)
          ? `taikobig${layer}`
          : `taikohit${layer}`,
      { w, h, crop } = capped(regions.get(asset), MAX_CIRCLE_SPRITE),
      size = (big ? STRONG_SIZE : DEFAULT_SIZE) / CIRCLE_PIECE;
    return {
      asset,
      w: w * size * s,
      h: h * size * s,
      crop,
      exists: regions.has(asset),
    };
  };
  const centreColour = disallowZeroAlpha(
      style?.centre ?? [235 / 255, 69 / 255, 44 / 255],
    ),
    rimColour = disallowZeroAlpha(
      style?.rim ?? [67 / 255, 142 / 255, 172 / 255],
    );
  const idle = [0xee / 255, 0xaa / 255, 0],
    engaged = [0xcc / 255, 0x66 / 255, 0];
  const flying: (() => void)[] = [];

  // Hit objects, the latest first so earlier ones draw on top.
  for (let i = map.objects.length - 1; i >= 0; i--) {
    const o = map.objects[i],
      big = !!(o.sound & 4),
      v = velocity(o.time),
      // Overlapping scroll: an object enters at the far edge.
      lead =
        (layout.timeRange / (taikoVelocity(map, o.time, noteSpeed) / 0.14)) *
          1.1 +
        200;
    if (o.type & 8) swell(o, v, lead);
    else if (o.type & 2) drumRoll(o, big, v, lead);
    else {
      const colour = o.sound & 10 ? rimColour : centreColour;
      // With a replay's results a note leaves when it is hit, scrolling on
      // from wherever it was; a missed note scrolls past the hit target and
      // fades over 100 ms once judged (DrawableHit). The scroll anchor moves
      // to the result time, so positions stay those of the note's own time.
      const result = results?.get(i),
        anchor = result?.time ?? o.time,
        x = hitX + (o.time - anchor) * v,
        missed = result !== undefined && !result.hit,
        kind = missed ? 36 : 3,
        fade = missed ? 100 : 0,
        until = missed ? anchor + 100 : anchor;
      for (const [layer, tint] of [
        ["circle", colour],
        ["circleoverlay", white],
      ] as const) {
        const piece = circle(big, layer);
        if (!piece.exists) {
          // No skin image: a plain disc of the drawable's size.
          if (layer === "circle") {
            const d = (big ? STRONG_SIZE : DEFAULT_SIZE) * s;
            add(
              x,
              midY,
              d,
              d,
              anchor,
              anchor,
              o.time - lead,
              until,
              colour,
              0,
              kind,
              v,
              fade,
            );
          }
          continue;
        }
        add(
          x,
          midY,
          piece.w,
          piece.h,
          anchor,
          anchor,
          o.time - lead,
          until,
          tint,
          0,
          kind,
          v,
          fade,
          0,
          piece.asset,
          0,
          0,
          0,
          undefined,
          true,
          piece.crop,
        );
        if (missed) continue;
        // DrawableHit's hit animation: proxied above the playfield, it rises
        // 200 units (300 ms, out), falls 600 (600 ms, in), shrinks to 0.8
        // and fades over 800 ms while still scrolling.
        flying.push(() =>
          add(
            x,
            midY,
            piece.w,
            piece.h,
            anchor,
            anchor + 800,
            anchor + 1,
            anchor + 800,
            tint,
            0,
            25,
            v,
            s,
            0,
            piece.asset,
            0,
            0,
            0,
            undefined,
            true,
          ),
        );
      }
    }
  }
  // Judgements sit over the hit target, under the flying hits.
  (judged ?? autoJudged)?.judgements();
  for (const emit of flying) emit();

  function drumRoll(o: HitObject, big: boolean, v: number, lead: number): void {
    const size = (big ? STRONG_SIZE : DEFAULT_SIZE) * s,
      head = circle(big, "circle"),
      overlay = circle(big, "circleoverlay"),
      length = (o.endTime - o.time) * v,
      middle = regions.get("taiko-roll-middle"),
      end = regions.get("taiko-roll-end"),
      t = timingAt(map.timing, o.time),
      spacing = t.beatLength / (map.difficulty.sliderTickRate === 3 ? 3 : 4),
      ticks: number[] = [];
    if (spacing > 0)
      for (let time = o.time; time < o.endTime + spacing / 2; time += spacing)
        ticks.push(time);
    // DrawableDrumRoll: YellowDark, moving towards YellowDarker with each of
    // the first five rolling hits (autoplay hits every tick), each change
    // fading over 100 ms; colours mix in linear light.
    const segments = rollColours(o.time - lead, o.endTime + 100, ticks).map(
      ([from, until, f]) => [from, until, mixLinear(idle, engaged, f)] as const,
    );
    // Drawn as one masked piece scrolling with the roll's start: body from
    // the head's centre, the tail fitted to the right, the head on top.
    for (const [from, until, colour] of segments) {
      if (!middle && !head.exists)
        add(
          hitX - size / 2,
          midY,
          length + size,
          size,
          o.time,
          o.endTime,
          from,
          until,
          colour,
          2,
          4,
          v,
        );
      if (middle)
        add(
          hitX,
          midY,
          length,
          size,
          o.time,
          o.endTime,
          from,
          until,
          colour,
          4,
          4,
          v,
          0,
          0,
          "taiko-roll-middle",
          0,
          0,
          0,
          undefined,
          true,
        );
      if (end) {
        const [w, h] = fit(end),
          fitScale = Math.min(
            size / Math.max(w * s, 1e-9),
            size / Math.max(h * s, 1e-9),
          );
        add(
          hitX + length,
          midY,
          w * s * fitScale,
          h * s * fitScale,
          o.time,
          o.endTime,
          from,
          until,
          colour,
          4,
          4,
          v,
          0,
          0,
          "taiko-roll-end",
          0,
          0,
          0,
          undefined,
          true,
        );
      }
      if (head.exists)
        add(
          hitX - head.w / 2,
          midY,
          head.w,
          head.h,
          o.time,
          o.endTime,
          from,
          until,
          colour,
          4,
          4,
          v,
          0,
          0,
          head.asset,
          0,
          0,
          0,
          undefined,
          true,
          head.crop,
        );
    }
    if (overlay.exists)
      add(
        hitX - overlay.w / 2,
        midY,
        overlay.w,
        overlay.h,
        o.time,
        o.endTime,
        o.time - lead,
        o.endTime + 100,
        white,
        4,
        4,
        v,
        0,
        0,
        overlay.asset,
        0,
        0,
        0,
        undefined,
        true,
        overlay.crop,
      );
    // Ticks (sliderscorepoint at its own size), above the body; hidden once hit.
    const tick = regions.get("sliderscorepoint");
    for (const time of ticks) {
      if (tick) {
        const [w, h] = fit(tick);
        // DrawableDrumRollTick: once hit, it grows to 1.4× and fades over 200 ms (out quint).
        add(
          hitX,
          midY,
          w * s,
          h * s,
          time,
          time + 200,
          time - lead,
          time + 200,
          white,
          0,
          32,
          v,
          0,
          0,
          "sliderscorepoint",
          0,
          0,
          0,
          undefined,
          true,
        );
      } else
        add(
          hitX,
          midY,
          6 * s,
          6 * s,
          time,
          time,
          time - lead,
          time,
          [0.8, 0.35, 0.05],
          0,
          3,
          v,
        );
    }
  }

  function swell(o: HitObject, v: number, lead: number): void {
    // LegacySwell: the warning scrolls in like a note; while active, the
    // spinner circle and a shrinking approach circle sit 250, 100 units
    // from the hit position, fading in over 200 ms and out over 300 ms.
    const warning = regions.get("spinner-warning");
    if (warning) {
      const [w, h] = fit(warning);
      add(
        hitX,
        midY,
        w * s,
        h * s,
        o.time,
        o.time,
        o.time - lead,
        o.time,
        white,
        0,
        3,
        v,
        0,
        0,
        "spinner-warning",
        0,
        0,
        0,
        undefined,
        true,
      );
    }
    const x = px(HIT_X + 250),
      y = py(BASE_HEIGHT / 2 + 100);
    // TaikoBeatmapConverter's required hits and TaikoAutoGenerator's hits
    // (at most every 50 ms): the body fades out (300 ms, out quad) from the
    // moment the last required hit lands.
    const od = map.difficulty.od,
      perSecond =
        (od > 5 ? 5 + (2.5 * (od - 5)) / 5 : 5 + (2 * (od - 5)) / 5) *
        Math.fround(1.65),
      required = Math.max(
        1,
        Math.trunc(((o.endTime - o.time) / 1000) * perSecond),
      ),
      rate = Math.min(50, (o.endTime - o.time) / required),
      hits: number[] = [];
    for (let t = o.time; t < o.endTime && hits.length < required; t += rate)
      hits.push(t);
    const done = hits.length === required ? hits[required - 1] : o.endTime;
    const circleRegion = regions.get("spinner-circle");
    if (!circleRegion)
      add(
        x,
        y,
        200 * s,
        200 * s,
        o.time,
        done + 300,
        o.time,
        done + 300,
        [1, 0.9, 0.2],
        1,
        33,
        o.time,
        done,
      );
    else {
      // The spinner circle grows 0.02 per hit (at most 0.94), relaxing back to
      // 0.8 with a 120 ms half-life; on completion it eases 0.05 larger.
      const [w, h] = fit(circleRegion);
      for (const [from, until, scale, angle] of swellCircle(
        o.time,
        done + 300,
        hits,
        done,
      ))
        add(
          x,
          y,
          w * scale * s,
          h * scale * s,
          o.time,
          done + 300,
          from,
          until,
          white,
          0,
          33,
          o.time,
          done,
          angle,
          "spinner-circle",
        );
    }
    const approach = regions.get("spinner-approachcircle");
    if (approach) {
      const [w, h] = fit(approach);
      add(
        x,
        y,
        w * 1.488 * s,
        h * 1.488 * s,
        o.time,
        o.endTime,
        o.time,
        done + 300,
        [1, 1, 1, 0.8],
        0,
        34,
        o.time,
        done,
        0,
        "spinner-approachcircle",
      );
    }
  }

  return { clipX: px(MASK_X) };
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
/** osu!framework's colour interpolation: in linear light. */
function mixLinear(
  a: readonly number[],
  b: readonly number[],
  f: number,
): number[] {
  return a.map((c, i) =>
    toSrgb(toLinear(c) + (toLinear(b[i]) - toLinear(c)) * f),
  );
}

/**
 * Drum roll colour over time as [from, until, fraction towards engaged]:
 * each hit sets the target to min(hits, 5) / 5 and the colour moves there
 * linearly over 100 ms (sampled every 20 ms while moving).
 */
export function rollColours(
  from: number,
  until: number,
  hits: readonly number[],
): [number, number, number][] {
  const out: [number, number, number][] = [];
  let value = 0,
    t = from;
  const push = (end: number, f: number) => {
    // Half-open (0.5 ms survives float32 times), so neighbouring steps never draw together.
    if (end > t) out.push([t, end - 0.5, f]);
    t = Math.max(t, end);
  };
  for (let i = 0; i < hits.length && i < 5; i++) {
    const start = Math.max(t, hits[i]),
      target = (i + 1) / 5,
      next = Math.min(hits[i + 1] ?? Infinity, until);
    push(start, value);
    const begin = value;
    for (let step = 0; step < 100 && start + step < next; step += 20) {
      const u = Math.min(1, (step + 10) / 100);
      push(Math.min(start + step + 20, next), begin + (target - begin) * u);
    }
    const reached = Math.min(1, (Math.min(next, start + 100) - start) / 100);
    value = begin + (target - begin) * reached;
  }
  push(until, value);
  return out;
}

/**
 * LegacySwell's spinner circle as [from, until, scale, rotation (radians)]
 * steps of 10 ms: +0.02 scale per hit (capped at 0.94), relaxing towards 0.8
 * with a 120 ms half-life, and turning towards 180° per hit with a 130 ms
 * half-life; at completion it eases (out quad, 300 ms) 0.05 larger.
 */
export function swellCircle(
  from: number,
  until: number,
  hits: readonly number[],
  done: number,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let scale = 0.8,
    angle = 0,
    next = 0,
    completed: number | null = null;
  for (let t = from; t < until; t += 10) {
    while (next < hits.length && hits[next] <= t) {
      scale = Math.min(0.94, scale + 0.02);
      next++;
    }
    let shown = scale;
    if (t >= done) {
      completed ??= scale;
      const u = Math.min(1, (t + 5 - done) / 300);
      shown = completed + 0.05 * (1 - (1 - u) * (1 - u));
    } else scale = 0.8 + (scale - 0.8) * Math.pow(2, -10 / 120);
    out.push([
      t,
      Math.min(t + 10, until) - 0.5,
      shown,
      (angle * Math.PI) / 180,
    ]);
    angle = 180 * next + (angle - 180 * next) * Math.pow(2, -10 / 130);
  }
  return out;
}

/** Kiai sections [start, end) from the timing lines' kiai flag. */
function kiaiSections(map: Beatmap): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const point of map.timing) {
    const kiai = (point.effects & 1) !== 0;
    if (kiai && start === null) start = point.time;
    else if (!kiai && start !== null) {
      out.push([start, point.time]);
      start = null;
    }
  }
  if (start !== null) out.push([start, map.duration]);
  return out;
}

/** Index of the beat at `time` counted across uninherited timing points. */
export function beatOrdinal(map: Beatmap, time: number): number {
  const points = map.timing.filter((p) => p.uninherited && p.beatLength > 0);
  if (!points.length) return Math.floor(time / 1000);
  let base = 0,
    k = 0;
  while (k + 1 < points.length && points[k + 1].time <= time) {
    base += Math.ceil((points[k + 1].time - points[k].time) / points[k].beatLength - 1e-6);
    k++;
  }
  return base + Math.floor((time - points[k].time) / points[k].beatLength + 1e-6);
}

/** Beat times in [from, to). */
function beatTimes(map: Beatmap, from: number, to: number): number[] {
  const points = map.timing.filter((p) => p.uninherited && p.beatLength > 0);
  if (!points.length) return [];
  const out: number[] = [];
  for (let k = 0; k < points.length; k++) {
    const p = points[k],
      end = k + 1 < points.length ? points[k + 1].time : to,
      start = k === 0 ? Math.min(from, p.time) : p.time;
    let t = p.time + Math.ceil((start - p.time) / p.beatLength - 1e-6) * p.beatLength;
    for (; t < Math.min(end, to) - 1e-6; t += p.beatLength) if (t >= from) out.push(t);
  }
  return out;
}

const COMBO_RESULTS = new Set(["perfect", "great", "good", "ok", "meh", "miss"]);
const MASCOT_STATES = ["idle", "clear", "kiai", "fail"] as const;
type MascotState = (typeof MASCOT_STATES)[number];
/** `ClearMascotTextureAnimation`: frames at 10 fps, played once. */
const CLEAR_SEQUENCE = [0, 1, 2, 3, 4, 5, 6, 5, 6, 5, 4, 3, 2, 1, 0];

/**
 * `DrawableTaikoMascot` with the skin's pippidon frames: idle, kiai or fail
 * (after a missed combo object) advance a frame on every beat, starting from
 * frame 0 whenever the state changes; every 50th combo and every completed
 * swell play the clear animation (15 frames at 10 fps) to the end. Bottom-left
 * at 0.2 of the playfield's height, at 0.6 scale.
 */
export function taikoMascot(
  map: Beatmap,
  judgements: readonly JudgementEvent[] | undefined,
  marks: Marks,
  px: (x: number) => number,
  py: (y: number) => number,
  scale: number,
  from: number,
  to: number,
): void {
  const frames = (state: MascotState) => {
    const out: string[] = [];
    for (let i = 0; marks.has(`pippidon${state}${i}`); i++) out.push(`pippidon${state}${i}`);
    if (!out.length && marks.has(`pippidon${state}`)) out.push(`pippidon${state}`);
    return out;
  };
  const sets = new Map(MASCOT_STATES.map((s) => [s, frames(s)] as const));
  if (![...sets.values()].some((f) => f.length)) return;
  const clearFrames: string[] = [];
  for (const i of CLEAR_SEQUENCE) {
    const name = sets.get("clear")![i];
    if (!name) break;
    clearFrames.push(name);
  }
  const kiai = kiaiSections(map);
  const inKiai = (t: number) => kiai.some(([s, e]) => t >= s && t < e);
  // Results in time order; without a replay every object is hit.
  const results = (
    judgements ??
    map.objects.map((o, i) => ({ time: o.time, result: "great", note: i, object: o.type & 8 ? "swell" : "hit", x: 0, y: 0, combo: i + 1 }))
  )
    .filter((e) => COMBO_RESULTS.has(e.result) || e.object === "swell")
    .sort((a, b) => a.time - b.time);
  // Times the state can change: results, kiai edges, clear endings.
  const put = (asset: string, start: number, end: number) => {
    if (!(end > start)) return;
    const [w, h] = marks.size(asset);
    marks.put({
      asset,
      x: px((w * 0.6) / 2),
      y: py(0.2 * 200 - (h * 0.6) / 2),
      w: w * 0.6 * scale,
      h: h * 0.6 * scale,
      time: start,
      until: end,
      profile: 21,
      fps: 0,
    });
  };
  const beats = beatTimes(map, from, to);
  let lastHit = true,
    clearUntil = -Infinity,
    r = 0;
  const edges = [...new Set([from, to, ...results.map((e) => e.time), ...kiai.flat()])]
    .filter((t) => t >= from && t <= to)
    .sort((a, b) => a - b);
  // Walk segments between edges, then draw each state's frames per beat.
  const spans: { state: MascotState; start: number; end: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    let t = edges[i];
    while (r < results.length && results[r].time <= t) {
      const e = results[r++];
      const hit = e.result !== "miss";
      if (((COMBO_RESULTS.has(e.result) && hit && e.combo % 50 === 0) || (e.object === "swell" && hit)) && sets.get("clear")!.length && t >= clearUntil) {
        clearUntil = e.time + clearFrames.length * 100;
        lastHit = true;
      }
      if (COMBO_RESULTS.has(e.result)) lastHit = hit;
    }
    const end = edges[i + 1];
    while (t < end) {
      const next: MascotState = t < clearUntil ? "clear" : !lastHit ? "fail" : inKiai(t) ? "kiai" : "idle";
      const until = t < clearUntil ? Math.min(end, clearUntil) : end;
      const last = spans[spans.length - 1];
      if (last && last.state === next && last.end === t) last.end = until;
      else spans.push({ state: next, start: t, end: until });
      t = until;
    }
  }
  for (const span of spans) {
    if (span.state === "clear") {
      for (let k = 0; k < clearFrames.length; k++)
        put(clearFrames[k], Math.max(span.start, span.start + k * 100), Math.min(span.end, span.start + (k + 1) * 100));
      continue;
    }
    const set = sets.get(span.state)!;
    if (!set.length) continue;
    // Frame 0 from the state's start until the next beat, then one frame per beat.
    let t = span.start;
    for (const beat of beats) {
      if (beat <= span.start) continue;
      if (beat >= span.end) break;
      const frame = t === span.start ? set[0] : set[((beatOrdinal(map, t) % set.length) + set.length) % set.length];
      put(frame, t, beat);
      t = beat;
    }
    put(t === span.start ? set[0] : set[((beatOrdinal(map, t) % set.length) + set.length) % set.length], t, span.end);
  }
}

/**
 * `LegacyKiaiGlow` (taiko-glow, coloured (255, 228, 0) at the hit target's
 * 0.8 scale): 100 ms in when kiai starts, 600 ms out after; every hit in
 * kiai pops it 0.15 larger, easing back over 80 ms.
 */
export function taikoKiaiGlow(
  map: Beatmap,
  judgements: readonly JudgementEvent[] | undefined,
  marks: Marks,
  x: number,
  y: number,
  scale: number,
): void {
  if (!marks.has("taiko-glow")) return;
  const [w, h] = marks.size("taiko-glow"),
    hits = (judgements
      ? judgements.filter((e) => !/miss/.test(e.result)).map((e) => e.time)
      : map.objects.filter((o) => !(o.type & (2 | 8))).map((o) => o.time)
    ).sort((a, b) => a - b);
  for (const [start, end] of kiaiSections(map)) {
    const inside = hits.filter((t) => t > start && t < end);
    const cuts = [start, ...inside, end + 600];
    for (let i = 0; i < cuts.length - 1; i++)
      marks.put({
        asset: "taiko-glow",
        x,
        y,
        w: w * 0.8 * scale,
        h: h * 0.8 * scale,
        time: cuts[i],
        until: cuts[i + 1],
        profile: 20,
        p1: start,
        p2: end,
        tint: [1, 228 / 255, 0, 1],
        fps: 0,
      });
  }
}
