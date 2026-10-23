import {
  approachTime,
  circleRadius,
  pathPosition,
  scrollPosition,
  timingAt,
  taikoVelocity,
} from "@vosu-tools/osu-parse";
import type { Beatmap, HitObject, Mod } from "@vosu-tools/osu-parse";
import { catchObjects } from "@vosu-tools/ruleset-convert";
import { legacySliderStyle, type Skin, type AtlasRegion } from "./skin";
import {
  atlasImageSize,
  DEFAULT_SCROLL_LENGTH,
  MANIA_SCALE,
  maniaConfig,
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
}
export interface Scene {
  data: Float32Array<ArrayBuffer>;
  chunks: { first: number; count: number; from: number; until: number }[];
  count: number;
  preempt: number;
  speed: number;
  scrollBase: number;
  catcher: { time: number; x: number; y?: number }[];
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
): Scene {
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
        ? 300 / preempt
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
  ): void {
    const uv = custom ? undefined : regions.get(asset);
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
      uv?.u ?? custom?.[0] ?? 0,
      uv?.v ?? custom?.[1] ?? 0,
      uv?.w ?? custom?.[2] ?? 0,
      uv?.h ?? custom?.[3] ?? 0,
      uv ? 10 : shape,
      uv?.first ?? p,
      uv?.count ?? q,
      uv
        ? (asset === "sliderb" || asset === "hitcircleoverlay"
            ? 60
            : (uv.fps ?? 60)) * (r < 0 ? -1 : 1)
        : r,
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
            colours[o.combo % colours.length] ??
            palette[o.combo % palette.length];
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
          colours[o.combo % colours.length] ??
          palette[o.combo % palette.length];
      if (o.type & 8) {
        const modernSpinner =
          (skin?.version ?? 1) >= 2 &&
          [
            "spinner-bottom",
            "spinner-top",
            "spinner-middle",
            "spinner-middle2",
          ].some((name) => regions.has(name));
        if (regions.has("spinner-background"))
          add(
            256,
            192,
            480,
            480,
            o.time,
            o.endTime,
            o.time - preempt,
            o.endTime + 180,
            [1, 1, 1],
            4,
            0,
            0,
            0,
            0,
            "spinner-background",
          );
        if (!modernSpinner)
          add(
            256,
            192,
            300,
            300,
            o.time,
            o.endTime,
            o.time - preempt,
            o.endTime + 180,
            [0.65, 0.7, 0.8, 0.5],
            11,
            7,
            0,
            0,
            0,
            "spinner-circle",
          );
        for (const name of [
          "spinner-bottom",
          "spinner-middle2",
          "spinner-middle",
          "spinner-top",
          "spinner-glow",
        ])
          if (modernSpinner && regions.has(name))
            add(
              256,
              192,
              300,
              300,
              o.time,
              o.endTime,
              o.time - preempt,
              o.endTime + 180,
              [1, 1, 1],
              4,
              7,
              0,
              0,
              0,
              name,
            );
        for (const [name, x, y, w, h] of [
          ["spinner-metre", 510, 192, 24, 300],
          ["spinner-rpm", 256, 360, 100, 30],
          ["spinner-spin", 256, 300, 120, 36],
        ] as const)
          if (regions.has(name))
            add(
              x,
              y,
              w,
              h,
              o.time,
              o.endTime,
              o.time,
              o.endTime,
              [1, 1, 1],
              4,
              0,
              0,
              0,
              0,
              name,
            );
        if (regions.has("spinner-clear"))
          add(
            256,
            80,
            160,
            40,
            o.endTime,
            o.endTime,
            o.endTime - 150,
            o.endTime + 500,
            [1, 1, 1],
            4,
            0,
            0,
            0,
            0,
            "spinner-clear",
          );
        if (!modernSpinner)
          add(
            256,
            192,
            300,
            300,
            o.time,
            o.endTime,
            o.time - preempt,
            o.endTime,
            [1, 1, 1],
            1,
            10,
            0,
            0,
            0,
            "spinner-approachcircle",
          );
        continue;
      }
      if (o.type & 2) {
        for (let repeat = 0; repeat < o.repeats; repeat++) {
          const reverse = repeat % 2 === 1,
            spanStart = o.time + o.span * repeat;
          let cumulative = 0;
          for (let i = 1; i < o.path.length; i++) {
            const a = o.path[i - 1],
              b = o.path[i],
              length = Math.hypot(b.x - a.x, b.y - a.y),
              first = cumulative / Math.max(o.length, 1),
              last = (cumulative + length) / Math.max(o.length, 1);
            cumulative += length;
            const start = spanStart + (reverse ? 1 - last : first) * o.span,
              end = spanStart + (reverse ? 1 - first : last) * o.span;
            add(
              (reverse ? b.x : a.x) - offset,
              (reverse ? b.y : a.y) - offset,
              radius * 2,
              radius * 2,
              start,
              end,
              start,
              end,
              [1, 1, 1],
              0,
              5,
              (reverse ? a.x : b.x) - offset,
              (reverse ? a.y : b.y) - offset,
              o.time,
              "sliderb",
            );
            add(
              (reverse ? b.x : a.x) - offset,
              (reverse ? b.y : a.y) - offset,
              radius * 4.6,
              radius * 4.6,
              start,
              end,
              start,
              end,
              [1, 1, 1, 0.6],
              1,
              5,
              (reverse ? a.x : b.x) - offset,
              (reverse ? a.y : b.y) - offset,
              o.time,
              "sliderfollowcircle",
            );
          }
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
      const uv = asset === undefined ? undefined : regions.get(asset);
      if (asset !== undefined && !uv) return;
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
        uv?.first ?? 0,
        // Texture lookups (fps 0) draw the plain image even when frames exist.
        fps > 0 ? (uv?.count ?? 0) : 0,
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
      const uv = regions.get(asset);
      if (!uv) return;
      const column = columns[lane];
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
        uv.first ?? 0,
        uv.count ?? 0,
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
    // LegacyColumnBackground: the column light while the key is held.
    for (const [lane, column] of columns.entries())
      if (column.light)
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
      const uninherited = map.timing.filter((point) => point.uninherited),
        firstHit = map.objects.length
          ? Math.min(...map.objects.map((o) => o.time))
          : 0,
        lastHit =
          1 + map.objects.reduce((end, o) => Math.max(end, o.endTime), 0),
        generationStart = Math.min(0, firstHit),
        colour = layout.barLine.colour,
        height = layout.barLine.height / MANIA_SCALE;
      for (let i = 0; i < uninherited.length && map.objects.length; i++) {
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
      }
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
    // Column top level: hit explosions and hold lighting, additive.
    for (const [lane, column] of columns.entries())
      for (const [light, motion] of [
        [column.explosion, 18],
        [column.holdLight, 19],
      ] as const)
        if (light) {
          const frames = regions.get(light.asset)?.count ?? 1;
          emit(
            light,
            WHITE,
            motion,
            lane,
            light.asset,
            "additive",
            Math.min(60, (frames * 1000) / 170),
          );
        }
  } else if (map.mode === 1) {
    add(336, 135, 480, 96, 0, 0, -1e9, 1e9, [0.09, 0.09, 0.1], 4);
    if (regions.has("taiko-slider"))
      add(
        256,
        135,
        640,
        132,
        0,
        0,
        -1e9,
        1e9,
        [1, 1, 1],
        4,
        0,
        0,
        0,
        0,
        "taiko-slider",
      );
    if (regions.has("taiko-bar-left"))
      add(
        16,
        135,
        160,
        132,
        0,
        0,
        -1e9,
        1e9,
        [1, 1, 1],
        4,
        0,
        0,
        0,
        0,
        "taiko-bar-left",
      );
    if (regions.has("taiko-bar-right"))
      add(
        576,
        135,
        32,
        132,
        0,
        0,
        -1e9,
        1e9,
        [1, 1, 1],
        4,
        0,
        0,
        0,
        0,
        "taiko-bar-right",
      );
    for (let i = 0; i < map.timing.length; i++) {
      const timing = map.timing[i];
      if (!timing.uninherited) continue;
      const end =
        map.timing.slice(i + 1).find((t) => t.uninherited)?.time ??
        map.duration;
      for (
        let time = timing.time;
        time < end;
        time += timing.beatLength * timing.meter
      ) {
        const velocity = taikoVelocity(map, time, options.noteSpeed ?? 1);
        add(
          96,
          135,
          1,
          96,
          time,
          time,
          time - 480 / velocity,
          time,
          [0.35, 0.35, 0.38, 0.55],
          4,
          3,
          velocity,
        );
      }
    }
    add(
      96,
      135,
      90,
      90,
      0,
      0,
      -1e9,
      1e9,
      [1, 1, 1],
      1,
      0,
      0,
      0,
      0,
      "approachcircle",
    );
    add(
      16,
      135,
      86,
      86,
      0,
      0,
      -1e9,
      1e9,
      [1, 1, 1],
      9,
      0,
      0,
      0,
      0,
      "taiko-drum-inner",
    );
    if (regions.has("taiko-drum-outer"))
      add(
        16,
        135,
        86,
        86,
        0,
        0,
        -1e9,
        1e9,
        [1, 1, 1],
        4,
        0,
        0,
        0,
        0,
        "taiko-drum-outer",
      );
    for (let i = map.objects.length - 1; i >= 0; i--) {
      const o = map.objects[i],
        rim = !!(o.sound & 10),
        big = !!(o.sound & 4),
        r = big ? 45 : 32,
        t = timingAt(map.timing, o.time),
        velocity = taikoVelocity(map, o.time, options.noteSpeed ?? 1),
        lead = 480 / velocity;
      if (o.type & 8) {
        add(
          96,
          135,
          90,
          90,
          o.time,
          o.endTime,
          o.time - lead,
          o.endTime,
          [0.9, 0.7, 0.2],
          11,
          7,
        );
        add(
          96,
          135,
          96,
          96,
          o.time,
          o.endTime,
          o.time,
          o.endTime,
          [1, 0.9, 0.2],
          1,
          10,
        );
        continue;
      }
      if (o.type & 2) {
        add(
          96,
          135,
          Math.max(1, (o.endTime - o.time) * velocity),
          r * 2,
          o.time,
          o.endTime,
          o.time - lead,
          o.endTime,
          [1, 0.75, 0.25],
          2,
          4,
          velocity,
          0,
          0,
          "taiko-roll-middle",
        );
        add(
          96,
          135,
          r * 2,
          r * 2,
          o.time,
          o.endTime,
          o.time - lead,
          o.endTime,
          [1, 0.4, 0.1],
          0,
          3,
          velocity,
          0,
          0,
          big ? "taikobigcircle" : "taikohitcircle",
        );
        if (regions.has("taiko-roll-end"))
          add(
            96,
            135,
            r * 2,
            r * 2,
            o.endTime,
            o.endTime,
            o.time - lead,
            o.endTime,
            [1, 1, 1],
            0,
            3,
            velocity,
            0,
            0,
            "taiko-roll-end",
          );
        const interval =
          t.beatLength / (map.difficulty.sliderTickRate === 3 ? 6 : 8);
        for (let time = o.time; time < o.endTime; time += interval)
          add(
            96,
            135,
            6,
            6,
            time,
            time,
            time - lead,
            time,
            [0.8, 0.35, 0.05],
            0,
            3,
            velocity,
          );
        continue;
      }
      add(
        96,
        135,
        r * 2,
        r * 2,
        o.time,
        o.time,
        o.time - lead,
        o.time + 120,
        rim
          ? (skin?.style?.taiko?.rim ?? [0.22, 0.65, 0.85])
          : (skin?.style?.taiko?.centre ?? [0.95, 0.25, 0.22]),
        0,
        3,
        velocity,
        0,
        0,
        big ? "taikobigcircle" : "taikohitcircle",
      );
      add(
        96,
        135,
        r * 2,
        r * 2,
        o.time,
        o.time,
        o.time - lead,
        o.time + 120,
        [1, 1, 1],
        1,
        3,
        velocity,
        0,
        0,
        big ? "taikobigcircleoverlay" : "taikohitcircleoverlay",
      );
    }
  } else {
    // Fruits, droplets, tiny droplets and bananas exactly as lazer builds them
    // (seeded offsets, Hard Rock offsets and hyper-dash marking included).
    const kinds = { fruit: 0, droplet: 1, tiny: 2, banana: 3 } as const;
    const fruits = catchObjects(map)
      .map((o) => ({
        time: o.time,
        x: o.x,
        kind: kinds[o.kind],
        hyper: o.hyper,
      }))
      .sort((a, b) => a.time - b.time);
    const size = Math.max(
      8,
      (106.75 * (1 - (0.7 * (map.difficulty.cs - 5)) / 5)) / 2,
    );
    for (let index = 0; index < fruits.length; index++) {
      const fruit = fruits[index],
        hyper = fruit.hyper;
      if (fruit.kind !== 2) catcher.push({ time: fruit.time, x: fruit.x });
      const r =
        fruit.kind === 0
          ? 15
          : fruit.kind === 1
            ? 7
            : fruit.kind === 2
              ? 3
              : 12;
      add(
        fruit.x,
        340,
        r * 2,
        r * 2,
        fruit.time,
        fruit.time,
        fruit.time - preempt,
        fruit.time + 100,
        fruit.kind === 3
          ? [1, 0.9, 0.1]
          : palette[Math.floor(fruit.time / 1000) % palette.length],
        fruit.kind === 3
          ? 8
          : fruit.kind === 0
            ? 5 + (Math.floor(fruit.time / 1000) % 2)
            : 0,
        8,
        0,
        0,
        0,
        fruit.kind === 0
          ? ["fruit-apple", "fruit-grapes", "fruit-orange"][
              Math.floor(fruit.time / 1000) % 3
            ]
          : fruit.kind === 3
            ? "fruit-bananas"
            : "fruit-drop",
      );
      const fruitAsset =
        fruit.kind === 0
          ? ["fruit-apple", "fruit-grapes", "fruit-orange"][
              Math.floor(fruit.time / 1000) % 3
            ]
          : fruit.kind === 3
            ? "fruit-bananas"
            : "fruit-drop";
      if (regions.has(fruitAsset + "-overlay"))
        add(
          fruit.x,
          340,
          r * 2,
          r * 2,
          fruit.time,
          fruit.time,
          fruit.time - preempt,
          fruit.time + 100,
          [1, 1, 1],
          4,
          8,
          0,
          0,
          0,
          fruitAsset + "-overlay",
        );
      if (hyper)
        add(
          fruit.x,
          340,
          r * 2.8,
          r * 2.8,
          fruit.time,
          fruit.time,
          fruit.time - preempt,
          fruit.time,
          [1, 0.15, 0.1],
          1,
          8,
        );
    }
    for (let state = 0; state < 3; state++) {
      const name = [
          "fruit-catcher-idle",
          "fruit-catcher-kiai",
          "fruit-catcher-fail",
        ][state],
        asset = regions.has(name) ? name : "fruit-catcher-idle",
        uv = regions.get(asset),
        w = size * 2,
        h = uv ? (w * uv.h) / uv.w : 20;
      add(
        256,
        350 + h / 2,
        w,
        h,
        0,
        0,
        -1e9,
        1e9,
        [1, 1, 1],
        4,
        15 + state,
        0,
        0,
        0,
        asset,
      );
    }
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
    preempt,
    scrollBase,
    speed:
      map.mode === 1
        ? speed
        : map.mode === 3
          ? speed * (options.noteSpeed ?? 1)
          : speed,
    catcher,
  };
}
