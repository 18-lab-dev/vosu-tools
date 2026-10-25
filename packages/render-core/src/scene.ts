import {
  approachTime,
  circleRadius,
  pathPosition,
  scrollPosition,
} from "@vosu-tools/osu-parse";
import type { Beatmap, HitObject, Mod } from "@vosu-tools/osu-parse";
import { normaliseComboColour } from "./colour";
import { catchPreempt, compileCatch } from "./fruits";
import {
  legacySliderStyle,
  regionInstances,
  type Skin,
  type AtlasRegion,
  type SkinScope,
} from "./skin";
import { compileTaiko } from "./taiko";
import { sliderBall, spinner } from "./osu";
import { pressIntervals } from "./gameplay";
import {
  catcherStates,
  maniaExplosionEvents,
  maniaJudgements,
  Marks,
  osuJudgements,
  Profile,
  type JudgementEvent,
} from "./judgements";
import {
  atlasImageSize,
  DEFAULT_SCROLL_LENGTH,
  MANIA_SCALE,
  maniaConfig,
  maniaJudgementImages,
  maniaLayout,
  type Rgba,
} from "./mania";
export interface RenderOptions {
  mods?: Mod[];
  ar?: number;
  cs?: number;
  scrollSpeed?: number;
  noteSpeed?: number;
  hitLighting?: boolean;
  /** Use the beatmap's combo and slider colours (clients' "beatmap colours"); default true. */
  beatmapColours?: boolean;
  /** Mania notes scroll upwards (the client's scroll direction "up"). */
  maniaScrollUp?: boolean;
  /** Slider bodies grow along their path while approaching (clients' snaking sliders); default true. */
  snakingIn?: boolean;
  /**
   * osu!lazer's combo colour normalisation (0-1, lazer's default 0.2): combo
   * colours move towards one perceived brightness. Omit for stable (none).
   */
  comboColourNormalisation?: number;
  /**
   * A replay's results (its judgement simulation): drawn as osu!lazer shows
   * judgements, hit lighting and explosions. Without them the scene keeps
   * its autoplay look (every object hit on time).
   */
  judgements?: readonly JudgementEvent[];
  /**
   * osu!taiko: draw the strip above the playfield (the skin's taiko-slider,
   * lazer's default); off, the scene ends at the playfield's top edge.
   */
  taikoTopArea?: boolean;
  /**
   * A replay's input in map milliseconds (its decoded frames: `x`/`y` in
   * osu! pixels, `keys` the legacy button state). Draws what the player did:
   * osu!taiko drum hits, osu!catch dash trails and catcher position, osu!mania
   * key and column light timing, and the osu! cursor's expansion and trail.
   */
  input?: readonly InputFrame[];
  /**
   * osu! overlap: several players' input over one playfield, one skinned
   * cursor each (drawn from `FrameState.cursors` at the same index).
   */
  cursorInputs?: readonly (readonly InputFrame[])[];
  /**
   * osu!: lazer's gameplay playfield sits 8 osu! pixels lower
   * (`OsuPlayfieldAdjustmentContainer.PlayfieldShift`); off by default, as in
   * lazer's editor and the map preview.
   */
  playfieldShift?: boolean;
}
/** One replay frame (`RenderOptions.input`). */
export interface InputFrame {
  time: number;
  x: number;
  y: number;
  keys: number;
}
/**
 * The mania key counts a scene of this map draws (empty for other rulesets):
 * the stage follows the map's CS after Difficulty Adjust and the `cs`
 * override, like `setBeatmap`.
 */
export function maniaKeysFor(
  map: Beatmap,
  options: RenderOptions = {},
): number[] {
  if (map.mode !== 3) return [];
  let cs = map.difficulty.cs;
  for (const mod of options.mods ?? [])
    if (mod.acronym.toUpperCase() === "DA")
      cs = Number(mod.settings?.circle_size ?? cs);
  if (options.cs !== undefined) cs = options.cs;
  return [Math.max(1, Math.round(cs))];
}

/** The skin images a scene of this map draws: its ruleset and mania stage (`loadScope`). */
export function sceneScope(map: Beatmap, options: RenderOptions = {}): SkinScope {
  return { rulesets: [map.mode], maniaKeys: maniaKeysFor(map, options) };
}

export interface Scene {
  data: Float32Array<ArrayBuffer>;
  chunks: { first: number; count: number; from: number; until: number }[];
  count: number;
  preempt: number;
  speed: number;
  scrollBase: number;
  catcher: { time: number; x: number; y?: number }[];
  /** osu!catch hyper-dashes, when the catcher takes the hyper-dash colour. */
  hyper: { start: number; end: number }[];
  /** osu!taiko: world x left of which scrolling hit objects are masked. */
  clipX: number;
  /**
   * osu!catch with judgements: the catcher's animation state from each result
   * on (0 idle, 1 kiai, 2 fail).
   */
  catcherStates?: { time: number; state: number }[];
}
const palette: readonly (readonly number[])[] = [
  [1, 0.52, 0.24],
  [0.35, 0.72, 1],
  [0.68, 0.9, 0.35],
  [0.86, 0.45, 0.8],
];
/** The clients' fallback combo colours (osu! SkinConfiguration.DefaultComboColours). */
const defaultComboColours: readonly (readonly number[])[] = [
  [255 / 255, 192 / 255, 0],
  [0, 202 / 255, 0],
  [18 / 255, 124 / 255, 255 / 255],
  [242 / 255, 24 / 255, 57 / 255],
];
/** Packed 6xvec4 instance ABI: geometry, lifetime, tint, motion, UV, shape parameters. */
export function compileScene(
  map: Beatmap,
  options: RenderOptions,
  regions: Map<string, AtlasRegion>,
  skin?: Skin,
  /** Output width / height: osu!taiko's playfield depends on it (lazer's game space). */
  aspect = 16 / 9,
): Scene {
  let clipX = -1e9,
    hyper: Scene["hyper"] = [],
    states: Scene["catcherStates"];
  const values: number[] = [],
    preempt = approachTime(map.difficulty.ar),
    radius = circleRadius(map.difficulty.cs),
    catcher: { time: number; x: number; y?: number }[] = [];
  const red = map.timing.filter((point) => point.uninherited),
    weights = new Map<number, number>();
  for (let i = 0; i < red.length; i++) {
    const duration = Math.max(
      0,
      (red[i + 1]?.time ?? map.duration) - Math.max(0, red[i].time),
    );
    weights.set(
      red[i].beatLength,
      (weights.get(red[i].beatLength) ?? 0) + duration,
    );
  }
  let scrollBase = 500,
    largest = 0;
  for (const [beat, weight] of weights)
    if (weight > largest) {
      scrollBase = beat;
      largest = weight;
    }
  const scrollAt = (time: number) =>
    scrollPosition(map.timing, time, "mania", scrollBase);
  const skinColours = Object.entries(skin?.sections.get("Colours")?.[0] ?? {})
    .filter(([key]) => /^Combo\d+$/.test(key))
    .sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5)))
    .map(([, value]) =>
      value.split(",").map((channel) => Number(channel.trim()) / 255),
    );
  // Clients fall back to the default combo colours when a skin defines none.
  const colours =
    map.colours.length && options.beatmapColours !== false
      ? map.colours
      : skinColours.length || !skin
        ? skinColours
        : defaultComboColours;
  const shownColours = colours.map((c) =>
    normaliseComboColour(c, options.comboColourNormalisation ?? 0),
  );
  const border =
    (options.beatmapColours !== false
      ? map.colourSettings?.SliderBorder
      : undefined) ??
    skin?.sections
      .get("Colours")?.[0]
      ?.SliderBorder?.split(",")
      .map((c) => Number(c) / 255) ??
    (skin ? [1, 1, 1] : [0.85, 0.85, 0.85]);
  const trackOverride =
    (options.beatmapColours !== false
      ? map.colourSettings?.SliderTrackOverride
      : undefined) ??
    skin?.sections
      .get("Colours")?.[0]
      ?.SliderTrackOverride?.split(",")
      .map((c) => Number(c) / 255);
  // lazer: TimeRange = 11485 / speed × (scroll length / default scroll length),
  // so notes travel the default scroll length (402 legacy units) in 11485 / speed ms
  // whatever the skin's hit position.
  const speed =
    map.mode === 3
      ? ((options.scrollSpeed ?? 20) * DEFAULT_SCROLL_LENGTH) / 11485
      : map.mode === 2
        ? 440 / catchPreempt(map.difficulty.ar)
        : 0;
  function add(
    x: number,
    y: number,
    w: number,
    h: number,
    start: number,
    end: number,
    from: number,
    until: number,
    colour: readonly number[],
    shape = 0,
    motion = 0,
    a = 0,
    b = 0,
    c = 0,
    asset = "",
    p = 0,
    q = 0,
    r = 0,
    /** Shape parameters for untextured shapes, carried in the UV slot. */
    custom?: readonly [number, number, number, number],
    /** Draw an animation's first frame only. */
    still = false,
    /**
     * Keep only the centre of the image (fractions of its width and height),
     * like osu!'s `WithMaximumSize` (every frame of an animation).
     */
    crop?: readonly [number, number],
    /** Only these image rows (fractions of its height, top first); implies the first frame. */
    rows?: readonly [number, number],
    /** Animation frames per second, instead of the region's. */
    fps?: number,
  ): void {
    const region = custom ? undefined : regions.get(asset);
    if (region) {
      // One instance per strip of a tall image (atlas.ts). A crop keeps the
      // centre of each strip horizontally; tall images are never cropped
      // vertically (only small taiko and catch pieces are).
      const animated = !(still || rows);
      for (const { entry, uv: strip } of regionInstances(region, !animated)) {
        const uv =
          // The shader crops each frame it selects (shader.ts).
          crop && animated
            ? { u: 0, v: 0, w: -crop[0], h: -crop[1] }
            : crop && !region.strips
            ? {
                u: strip.u + (strip.w * (1 - crop[0])) / 2,
                v: strip.v + (strip.h * (1 - crop[1])) / 2,
                w: strip.w * crop[0],
                h: strip.h * crop[1],
              }
            : crop
              ? {
                  ...strip,
                  u: strip.u + (strip.w * (1 - crop[0])) / 2,
                  w: strip.w * crop[0],
                }
              : rows && !region.strips
                ? {
                    ...strip,
                    v: strip.v + strip.h * rows[0],
                    h: strip.h * (rows[1] - rows[0]),
                  }
                : strip;
        values.push(
          x,
          y,
          w,
          h,
          start,
          end,
          from,
          until,
          colour[0],
          colour[1],
          colour[2],
          colour[3] ?? 1,
          motion,
          a,
          b,
          c,
          uv.u,
          uv.v,
          uv.w,
          uv.h,
          shape === 13 ? 13 : 10,
          entry,
          animated ? (region.count ?? q) : 0,
          (fps ??
            (asset === "sliderb" || asset === "hitcircleoverlay"
              ? 60
              : (region.fps ?? 60))) * (r < 0 ? -1 : 1),
        );
      }
      return;
    }
    values.push(
      x,
      y,
      w,
      h,
      start,
      end,
      from,
      until,
      colour[0],
      colour[1],
      colour[2],
      colour[3] ?? 1,
      motion,
      a,
      b,
      c,
      custom?.[0] ?? 0,
      custom?.[1] ?? 0,
      custom?.[2] ?? 0,
      custom?.[3] ?? 0,
      shape,
      p,
      q,
      r,
    );
  }
  function circle(
    o: HitObject,
    x: number,
    y: number,
    r: number,
    colour: readonly number[],
    start = o.time,
    asset = "hitcircle",
  ): void {
    add(
      x,
      y,
      r * 2,
      r * 2,
      start,
      start,
      start - preempt,
      start + 180,
      colour,
      0,
      0,
      0,
      0,
      0,
      asset,
    );
    add(
      x,
      y,
      r * 2,
      r * 2,
      start,
      start,
      start - preempt,
      start + 180,
      [1, 1, 1],
      1,
      0,
      0,
      0,
      0,
      "hitcircleoverlay",
    );
  }
  function digits(o: HitObject, x: number, y: number): void {
    const digits = String(o.number),
      fonts = skin?.sections.get("Fonts")?.[0],
      prefix = fonts?.HitCirclePrefix ?? "default",
      scale = radius / 64,
      overlap = Number(fonts?.HitCircleOverlap ?? 0) * scale;
    const names = [...digits].map((d) =>
      regions.has(`${prefix}-${d}`) ? `${prefix}-${d}` : `default-${d}`,
    );
    const widths = names.map(
      (name) => (regions.get(name)?.width ?? 64) * scale,
    );
    let left =
      x -
      (widths.reduce((a, b) => a + b, 0) - overlap * (digits.length - 1)) / 2;
    for (let i = 0; i < names.length; i++) {
      const uv = regions.get(names[i]);
      add(
        left + widths[i] / 2,
        y,
        widths[i],
        (uv?.height ?? 80) * scale,
        o.time,
        o.time,
        o.time - preempt,
        o.time + 120,
        [1, 1, 1],
        10,
        0,
        0,
        0,
        0,
        names[i],
      );
      left += widths[i] - overlap;
    }
  }
  if (map.mode === 0) {
    for (const object of map.objects) {
      const offset = (object.stack * radius) / 10;
      catcher.push({
        time: object.time,
        x: object.x - offset,
        y: object.y - offset,
      });
      if (object.type & 2) {
        for (let repeat = 0; repeat < object.repeats; repeat++) {
          const reverse = repeat % 2 === 1;
          let travelled = 0;
          for (let i = 0; i < object.path.length; i++) {
            const point = object.path[i];
            if (i)
              travelled += Math.hypot(
                point.x - object.path[i - 1].x,
                point.y - object.path[i - 1].y,
              );
            const progress = travelled / Math.max(1, object.length);
            catcher.push({
              time:
                object.time +
                (repeat + (reverse ? 1 - progress : progress)) * object.span,
              x: point.x - offset,
              y: point.y - offset,
            });
          }
        }
      } else if (object.type & 8)
        catcher.push({ time: object.endTime, x: 256, y: 192 });
    }
    catcher.sort((a, b) => a.time - b.time);
    // BeatmapProcessor: the first combo's ComboIndexWithOffsets is 1, so
    // osu! objects take colour (index + 1), like the clients.
    const comboIndex = (o: HitObject | undefined) => (o?.combo ?? 0) + 1;
    const judged = options.judgements
      ? osuJudgements({
          map,
          events: options.judgements,
          marks: new Marks(values, regions),
          skin,
          colour: (note) => {
            const combo = comboIndex(map.objects[note]);
            return (
              shownColours[combo % shownColours.length] ??
              palette[combo % palette.length]
            );
          },
          hitLighting: options.hitLighting !== false,
        })
      : undefined;
    // Hit lighting and new-style judgement pieces sit under the hit objects.
    judged?.below();
    // Slider tracks sit below all hit objects. Skinned sliders follow the
    // client's body profile: all border capsules of a slider first, then all
    // body capsules, so joints between path segments never show a border.
    const sliderStyle =
      skin?.style?.slider ?? (skin ? legacySliderStyle : undefined);
    const profileCode = sliderStyle
      ? { legacy: 1, triangles: 2, argon: 3 }[sliderStyle.profile] * 10 +
        Math.min(0.999, sliderStyle.alpha)
      : 0;
    for (const o of map.objects)
      if (o.type & 2) {
        const offset = (o.stack * radius) / 10,
          colour =
            shownColours[comboIndex(o) % shownColours.length] ??
            palette[comboIndex(o) % palette.length];
        if (sliderStyle) {
          const outer = radius * sliderStyle.radius,
            accent =
              sliderStyle.profile === "legacy" && trackOverride
                ? trackOverride
                : colour,
            edge =
              sliderStyle.profile === "argon" ? colour : border.slice(0, 3),
            custom = [edge[0], edge[1], edge[2], profileCode] as const;
          // Pass 2 (legacy only) draws the soft outer shadow, 1 the border,
          // -1 the body; shape parameter: border portion, +10 for shadows.
          for (const pass of sliderStyle.profile === "legacy"
            ? [2, 1, -1]
            : [1, -1]) {
            const r = pass > 0 ? outer : outer * (1 - sliderStyle.border);
            let cumulative = 0;
            for (let i = 1; i < o.path.length; i++) {
              const a = o.path[i - 1],
                b = o.path[i],
                len = Math.hypot(b.x - a.x, b.y - a.y);
              cumulative += len;
              const reveal =
                o.time -
                preempt +
                (options.snakingIn === false
                  ? 0
                  : Math.min(1, cumulative / Math.max(1, o.length)) *
                    preempt *
                    0.4);
              add(
                (a.x + b.x) / 2 - offset,
                (a.y + b.y) / 2 - offset,
                len + r * 2,
                r * 2,
                o.time,
                o.endTime,
                reveal,
                o.endTime + 180,
                accent,
                12,
                0,
                Math.atan2(b.y - a.y, b.x - a.x),
                0,
                0,
                "",
                pass === 2
                  ? sliderStyle.border + 10
                  : pass * sliderStyle.border,
                0,
                0,
                custom,
              );
            }
          }
          continue;
        }
        let cumulative = 0;
        for (let i = 1; i < o.path.length; i++) {
          const a = o.path[i - 1],
            b = o.path[i],
            len = Math.hypot(b.x - a.x, b.y - a.y);
          cumulative += len;
          const reveal =
            o.time -
            preempt +
            (options.snakingIn === false
              ? 0
              : Math.min(1, cumulative / Math.max(1, o.length)) *
                preempt *
                0.4);
          add(
            (a.x + b.x) / 2 - offset,
            (a.y + b.y) / 2 - offset,
            len + radius * 2,
            radius * 2,
            o.time,
            o.endTime,
            reveal,
            o.endTime + 180,
            border,
            2,
            0,
            Math.atan2(b.y - a.y, b.x - a.x),
            0,
            0,
            "",
            radius,
          );
          add(
            (a.x + b.x) / 2 - offset,
            (a.y + b.y) / 2 - offset,
            len + radius * 1.75,
            radius * 1.75,
            o.time,
            o.endTime,
            reveal,
            o.endTime + 180,
            trackOverride ?? [
              colour[0] * 0.3,
              colour[1] * 0.3,
              colour[2] * 0.3,
            ],
            2,
            0,
            Math.atan2(b.y - a.y, b.x - a.x),
            0,
            0,
            "",
            radius * 0.875,
          );
        }
      }
    for (let index = map.objects.length - 1; index >= 0; index--) {
      const o = map.objects[index],
        offset = (o.stack * radius) / 10,
        x = o.x - offset,
        y = o.y - offset,
        colour =
          shownColours[comboIndex(o) % shownColours.length] ??
          palette[comboIndex(o) % palette.length];
      if (o.type & 8) {
        const before = map.objects[index - 1],
          previous = !before
            ? { x: 256, y: 500 }
            : before.type & 2
              ? pathPosition(before.path, before.repeats % 2 ? 1 : 0)
              : { x: before.x, y: before.y };
        spinner(add, o, map, preempt, previous, regions, skin);
        continue;
      }
      if (o.type & 2) {
        for (let repeat = 0; repeat < o.repeats; repeat++) {
          const reverse = repeat % 2 === 1,
            spanStart = o.time + o.span * repeat;
          for (const t of o.ticks) {
            const p = pathPosition(o.path, t),
              hit = spanStart + (reverse ? 1 - t : t) * o.span;
            add(
              p.x - offset,
              p.y - offset,
              8,
              8,
              hit,
              hit,
              o.time - preempt,
              hit,
              [1, 1, 1],
              0,
              0,
              0,
              0,
              0,
              "sliderscorepoint",
            );
          }
          if (repeat < o.repeats - 1) {
            const p = pathPosition(o.path, reverse ? 0 : 1),
              near = pathPosition(o.path, reverse ? 0.03 : 0.97),
              angle = Math.atan2(near.y - p.y, near.x - p.x);
            add(
              p.x - offset,
              p.y - offset,
              radius * 1.2,
              radius * 1.2,
              spanStart + o.span,
              spanStart + o.span,
              o.time - preempt,
              spanStart + o.span,
              [1, 1, 1],
              3,
              0,
              angle,
              0,
              0,
              "reversearrow",
            );
          }
        }
        const end = pathPosition(o.path, o.repeats % 2 ? 1 : 0);
        add(
          end.x - offset,
          end.y - offset,
          radius * 2,
          radius * 2,
          o.endTime,
          o.endTime,
          o.time - preempt,
          o.endTime,
          [...colour, 0.7],
          1,
        );
      }
      circle(o, x, y, radius, colour);
      digits(o, x, y);
      // DrawableSlider: the ball and follow circle sit above the head circle.
      if (o.type & 2) sliderBall(add, o, offset, colour, regions, skin, radius, preempt);
      add(
        x,
        y,
        radius * 2,
        radius * 2,
        o.time,
        o.time,
        o.time - preempt,
        o.time,
        [...colour, 0.9],
        1,
        6,
        0,
        0,
        0,
        "approachcircle",
      );
    }
    // Legacy judgement pieces are proxied above the hit objects.
    judged?.above();
  } else if (map.mode === 3) {
    const keys = Math.max(1, Math.round(map.difficulty.cs));
    const layout = maniaLayout(
      maniaConfig(skin, keys),
      atlasImageSize(regions),
    );
    const { config, columns } = layout;
    // Lazer stage units to render units: the stage is centred and spans the
    // playfield's full 480-unit height, from y = -48 to 432.
    const toX = (x: number) => 256 + (x - layout.width / 2) / MANIA_SCALE,
      toY = (y: number) => -48 + y / MANIA_SCALE,
      hit = toY(layout.hitY);
    const shapeCode = { none: 10, mirror: 40, inverted: 41, additive: 42 };
    const hitLighting = (motion: number) =>
      options.hitLighting === false &&
      (motion === 13 || motion === 18 || motion === 19);
    /** A stage element at a fixed place; boxes when `asset` is omitted. */
    const emit = (
      rect: { x: number; y: number; width: number; height: number },
      colour: Rgba,
      motion = 0,
      lane = 0,
      asset?: string,
      flip: keyof typeof shapeCode = "none",
      fps = 0,
    ) => {
      if (hitLighting(motion) || colour[3] <= 0) return;
      if (rect.width <= 0 || rect.height <= 0) return;
      const region = asset === undefined ? undefined : regions.get(asset);
      if (asset !== undefined && !region) return;
      // Texture lookups (fps 0) draw the plain image even when frames exist.
      const instances = region
        ? regionInstances(region, !(fps > 0))
        : [{ entry: 0, uv: undefined }];
      for (const { entry, uv } of instances)
        values.push(
          toX(rect.x + rect.width / 2),
          toY(rect.y + rect.height / 2),
          rect.width / MANIA_SCALE,
          rect.height / MANIA_SCALE,
          0,
          0,
          -1e9,
          1e9,
          colour[0],
          colour[1],
          colour[2],
          colour[3],
          motion,
          lane,
          0,
          0,
          uv?.u ?? 0,
          uv?.v ?? 0,
          uv?.w ?? 0,
          uv?.h ?? 0,
          uv ? shapeCode[flip] : 4,
          entry,
          fps > 0 ? (region?.count ?? 0) : 0,
          fps,
        );
    };
    /**
     * A scrolling piece in a column: notes, hold heads and tails (kind 1:
     * bottom edge on the time line `a`) and hold bodies (kinds 2 / 14: from
     * `a` (head) to `b` (tail), `y` / `h` carrying half the head / tail heights).
     */
    const scrolling = (
      lane: number,
      motion: number,
      a: number,
      b: number,
      life: readonly [number, number, number, number],
      y: number,
      h: number,
      asset: string,
      flip: keyof typeof shapeCode,
      fps: number,
    ) => {
      const region = regions.get(asset);
      if (!region) return;
      const column = columns[lane];
      // Hold bodies show their image from the tail end: a repeating body
      // (kind 14) is a 20500-unit sprite (32800 lazer units), so strips past
      // the hold's length never show.
      const length = (b - a) * speed - y + h,
        maxRow = motion === 14 ? length / Math.max(length, 20500) : 1;
      for (const { entry, uv } of regionInstances(region, false, maxRow))
        values.push(
          toX(column.x + column.width / 2),
          y,
          column.width / MANIA_SCALE,
          h,
          ...life,
          1,
          1,
          1,
          1,
          motion,
          a,
          b,
          hit,
          uv.u,
          uv.v,
          uv.w,
          uv.h,
          shapeCode[flip],
          entry,
          region.count ?? 0,
          fps,
        );
    };
    const WHITE: Rgba = [1, 1, 1, 1];
    // LegacyStageBackground: sides, column backgrounds and lines, hit target.
    for (const side of [layout.stageLeft, layout.stageRight])
      if (side) emit(side, WHITE, 0, 0, side.asset);
    for (const column of columns)
      emit(column.background, column.background.colour);
    for (const column of columns)
      for (const line of column.lines) emit(line, line.colour);
    if (layout.hint)
      emit(layout.hint, WHITE, 0, 0, layout.hint.asset, "mirror");
    if (layout.judgementLine)
      emit(layout.judgementLine, layout.judgementLine.colour);
    // LegacyColumnBackground: the column light while the key is held. With a
    // replay's input each press lights it until the release, then it fades and
    // shrinks to its bottom over 250 ms.
    const lights = new Marks(values, regions);
    const pressed = options.input ? pressIntervals(options.input, keys) : undefined;
    for (const [lane, column] of columns.entries())
      if (column.light && pressed) {
        if (options.hitLighting === false || column.light.colour[3] <= 0) continue;
        const light = column.light;
        for (const { start, end } of pressed[lane])
          lights.put({
            asset: light.asset,
            x: toX(light.x + light.width / 2),
            y: toY(light.y + light.height / 2),
            w: light.width / MANIA_SCALE,
            h: light.height / MANIA_SCALE,
            time: start,
            until: end + 250,
            profile: Profile.columnLight,
            p1: end,
            tint: light.colour,
            maniaMirror: true,
            fps: config.lightFramePerSecond,
          });
      } else if (column.light)
        emit(
          column.light,
          column.light.colour,
          13,
          lane,
          column.light.asset,
          "mirror",
          config.lightFramePerSecond,
        );
    // LegacyBarLine (BarLineGenerator), centred in DrawableBarLine's one unit
    // above the bar's time; it fades out over 150 ms once it reaches the hit position.
    if (layout.barLine.colour[3] > 0 && layout.barLine.height > 0) {
      const colour = layout.barLine.colour,
        height = layout.barLine.height / MANIA_SCALE;
      for (const t of barLineTimes(map))
        values.push(
          256,
          0.5 / MANIA_SCALE,
          layout.width / MANIA_SCALE,
          height,
          t,
          t + 150,
          t - 30000,
          t + 150,
          colour[0],
          colour[1],
          colour[2],
          colour[3],
          22,
          scrollAt(t),
          0,
          hit,
          0,
          0,
          0,
          0,
          4,
          0,
          0,
          0,
        );
    }
    // LegacyKeyArea, under or over the notes (KeysUnderNotes).
    const keyLayers = () => {
      for (const [lane, column] of columns.entries()) {
        if (column.key)
          emit(column.key, WHITE, 11, lane, column.key.asset, "mirror");
        if (column.keyDown)
          emit(column.keyDown, WHITE, 12, lane, column.keyDown.asset, "mirror");
      }
    };
    if (config.keysUnderNotes) keyLayers();
    // DrawableHoldNote draws its body, then its tail, then its head; notes
    // are a single LegacyNotePiece. All of them vanish once hit.
    const lanes = map.objects.map((o) =>
      Math.min(keys - 1, Math.max(0, Math.floor((o.x * keys) / 512))),
    );
    for (let layer = 0; layer < 3; layer++)
      for (const [index, o] of map.objects.entries()) {
        const lane = lanes[index],
          column = columns[lane],
          hold = o.endTime > o.time,
          s = scrollAt(o.time),
          e = scrollAt(o.endTime),
          from = o.time - 30000,
          head = hold ? column.head : column.note;
        if (layer === 0 && hold && column.body)
          scrolling(
            lane,
            config.noteBodyStyle === 0 ? 2 : 14,
            s,
            e,
            [o.time, o.endTime, from, o.endTime],
            (head?.height ?? 0) / MANIA_SCALE / 2,
            (column.tail?.height ?? 0) / MANIA_SCALE / 2,
            column.body,
            "mirror",
            1000 / 30,
          );
        if (layer === 1 && hold && column.tail)
          scrolling(
            lane,
            1,
            e,
            0,
            [o.endTime, o.endTime, from, o.endTime],
            0,
            column.tail.height / MANIA_SCALE,
            column.tail.asset,
            "inverted",
            60,
          );
        if (layer === 2 && head)
          scrolling(
            lane,
            1,
            s,
            0,
            [o.time, o.endTime, from, o.endTime],
            0,
            head.height / MANIA_SCALE,
            head.asset,
            "mirror",
            60,
          );
      }
    if (!config.keysUnderNotes) keyLayers();
    // LegacyStageForeground.
    if (layout.stageBottom)
      emit(
        layout.stageBottom,
        WHITE,
        0,
        0,
        layout.stageBottom.asset,
        "none",
        60,
      );
    // Column top level: hit explosions and hold lighting, additive. With a
    // replay's results, each hit lights its column once (Column.OnNewResult);
    // previews light a column while its key is down.
    const marks = new Marks(values, regions),
      lightFps = (asset: string) =>
        Math.min(60, ((regions.get(asset)?.count ?? 1) * 1000) / 170);
    for (const [lane, column] of columns.entries())
      for (const [light, motion] of [
        [column.explosion, 18],
        [column.holdLight, 19],
      ] as const)
        if (light && !(motion === 18 && options.judgements))
          emit(
            light,
            WHITE,
            motion,
            lane,
            light.asset,
            "additive",
            lightFps(light.asset),
          );
    if (options.judgements) {
      if (options.hitLighting !== false)
        for (const e of maniaExplosionEvents(options.judgements)) {
          const light = columns[e.x]?.explosion;
          if (!light) continue;
          marks.put({
            asset: light.asset,
            x: toX(light.x + light.width / 2),
            y: toY(light.y + light.height / 2),
            w: light.width / MANIA_SCALE,
            h: light.height / MANIA_SCALE,
            time: e.time,
            profile: Profile.maniaExplosion,
            additive: true,
            fps: lightFps(light.asset),
          });
        }
      // Stage judgements: centred over the stage at the skin's ScorePosition.
      maniaJudgements({
        events: options.judgements,
        marks,
        skin,
        images: maniaJudgementImages(config),
        x: toX(layout.width / 2),
        y: toY(config.scorePosition),
        hitY: hit,
        scale: 1 / MANIA_SCALE,
      });
    }
  } else if (map.mode === 1) {
    clipX = compileTaiko(
      map,
      options,
      regions,
      skin,
      add,
      aspect,
      barLineTimes(map),
      new Marks(values, regions),
    ).clipX;
  } else {
    const result = compileCatch(
      map,
      options,
      regions,
      skin,
      add,
      colours.length ? colours : defaultComboColours,
      new Marks(values, regions),
    );
    catcher.push(...result.catcher);
    hyper = result.hyper;
    states = result.states;
  }
  const data = new Float32Array(values),
    count = values.length / 24,
    chunks: Scene["chunks"] = [];
  for (let first = 0; first < count; first += 128) {
    const n = Math.min(128, count - first);
    let from = Infinity,
      until = -Infinity;
    for (let i = first; i < first + n; i++) {
      from = Math.min(from, data[i * 24 + 6]);
      until = Math.max(until, data[i * 24 + 7]);
    }
    chunks.push({ first, count: n, from, until });
  }
  return {
    data,
    chunks,
    count,
    preempt: map.mode === 2 ? catchPreempt(map.difficulty.ar) : preempt,
    scrollBase,
    speed:
      map.mode === 1
        ? speed
        : map.mode === 3
          ? speed * (options.noteSpeed ?? 1)
          : speed,
    catcher,
    hyper,
    clipX,
    catcherStates: states,
  };
}

/** Bar line times as lazer's `BarLineGenerator` places them. */
export function barLineTimes(map: Beatmap): number[] {
  const out: number[] = [];
  if (!map.objects.length) return out;
  const uninherited = map.timing.filter((point) => point.uninherited),
    firstHit = map.objects.reduce(
      (first, o) => Math.min(first, o.time),
      Infinity,
    ),
    lastHit = 1 + map.objects.reduce((end, o) => Math.max(end, o.endTime), 0),
    generationStart = Math.min(0, firstHit);
  for (let i = 0; i < uninherited.length; i++) {
    const point = uninherited[i],
      barLength = point.beatLength * point.meter,
      end = uninherited[i + 1]?.time ?? lastHit + barLength;
    if (!(barLength > 0)) continue;
    let start =
      point.time > generationStart
        ? point.time
        : point.time +
          Math.ceil((generationStart - point.time) / barLength) * barLength;
    if (point.effects & 8) start += barLength;
    for (let t = start; end > t - 1e-3; t += barLength) {
      const rounded = Math.round(t);
      if (Math.abs(t - rounded) <= 1e-3) t = rounded;
      out.push(t);
    }
  }
  return out;
}
