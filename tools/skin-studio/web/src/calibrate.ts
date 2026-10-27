// Hit position and hold-tail calibration: the arithmetic, in one place.
//
// Units. skin.ini's mania positions are legacy units (a 480-tall stage);
// lazer draws the stage 768 tall, so one unit is 1.6 lazer units
// (`LegacySkin.STABLE_MAGIC_SCALE_FACTOR`, lazer's POSITION_SCALE_FACTOR;
// render-core's MANIA_SCALE). Mania images are drawn one pixel per lazer unit
// (`LegacyKeyArea` uses the texture's display height), so one HitPosition
// unit is 1.6 image pixels, 3.2 in an @2x image: "5 HitPosition = 8 px".
//
// Speed. lazer's `DrawableManiaRuleset` (ppy/osu 2026.1005.0-lazer):
// `ComputeScrollTime(speed) = MAX_TIME_RANGE / speed` with MAX_TIME_RANGE =
// 11485 ms, the time a note takes over the scroll length at the default hit
// position (768 − 124.8 lazer units), scaled by the scroll length and the
// clock rate in `updateTimeRange` so the speed in real time does not depend
// on the hit position or on rate mods. `RelativeScaleBeatLengths` multiplies
// it by the map's main beat length over the current one and by the slider
// velocity (render-core's `scrollPosition`). lazer's scroll speed setting
// adopted osu!stable's scale (1–40), so a stable speed is read the same way;
// stable's code is closed, and its "scale scroll speed with BPM" option is
// modelled as including (on) or leaving out (off) the beat-length factor.

import type { Beatmap } from "@vosu-tools/osu-parse";
import { scrollPosition } from "@vosu-tools/osu-parse";
import type { Simulation } from "@vosu-tools/replay";

/** Lazer units per skin.ini position unit. */
export const LEGACY_SCALE = 1.6;
/** lazer's `DrawableManiaRuleset.MAX_TIME_RANGE` (ms). */
export const MAX_TIME_RANGE = 11485;
/** Scroll length at the default hit position (402): 768 − 78 × 1.6 lazer units. */
export const DEFAULT_SCROLL_LENGTH = 768 - (480 - 402) * LEGACY_SCALE;

/** Image pixels for `units` of HitPosition: 1.6 per unit, 3.2 in @2x images. */
export const hitPositionPixels = (units: number, hd: boolean) =>
  units * LEGACY_SCALE * (hd ? 2 : 1);

/**
 * Rows the receptor graphic of a key image moves up when HitPosition goes
 * from `from` to `to` (a lower HitPosition puts the hit line higher). Whole
 * rows: a fractional 1x shift (1.6 px per unit) is rounded to the nearest.
 */
export function receptorShift(from: number, to: number, hd: boolean) {
  const exact = hitPositionPixels(from - to, hd);
  return { rows: Math.round(exact), exact };
}

export interface Speed {
  client: "stable" | "lazer";
  /** The client's mania scroll speed (1–40). */
  speed: number;
  /** stable's "scale scroll speed with BPM" (lazer always scales). */
  bpmScale?: boolean;
}

/** A map's main beat length: the one lasting longest (`RelativeScaleBeatLengths`). */
export function mainBeatLength(map: Beatmap): number {
  const red = map.timing.filter((t) => t.uninherited);
  const weights = new Map<number, number>();
  red.forEach((point, i) => {
    const end = red[i + 1]?.time ?? map.duration;
    weights.set(point.beatLength, (weights.get(point.beatLength) ?? 0) + Math.max(0, end - Math.max(0, point.time)));
  });
  let best = 500,
    weight = -1;
  for (const [beat, w] of weights) if (w > weight) [best, weight] = [beat, w];
  return best;
}

/**
 * How fast a note moves at map time `time`, in lazer units per real
 * millisecond: the scroll length over the time range, times the scroll
 * multiplier (slider velocity, and the main beat length over the current one
 * unless stable's BPM scaling is off).
 */
export function noteVelocity(map: Beatmap, time: number, speed: Speed, base = mainBeatLength(map)): number {
  const scaled = speed.client === "lazer" || speed.bpmScale !== false;
  const at = (t: number) => scrollPosition(map.timing, t, "mania", scaled ? base : undefined);
  // Piecewise linear: the slope just after `time`.
  const multiplier = at(time + 0.5) - at(time - 0.5);
  return (DEFAULT_SCROLL_LENGTH / (MAX_TIME_RANGE / speed.speed)) * multiplier;
}

export interface Offsets {
  /** Hits counted (misses and unjudged parts left out). */
  count: number;
  /** Mean offset in real milliseconds (negative: early). */
  mean: number;
  /** Standard deviation, real milliseconds. */
  spread: number;
  /** The note speed most hits saw (median), lazer units per real millisecond. */
  velocity: number;
  /** Mean offset × that speed: lazer units the player is ahead (negative) or behind. */
  distance: number;
}

export interface CalibrationOffsets extends Offsets {
  /** Physical releases observed, including those the client rejected. */
  total: number;
  excluded: number;
  /** Accepted releases beyond stable ScoreV1's meh window, never silently dropped. */
  veryLate: number;
}

/** At least this many hits before a calibration is offered. */
export const MIN_HITS = 50;

/**
 * Press (`note` and hold `head`) or release (hold `tail`) offsets of a
 * judged play, in real time (map time ÷ the clock rate) and as distances on
 * screen at the speed the notes moved when they were hit.
 */
export function offsets(
  simulation: Simulation,
  map: Beatmap,
  which: "press" | "release",
  speed: Speed,
  rate: number,
): CalibrationOffsets {
  // Which part an event judged: lazer's rules name it; for osu!stable's, a
  // hold's end is the judgement whose object time is the hold's end time.
  const part = (e: Simulation["events"][number]) => {
    if (e.object === "note" || e.object === "head" || e.object === "tail") return e.object;
    const o = map.objects[e.note];
    if (!o) return null;
    const at = e.time - e.offset;
    return o.endTime > o.time && Math.abs(at - o.endTime) < 1 ? "tail" : "note";
  };
  const parts = which === "press" ? ["note", "head"] : ["tail"];
  const base = mainBeatLength(map);
  // Releases come from physical key-up samples captured by the client's judge,
  // not just tail events: an early combo drop may have no timed tail event at all.
  const releases = simulation.releases ?? [];
  const hits = which === "release"
    ? releases.filter((release) => release.hit && Number.isFinite(release.offset))
    : simulation.events.filter(
      (e) => e.timed !== false && e.kind !== "miss" && e.result !== "miss" && Number.isFinite(e.offset) && parts.includes(part(e) ?? ""),
    );
  const real = hits.map((e) => e.offset / rate);
  const count = real.length;
  const mean = count ? real.reduce((a, b) => a + b, 0) / count : 0;
  const spread = count ? Math.sqrt(real.reduce((a, b) => a + (b - mean) ** 2, 0) / count) : 0;
  // The median speed, so a few notes in slider-velocity effects (up to 10×)
  // do not decide where the receptors go. Offsets are in real time and the
  // velocity is per real millisecond (rate mods change neither).
  const speeds = hits.map((e) => noteVelocity(map, e.time - e.offset, speed, base)).sort((a, b) => a - b);
  const velocity = count ? speeds[Math.floor(count / 2)] : noteVelocity(map, 0, speed, base);
  const total = which === "release" ? releases.length : count;
  const veryLate = which === "release" ? releases.filter((release) => release.hit && release.veryLate).length : 0;
  return { count, mean, spread, velocity, distance: mean * velocity, total, excluded: total - count, veryLate };
}

/**
 * The HitPosition that puts the hit line where the player presses: early
 * presses (negative distance) happen while notes are still above the line,
 * so the line moves up, which is a lower HitPosition. Kept to skin.ini's
 * range (240–480, `LegacyManiaSkinDecoder`).
 */
export function calibratedHitPosition(current: number, press: Offsets): number {
  return Math.min(480, Math.max(240, Math.round(current + press.distance / LEGACY_SCALE)));
}

/** The units lazer stretches a repeating hold body over, from the tail end (render-core's mania notes; LegacyBodyPiece). */
export const BODY_UNITS = 32800;

/**
 * Where a hold ends on screen, and how it moves to the release point
 * (`release.distance` lazer units after the end time, negative: before).
 *
 * lazer draws a hold's tail with its bottom edge on the end time, flipped
 * in downscroll (render-core's tails: `kind 1`, "inverted"), and the body
 * from half under the head to half the tail's height past the end time
 * (`DrawableHoldNote.Update`: body height `DrawHeight − Head/2 + Tail/2`).
 * A repeating body style is stretched over 32800 units from that end
 * (render-core's mania notes; lazer's "i dunno this looks about right??"),
 * so a body image's top rows are what shows at the end. That is how percy
 * skins end holds before their end time: a blank tail, and the cap painted
 * into the top of a tall body image below transparent rows (the user's
 * "Pointy NOT Percy" set: a 1-row transparent LNT and a 40000-row LNB with
 * 46 transparent rows on top). stable's code is closed; skins built this
 * way (body rows at the cap's scale) look the same in both clients.
 *
 * - percy skin (blank tail, repeating body): the body's content moves down
 *   (early) or up (late, at most its transparent top rows).
 * - normal skin, late: transparent rows before the cap on the end-time side
 *   (`gap`), so the cap's bottom edge is on the release point and the body,
 *   visible in the gap, reaches it.
 * - normal skin, early: converted to percy. The body becomes `height` rows
 *   (32800 units at the cap's scale, as wide as the cap) with the flipped
 *   cap's bottom edge on the release point (`capBottom`), and the tail a
 *   transparent spacer just tall enough for the body to hold the cap.
 */
export type HoldPlan =
  | { kind: "none"; note: string }
  | { kind: "shift-body"; up: number; note: string }
  | { kind: "gap"; gap: number; note: string }
  | { kind: "percy"; spacer: number; height: number; capBottom: number; note: string };
export interface HoldImages {
  /** Opaque rows of the tail image (0: a blank tail). */
  capRows: number;
  tailWidth: number;
  bodyHeight: number;
  /** Transparent rows at the top of the body image. */
  bodyTop: number;
  /** Width notes are drawn at (`noteHeightWidth`), lazer units. */
  noteWidth: number;
  percy: boolean;
}
export function holdPlan(release: Offsets, images: HoldImages): HoldPlan {
  const d = release.distance;
  const direction = d >= 0 ? "late" : "early";
  if (Math.abs(d) < 0.5) return { kind: "none", note: "releases on time: hold ends stay" };
  if (images.percy) {
    // Body rows per lazer unit, as lazer stretches the body.
    const rows = Math.round((d * images.bodyHeight) / BODY_UNITS);
    const up = d > 0 ? Math.min(rows, images.bodyTop) : rows;
    return {
      kind: "shift-body",
      up,
      note: `percy holds (blank tail): the body's end moves ${up >= 0 ? "up" : "down"} ${Math.abs(up)} rows (${direction})${d > 0 && rows > images.bodyTop ? `, limited to its ${images.bodyTop} clear rows` : ""}`,
    };
  }
  // Tail rows per lazer unit (notes keep their aspect at the note width).
  const perUnit = images.tailWidth / images.noteWidth;
  if (d > 0) {
    const gap = Math.round(d * perUnit);
    return { kind: "gap", gap, note: `late releases: the cap moves up ${gap} rows off the end time` };
  }
  const early = Math.round(-d * perUnit);
  const spacer = Math.max(1, Math.ceil(2 * Math.max(0, images.capRows - early)));
  return {
    kind: "percy",
    spacer,
    height: Math.round(BODY_UNITS * perUnit),
    capBottom: Math.floor(spacer / 2) + early,
    note: `early releases: converted to percy holds, the cap's bottom edge ${early} rows before the end time`,
  };
}
