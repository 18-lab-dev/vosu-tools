/**
 * Judgements, hit lighting and hit explosions, as osu!lazer draws them for a
 * replay's results. Ported from ppy/osu at 2026.1005.0-lazer (MIT):
 * `DrawableJudgement`, `LegacyJudgementPieceOld` / `LegacyJudgementPieceNew`,
 * `ParticleExplosion`, `DefaultJudgementPiece`, `LegacySkin`'s result lookups,
 * osu!'s `DrawableOsuJudgement`, `SkinnableLighting`,
 * `OsuLegacySkinTransformer` and `LegacyJudgementPieceSliderTickHit`,
 * osu!taiko's `TaikoPlayfield`, `HitExplosion`, `LegacyHitExplosion` and
 * `TaikoLegacySkinTransformer`, osu!mania's `Stage`, `Column`,
 * `LegacyManiaJudgementPiece`, `DefaultManiaJudgementPiece` and
 * `LegacyHitExplosion`, and osu!catch's `Catcher`, `LegacyHitExplosion`,
 * `CatchComboDisplay` and `LegacyCatchComboCounter`.
 *
 * Every element is one instance of motion kind 35 (shader.ts) whose profile
 * replays the lazer piece's transforms from the result time. Nothing here
 * runs without judgement events: previews without a replay keep their
 * autoplay look.
 */
import { circleRadius, type Beatmap } from "@vosu-tools/osu-parse";
import { recoloured } from "./gpu";
import {
  hasFrames,
  regionInstances,
  type AtlasRegion,
  type Skin,
} from "./skin";

/** One result of a replay's judgement simulation (`@vosu-tools/replay` events). */
export interface JudgementEvent {
  /** Map milliseconds the result was given at. */
  time: number;
  /** lazer's result name: `great`, `ok`, `meh`, `miss`, `perfect`, `good`, `large_tick_hit`, ... */
  result: string;
  /** Index of the judged top-level object in the playable map's objects. */
  note: number;
  /**
   * The judged object: osu! `circle`, `slider`, `slider_head`, `slider_tick`,
   * `slider_repeat`, `slider_tail`, `spinner`, ...; taiko `hit`, `strong`,
   * `drumroll`, `swell`, ...; mania `note`, `head`, `tail`, `body`, `hold`;
   * catch `fruit`, `droplet`, `tiny_droplet`, `banana`.
   */
  object?: string;
  /** osu!: where the result was given (osu! pixels); mania: x is the column. */
  x: number;
  y: number;
  /** Combo after this result. */
  combo: number;
  /** osu!catch: the catcher's x when the object was judged. */
  catcher?: number;
  /**
   * osu!: the player's colour (RGB, 0-1) when several replays share one
   * playfield (overlap); the piece is recoloured in it (see `recoloured`).
   */
  tint?: readonly number[];
}

/** Shader motion kind for judgement elements and its profiles. */
const KIND = 35;
export const Profile = {
  legacyHit: 0,
  legacyMiss: 1,
  legacyTickMiss: 2,
  newMain: 3,
  newTemporary: 4,
  lighting: 5,
  tickHit: 6,
  maniaHit: 7,
  maniaMiss: 8,
  maniaExplosion: 9,
  taikoExplosion: 10,
  catchBeam: 11,
  catchGlow: 12,
  comboBefore: 13,
  comboAfter: 14,
  comboBurst: 15,
  particle: 16,
  defaultPiece: 17,
  defaultMania: 18,
  // Gameplay elements driven by a replay's input (gameplay.ts).
  drumFlash: 19,
  kiaiGlow: 20,
  still: 21,
  plateDrop: 22,
  plateExplode: 23,
  catcherTrail: 24,
  afterImage: 25,
  columnLight: 26,
  sprite: 27,
} as const;

/** How long each profile stays visible after its result, ms (the pieces' last transform). */
const LIFETIME: Record<number, number> = {
  [Profile.legacyHit]: 1100,
  [Profile.legacyMiss]: 1100,
  [Profile.legacyTickMiss]: 850,
  [Profile.newMain]: 1100,
  [Profile.newTemporary]: 1100,
  [Profile.lighting]: 1400,
  [Profile.tickHit]: 360,
  [Profile.maniaHit]: 220,
  [Profile.maniaMiss]: 220,
  [Profile.maniaExplosion]: 200,
  [Profile.taikoExplosion]: 300,
  [Profile.catchBeam]: 300,
  [Profile.catchGlow]: 700,
  [Profile.comboBefore]: 1300,
  [Profile.comboAfter]: 1300,
  [Profile.comboBurst]: 400,
  [Profile.particle]: 1100,
  [Profile.defaultPiece]: 800,
  [Profile.defaultMania]: 300,
  [Profile.drumFlash]: 150,
  [Profile.kiaiGlow]: 600,
  [Profile.still]: 1,
  [Profile.plateDrop]: 750,
  [Profile.plateExplode]: 1000,
  [Profile.catcherTrail]: 800,
  [Profile.afterImage]: 1200,
  [Profile.columnLight]: 250,
  [Profile.sprite]: 1,
};

/** Default frame rate of `GetAnimation` without the skin's AnimationFramerate. */
const DEFAULT_FPS = 60;

export interface Mark {
  asset: string;
  x: number;
  y: number;
  /** World size of the unscaled element. */
  w: number;
  h: number;
  time: number;
  profile: number;
  p1?: number;
  p2?: number;
  tint?: readonly number[];
  additive?: boolean;
  /** Animation frame rate; 0 draws the plain texture. */
  fps?: number;
  /** Visible until (defaults to the profile's lifetime). */
  until?: number;
  /** Mirror the image vertically when mania scrolls up (stage elements; normal blending). */
  maniaMirror?: boolean;
  /** Keep only the centre of the image (fractions), like `WithMaximumSize`. */
  crop?: readonly [number, number];
}

/** Writes judgement instances into a scene (the 24-float instance ABI). */
export class Marks {
  constructor(
    private readonly values: number[],
    readonly regions: Map<string, AtlasRegion>,
  ) {}
  has(asset: string): boolean {
    return this.regions.has(asset);
  }
  /** Display size of an image (SD units), or zero when missing. */
  size(asset: string): [number, number] {
    const region = this.regions.get(asset);
    return [region?.width ?? 0, region?.height ?? 0];
  }
  put(mark: Mark): void {
    const region = this.regions.get(mark.asset);
    // A negative width mirrors the image horizontally.
    if (!region || !mark.w || mark.h <= 0) return;
    const until = mark.until ?? mark.time + LIFETIME[mark.profile];
    if (!(until > mark.time)) return;
    const fps = mark.fps ?? DEFAULT_FPS,
      // An animation lookup uses the frames when there are any (a single
      // frame wins over the plain image).
      animated = fps > 0 && hasFrames(region),
      tint = mark.tint ?? [1, 1, 1, 1];
    // The frames replace the plain image, so their size does too (frames
    // share the first frame's size); callers size marks by the plain image.
    const frame = animated ? this.regions.get(`${mark.asset}-0`) : undefined,
      fx = frame?.width && region.width ? frame.width / region.width : 1,
      fy = frame?.height && region.height ? frame.height / region.height : 1;
    const crop = mark.crop;
    for (const { entry, uv: strip } of regionInstances(region, !animated)) {
      const uv = crop
        ? {
            u: strip.u + (strip.w * (1 - crop[0])) / 2,
            v: region.strips ? strip.v : strip.v + (strip.h * (1 - crop[1])) / 2,
            w: strip.w * crop[0],
            h: region.strips ? strip.h : strip.h * crop[1],
          }
        : strip;
      this.values.push(
        mark.x,
        mark.y,
        mark.w * fx,
        mark.h * fy,
        mark.time,
        mark.time,
        mark.time,
        until,
        tint[0],
        tint[1],
        tint[2],
        tint[3] ?? 1,
        KIND,
        mark.profile,
        mark.p1 ?? 0,
        mark.p2 ?? 0,
        uv.u,
        uv.v,
        uv.w,
        uv.h,
        // 40: mirrored when mania scrolls up (normal blending only).
        mark.maniaMirror ? 40 : mark.additive ? 13 : 10,
        entry,
        animated ? (region.count ?? 1) : 0,
        animated ? fps : 0,
      );
    }
  }
}

/** lazer's `RNG` stand-in: a stable pseudo-random value in [0, 1) per result. */
export function judgementRandom(time: number, note: number, salt = 0): number {
  let h =
    (Math.imul(Math.round(time * 8) | 0, 0x9e3779b1) ^
      Math.imul(note + 1, 0x85ebca77) ^
      Math.imul(salt + 1, 0xc2b2ae3d)) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const DEG = Math.PI / 180;
const isMiss = (result: string) =>
  result === "miss" ||
  result === "large_tick_miss" ||
  result === "small_tick_miss" ||
  result === "ignore_miss";

/** `LegacySkin.getJudgementAnimation`. */
const LEGACY_IMAGE: Record<string, string> = {
  miss: "hit0",
  large_tick_miss: "slidertickmiss",
  ignore_miss: "sliderendmiss",
  meh: "hit50",
  ok: "hit100",
  great: "hit300",
};
/** `LegacySkin.getParticleTexture`. */
const PARTICLE: Record<string, string> = {
  meh: "particle50",
  ok: "particle100",
  great: "particle300",
};
/** Results osu!'s judgement pooler draws (`OsuPlayfield`). */
const OSU_SHOWN = new Set([
  "great",
  "ok",
  "meh",
  "miss",
  "large_tick_hit",
  "slider_tail_hit",
  "large_tick_miss",
  "ignore_miss",
]);

/**
 * One legacy judgement piece at `(x, y)`, `scale` world units per piece
 * unit: `LegacyJudgementPieceNew` when the skin has the result's particle
 * texture (main piece and particles under the objects, the additive old-style
 * flash above), else `LegacyJudgementPieceOld` (above the objects).
 */
function legacyPiece(
  marks: Marks,
  skin: Skin | undefined,
  event: JudgementEvent,
  asset: string,
  x: number,
  y: number,
  scale: number,
  layer: "below" | "above",
): void {
  const [w, h] = marks.size(asset),
    tint = event.tint && recoloured(event.tint);
  const particle = PARTICLE[event.result];
  if (particle && marks.has(particle)) {
    if (layer === "below") {
      // ParticleExplosion(texture, 150, 1600), 140 units wide, restarted 100 ms early.
      const [pw, ph] = marks.size(particle);
      for (let i = 0; i < 150; i++) {
        const distance = judgementRandom(event.time, event.note, 3 * i) * 0.5,
          duration =
            1600 / 3 +
            judgementRandom(event.time, event.note, 3 * i + 1) * (1600 * 2 / 3),
          direction =
            judgementRandom(event.time, event.note, 3 * i + 2) * Math.PI * 2;
        marks.put({
          tint,
          asset: particle,
          x,
          y,
          w: pw * scale,
          h: ph * scale,
          time: event.time,
          profile: Profile.particle,
          p1: Math.floor(duration) * 8 + direction,
          p2: distance * 140 * scale,
          additive: true,
          fps: 0,
        });
      }
      marks.put({
        tint,
        asset,
        x,
        y,
        w: w * scale,
        h: h * scale,
        time: event.time,
        profile: Profile.newMain,
      });
    } else
      marks.put({
        tint,
        asset,
        x,
        y,
        w: w * scale,
        h: h * scale,
        time: event.time,
        profile: Profile.newTemporary,
        p2: 1.05,
        additive: true,
      });
    return;
  }
  if (layer === "below") return;
  if (event.result === "miss") {
    const rotation =
      (judgementRandom(event.time, event.note) * 2 - 1) * 8.6 * DEG;
    marks.put({
      tint,
      asset,
      x,
      y,
      w: w * scale,
      h: h * scale,
      time: event.time,
      profile: Profile.legacyMiss,
      p1: rotation,
      // Skins newer than 1.0 drop the miss 80 units from 5 above.
      p2: (skin?.version ?? Infinity) > 1 ? scale : 0,
    });
  } else
    marks.put({
      tint,
      asset,
      x,
      y,
      w: w * scale,
      h: h * scale,
      time: event.time,
      profile: isMiss(event.result) ? Profile.legacyTickMiss : Profile.legacyHit,
      p2: 1,
    });
}

/**
 * `DefaultJudgementPiece` (the built-in triangles and argon looks); osu!'s
 * `OsuJudgementPiece` also widens its hits (`stretch`).
 */
function defaultPiece(
  marks: Marks,
  event: JudgementEvent,
  asset: string,
  x: number,
  y: number,
  scale: number,
  stretch = false,
): void {
  const [w, h] = marks.size(asset),
    tint = event.tint && recoloured(event.tint);
  marks.put({
    tint,
    asset,
    x,
    y,
    w: w * scale,
    h: h * scale,
    time: event.time,
    profile: Profile.defaultPiece,
    p1: event.result === "miss" ? 1 : stretch ? 2 : 0,
    p2: scale,
    fps: 0,
  });
}

export interface OsuJudgementOptions {
  map: Beatmap;
  events: readonly JudgementEvent[];
  marks: Marks;
  skin?: Skin;
  /** An object's accent (combo) colour. */
  colour: (note: number) => readonly number[];
  hitLighting: boolean;
}

/**
 * osu!: judgements at the judged object (sliders at their tail), scaled with
 * the circle size, with hit lighting in the object's combo colour. `below`
 * draws what lazer keeps under the hit objects, `above` the proxied pieces.
 */
export function osuJudgements(options: OsuJudgementOptions): {
  below(): void;
  above(): void;
} {
  const { map, events, marks, skin } = options,
    scale = circleRadius(map.difficulty.cs) / 64,
    style = skin?.judgements ?? "legacy",
    version = skin?.version ?? Infinity;
  // DrawableSlider.DisplayResult: slider judgements show with classic behaviour,
  // where the head counts as a large tick.
  const classic = new Set<number>();
  for (const e of events)
    if (e.object === "slider_head" && e.result.startsWith("large_tick"))
      classic.add(e.note);
  const shown = events.filter(
    (e) =>
      OSU_SHOWN.has(e.result) &&
      (e.object !== "slider" || classic.has(e.note)) &&
      e.object !== "spinner_tick" &&
      e.object !== "spinner_bonus",
  );
  const at = (e: JudgementEvent): [number, number] => {
    const o = map.objects[e.note];
    if (e.object !== "slider" || !o) return [e.x, e.y];
    // DrawableOsuJudgement: a slider's judgement sits on its tail circle.
    const offset = (o.stack * circleRadius(map.difficulty.cs)) / 10,
      end =
        o.repeats % 2 === 0 || !o.path.length
          ? { x: o.x, y: o.y }
          : o.path[o.path.length - 1];
    return [end.x - offset, end.y - offset];
  };
  /** The tick-hit sprite (`LegacyJudgementPieceSliderTickHit`) for skins before 2.0. */
  const tickHit = (result: string) =>
    version < 2
      ? result === "large_tick_hit"
        ? "sliderpoint30"
        : result === "slider_tail_hit"
          ? "sliderpoint10"
          : undefined
      : undefined;
  return {
    below() {
      for (const e of shown) {
        const [x, y] = at(e);
        // SkinnableLighting: hits that are not ticks, in the object's colour.
        if (
          options.hitLighting &&
          (e.result === "great" || e.result === "ok" || e.result === "meh") &&
          marks.has("lighting")
        ) {
          const [w, h] = marks.size("lighting");
          marks.put({
            asset: "lighting",
            x,
            y,
            w: w * scale,
            h: h * scale,
            time: e.time,
            profile: Profile.lighting,
            tint: e.tint ? recoloured(e.tint) : options.colour(e.note),
            additive: true,
            fps: 0,
          });
        }
        const asset = LEGACY_IMAGE[e.result];
        if (style === "default") {
          if (asset && !e.result.includes("tick") && e.result !== "ignore_miss")
            defaultPiece(marks, e, asset, x, y, scale, true);
        } else if (asset && marks.has(asset))
          legacyPiece(marks, skin, e, asset, x, y, scale, "below");
      }
    },
    above() {
      if (style === "default") return;
      for (const e of shown) {
        const [x, y] = at(e);
        const point = tickHit(e.result);
        if (point && marks.has(point)) {
          const [w, h] = marks.size(point);
          marks.put({
            asset: point,
            x,
            y,
            w: w * scale,
            h: h * scale,
            time: e.time,
            profile: Profile.tickHit,
            tint: e.tint && recoloured(e.tint),
            p1: scale,
            fps: 0,
          });
          continue;
        }
        const asset = LEGACY_IMAGE[e.result];
        if (asset && marks.has(asset))
          legacyPiece(marks, skin, e, asset, x, y, scale, "above");
      }
    },
  };
}

/** A taiko note's own result: when it was hit or missed. */
export interface TaikoNoteResult {
  time: number;
  hit: boolean;
  /** When a strong note's second hit landed. */
  second?: number;
}

/** Results of taiko's hit objects (drum rolls and swells keep their autoplay look). */
export function taikoNoteResults(
  events: readonly JudgementEvent[],
): Map<number, TaikoNoteResult> {
  const out = new Map<number, TaikoNoteResult>();
  for (const e of events)
    if (e.object === "hit")
      out.set(e.note, { time: e.time, hit: !isMiss(e.result) });
  for (const e of events) {
    const note = out.get(e.note);
    if (e.object === "strong" && note?.hit && !isMiss(e.result))
      note.second = e.time;
  }
  return out;
}

const TAIKO_EXPLOSION: Record<string, string> = {
  miss: "taiko-hit0",
  ok: "taiko-hit100",
  great: "taiko-hit300",
};

export interface TaikoJudgementOptions {
  events: readonly JudgementEvent[];
  marks: Marks;
  skin?: Skin;
  /** The hit target's centre, world units. */
  x: number;
  y: number;
  /** World units per playfield unit. */
  scale: number;
}

/**
 * osu!taiko: hit explosions under the hit target for every hit's result
 * (taiko-hit0/100/300, the `k` image fading in on a strong note's second
 * hit), and judgement pieces over it only when the skin brings no explosions
 * of its own (`TaikoLegacySkinTransformer`).
 */
export function taikoJudgements(options: TaikoJudgementOptions): {
  explosions(): void;
  judgements(): void;
} {
  const { events, marks, skin, x, y, scale } = options;
  const notes = taikoNoteResults(events);
  const shown = events.filter(
    (e) => e.object === "hit" && TAIKO_EXPLOSION[e.result] !== undefined,
  );
  const ownExplosions =
    marks.has("taiko-hit300") && !skin?.fallback?.has("taiko-hit300");
  return {
    explosions() {
      for (const e of shown) {
        const asset = TAIKO_EXPLOSION[e.result],
          strong = e.result === "miss" ? undefined : `${asset}k`,
          second = notes.get(e.note)?.second,
          withStrong = !!strong && marks.has(strong);
        const [w, h] = marks.size(asset);
        marks.put({
          asset,
          x,
          y,
          w: w * scale,
          h: h * scale,
          time: e.time,
          profile: Profile.taikoExplosion,
          p1: withStrong && second !== undefined ? second : 0,
          p2: 0,
          additive: false,
        });
        if (withStrong && second !== undefined) {
          const [sw, sh] = marks.size(strong!);
          marks.put({
            asset: strong!,
            x,
            y,
            w: sw * scale,
            h: sh * scale,
            time: e.time,
            profile: Profile.taikoExplosion,
            p1: second,
            p2: 1,
          });
        }
      }
    },
    judgements() {
      const style = skin?.judgements ?? "legacy";
      for (const e of shown) {
        const asset = LEGACY_IMAGE[e.result];
        if (!asset || !marks.has(asset)) continue;
        if (style === "default") defaultPiece(marks, e, asset, x, y, scale);
        // A legacy skin's own hit image, when it brings no explosions: the
        // whole piece (LegacyJudgementPieceNew's particles and main piece,
        // then its old-style flash) sits in taiko's judgement layer.
        else if (!ownExplosions && !skin?.fallback?.has(asset)) {
          legacyPiece(marks, skin, e, asset, x, y, scale, "below");
          legacyPiece(marks, skin, e, asset, x, y, scale, "above");
        }
      }
    },
  };
}

/** Mania results lazer's hit windows allow, in judgement order. */
const MANIA_RESULTS = new Set(["perfect", "great", "good", "ok", "meh", "miss"]);

export interface ManiaJudgementOptions {
  events: readonly JudgementEvent[];
  marks: Marks;
  skin?: Skin;
  /** Each result's image (`maniaJudgementImages`). */
  images: Record<string, string>;
  /** World position of the judgement: stage centre at the skin's ScorePosition. */
  x: number;
  y: number;
  /** World y of the hit position (the default pieces hang 180 units above it). */
  hitY: number;
  /** World units per lazer stage unit. */
  scale: number;
}

/**
 * osu!mania: one judgement at a time over the stage (`Stage.OnNewResult`
 * clears the previous), for notes and hold heads and tails.
 */
export function maniaJudgements(options: ManiaJudgementOptions): void {
  const { events, marks, skin, images, scale } = options,
    style = skin?.judgements ?? "legacy";
  const shown = events.filter(
    (e) =>
      MANIA_RESULTS.has(e.result) &&
      e.object !== "body" &&
      e.object !== "hold",
  );
  shown.forEach((e, i) => {
    const asset = images[e.result];
    if (!asset || !marks.has(asset)) return;
    const next = shown[i + 1]?.time ?? Infinity;
    const [w, h] = marks.size(asset);
    if (style === "default") {
      marks.put({
        asset,
        x: options.x,
        y: options.hitY - 180 * scale,
        w: w * scale,
        h: h * scale,
        time: e.time,
        profile: e.result === "miss" ? Profile.defaultPiece : Profile.defaultMania,
        p1: e.result === "miss" ? 1 : 0,
        p2: scale,
        until: Math.min(e.time + 800, next),
        fps: 0,
      });
      return;
    }
    const miss = e.result === "miss";
    marks.put({
      asset,
      x: options.x,
      y: options.y,
      w: w * scale,
      h: h * scale,
      time: e.time,
      profile: miss ? Profile.maniaMiss : Profile.maniaHit,
      p1: miss
        ? (judgementRandom(e.time, e.note) * 2 - 1) * 5.73 * DEG
        : 0,
      until: Math.min(e.time + LIFETIME[Profile.maniaHit], next),
      // GetAnimation(filename, true, true, frameLength: 1000 / 20).
      fps: 20,
    });
  });
}

/** Mania hits that light their column (`Column.OnNewResult`). */
export function maniaExplosionEvents(
  events: readonly JudgementEvent[],
): JudgementEvent[] {
  return events.filter(
    (e) =>
      MANIA_RESULTS.has(e.result) &&
      e.result !== "miss" &&
      e.object !== "body" &&
      e.object !== "hold",
  );
}

/** Results that change osu!catch's combo (`HitResult.AffectsCombo`). */
const CATCH_COMBO = new Set(["great", "miss", "large_tick_hit", "large_tick_miss"]);
const CATCH_PALPABLE = new Set(["fruit", "droplet", "tiny_droplet", "banana"]);

/**
 * Display sizes (length, thickness, before the -90° rotation) of lazer's
 * classic `scoreboard-explosion-1` / `-2`, which render-core draws itself.
 */
export const CATCH_EXPLOSION_SIZES = {
  "vosu-catch-explosion-1": [39, 105],
  "vosu-catch-explosion-2": [42, 73],
} as const;

export interface CatchJudgementOptions {
  events: readonly JudgementEvent[];
  marks: Marks;
  skin?: Skin;
  /** World y of the catcher's top (the plate line). */
  catcherY: number;
  /** `Catcher` scale (from the circle size). */
  catcherScale: number;
  /** Each object's accent colour, by note index. */
  colour: (note: number) => readonly number[];
  hitLighting: boolean;
}

/**
 * osu!catch: hit lighting on the catcher (the classic skin's scoreboard
 * explosions) and the legacy combo counter above it, both following the
 * catcher.
 */
export function catchJudgements(options: CatchJudgementOptions): void {
  const { events, marks, catcherScale } = options;
  // Catcher.addLighting → LegacyHitExplosion (scale 0.5, sprites rotated -90°,
  // growing up from the catcher's top).
  if (options.hitLighting) {
    // Always the classic skin's scoreboard explosions (lazer takes them from
    // DefaultClassicSkin, never the user's skin): drawn stand-ins of their size.
    const beam = "vosu-catch-explosion-2",
      glow = "vosu-catch-explosion-1";
    const halfCatch = (106.75 * catcherScale * 0.8) / 2,
      margin = ((1 - 0.8) / 2) * 3,
      k = catcherScale * 0.5;
    for (const e of events) {
      if (!CATCH_PALPABLE.has(e.object ?? "") || isMiss(e.result)) continue;
      const dx = e.catcher === undefined ? 0 : e.x - e.catcher,
        offset =
          Math.min(halfCatch - margin, Math.max(-halfCatch + margin, dx)) * k,
        tint = options.colour(e.note);
      if (e.object !== "droplet" && e.object !== "tiny_droplet") {
        const [w, h] = marks.size(beam),
          combo = Math.min(1.125, Math.max(0.35, (e.combo - 1) / 200));
        marks.put({
          asset: beam,
          x: offset,
          y: options.catcherY,
          // Rotated: the image's length grows upwards, its thickness across.
          w: h * k,
          h: w * k,
          time: e.time,
          profile: Profile.catchBeam,
          p1: 16 * combo,
          tint,
          additive: true,
          fps: 0,
        });
      }
      const [w, h] = marks.size(glow);
      marks.put({
        asset: glow,
        x: offset,
        y: options.catcherY,
        w: h * k,
        h: w * k,
        time: e.time,
        profile: Profile.catchGlow,
        tint,
        additive: true,
        fps: 0,
      });
    }
  }
  comboCounter(options);
}

/**
 * `LegacyCatchComboCounter` in `CatcherArea` (175 units above the catcher,
 * scale 0.8): each combo change pops the previous count (1.5 to 0.8 over
 * 250 ms), then shows the new one (bump to 1.1), with an additive burst of the
 * new count in the fruit's colour; it fades 1 s after the last change, and
 * over 400 ms on a miss.
 */
function comboCounter(options: CatchJudgementOptions): void {
  const { events, marks, skin } = options;
  const fonts = skin?.sections.get("Fonts")?.[0],
    prefix = fonts?.ComboPrefix ?? "score",
    overlap = Number(fonts?.ComboOverlap ?? 0) || 0;
  const glyphs = (value: number) => {
    const names = [...String(value)].map((d) => `${prefix}-${d}`);
    if (!names.every((name) => marks.has(name))) return undefined;
    const widths = names.map((name) => marks.size(name)[0] * 0.8),
      total = widths.reduce((a, b) => a + b, 0) - overlap * 0.8 * (names.length - 1);
    let left = -total / 2;
    return names.map((name, i) => {
      const x = left + widths[i] / 2;
      left += widths[i] - overlap * 0.8;
      return { name, x, w: widths[i], h: marks.size(name)[1] * 0.8 };
    });
  };
  if (!glyphs(0)) return;
  const y = options.catcherY - 175;
  const changes = events.filter(
    (e) => CATCH_COMBO.has(e.result) && CATCH_PALPABLE.has(e.object ?? ""),
  );
  let shown = 0;
  const steps: { time: number; combo: number; previous: number; note: number }[] = [];
  for (const e of changes) {
    const combo = isMiss(e.result) ? 0 : e.combo;
    if (combo === shown) continue;
    steps.push({ time: e.time, combo, previous: shown, note: e.note });
    shown = combo;
  }
  steps.forEach((step, i) => {
    if (step.combo === 0) return;
    const next = steps[i + 1],
      fadeAt = next?.combo === 0 ? next.time : Infinity,
      cut = next ? (next.combo === 0 ? next.time + 400 : next.time) : Infinity,
      put = (
        value: number,
        profile: number,
        from: number,
        until: number,
        tint: readonly number[] = [1, 1, 1, 1],
        additive = false,
      ) => {
        if (!(until > from)) return;
        for (const glyph of glyphs(value) ?? [])
          marks.put({
            asset: glyph.name,
            x: glyph.x,
            y,
            w: glyph.w,
            h: glyph.h,
            time: from,
            profile,
            p1: step.time,
            p2: fadeAt,
            tint,
            additive,
            fps: 0,
            until,
          });
      };
    put(step.previous, Profile.comboBefore, step.time, Math.min(step.time + 250, cut));
    put(step.combo, Profile.comboAfter, step.time + 250, Math.min(step.time + 1300, cut));
    const colour = options.colour(step.note);
    put(
      step.combo,
      Profile.comboBurst,
      step.time,
      Math.min(step.time + 400, cut),
      [colour[0], colour[1], colour[2], 0.65],
      true,
    );
  });
}

/** Catcher animation states from results: idle or kiai after a catch, fail after a miss. */
export function catcherStates(
  events: readonly JudgementEvent[],
  kiai: (time: number) => boolean,
): { time: number; state: number }[] {
  const out: { time: number; state: number }[] = [];
  for (const e of events) {
    if (!CATCH_PALPABLE.has(e.object ?? "")) continue;
    if (!isMiss(e.result)) out.push({ time: e.time, state: kiai(e.time) ? 1 : 0 });
    else if (e.object !== "banana") out.push({ time: e.time, state: 2 });
  }
  return out;
}
