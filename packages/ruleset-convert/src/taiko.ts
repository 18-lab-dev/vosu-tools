import {
  addControlPoint,
  almostEquals,
  f32,
  pointAt,
  precisionAdjustedBeatLength,
  Sound,
  timingPointAt,
  type EffectLine,
  type LegacyBeatmap,
  type LegacyObject,
} from "./legacy";

/**
 * osu! → osu!taiko conversion, ported from osu!lazer's `TaikoBeatmapConverter`
 * (ppy/osu 2026.1005.0-lazer, MIT). The float casts are kept on purpose: lazer
 * keeps them to stay 1:1 with stable's drum roll lengths.
 */

export type TaikoKind = "hit" | "drumroll" | "swell";

export interface TaikoObject {
  kind: TaikoKind;
  time: number;
  endTime: number;
  /** Kat (blue): whistle or clap. */
  rim: boolean;
  /** Big note: finish. */
  strong: boolean;
}

export interface TaikoConversion {
  objects: TaikoObject[];
  /**
   * Effect points after conversion: slider velocity becomes scroll speed at
   * each slider's start, never at the green line itself.
   */
  effects: EffectLine[];
}

/** `TaikoBeatmapConverter.VELOCITY_MULTIPLIER` (a float in lazer). */
const velocityMultiplier = f32(1.4);
const baseScoringDistance = 100;

const fromSound = (sound: number) => ({
  rim: (sound & (Sound.whistle | Sound.clap)) !== 0,
  strong: (sound & Sound.finish) !== 0,
});

function sliderToHits(
  map: LegacyBeatmap,
  object: LegacyObject,
): { taikoDuration: number; tickSpacing: number; hits: boolean } {
  const spans = object.spans;
  const distance = (object.expectedDistance ?? 0) * velocityMultiplier * spans;
  const timingPoint = timingPointAt(map.points, object.time);
  let beatLength = precisionAdjustedBeatLength(
    object.sliderVelocity,
    timingPoint.beatLength,
    "taiko",
  );
  const sliderScoringPointDistance =
    (baseScoringDistance * (map.sliderMultiplier * velocityMultiplier)) /
    map.sliderTickRate;
  const taikoVelocity = sliderScoringPointDistance * map.sliderTickRate;
  const taikoDuration = Math.trunc((distance / taikoVelocity) * beatLength);
  const osuVelocity = taikoVelocity * (1000 / beatLength);
  if (map.formatVersion >= 8) beatLength = timingPoint.beatLength;
  const tickSpacing = Math.min(
    beatLength / map.sliderTickRate,
    taikoDuration / spans,
  );
  return {
    taikoDuration,
    tickSpacing,
    hits: tickSpacing > 0 && (distance / osuVelocity) * 1000 < 2 * beatLength,
  };
}

/** Effect points once lazer has turned slider velocities into scroll speeds. */
function convertedEffects(map: LegacyBeatmap): EffectLine[] {
  const effects = map.points.effect.map((e) => ({ ...e }));
  let lastScrollSpeed = 1;
  for (const object of map.objects) {
    if (object.kind !== "slider") continue;
    const next = object.sliderVelocity;
    const current = pointAt(effects, object.time, {
      time: 0,
      kiai: false,
      scrollSpeed: 1,
    });
    if (next === lastScrollSpeed) continue;
    lastScrollSpeed = next;
    addControlPoint(
      effects,
      { time: object.time, kiai: current.kiai, scrollSpeed: next },
      (e) =>
        (e?.kiai ?? false) === current.kiai && (e?.scrollSpeed ?? 1) === next,
    );
  }
  return effects;
}

/** `TaikoBeatmapConverter` for an osu!-ruleset beatmap. */
export function convertToTaiko(map: LegacyBeatmap): TaikoConversion {
  const objects: TaikoObject[] = [];
  for (const object of map.objects) {
    if (object.kind === "slider") {
      const { taikoDuration, tickSpacing, hits } = sliderToHits(map, object);
      if (hits) {
        const sounds = object.nodeSounds;
        let i = 0;
        for (
          let time = object.time;
          time <= object.time + taikoDuration + tickSpacing / 8;
          time += tickSpacing
        ) {
          objects.push({
            kind: "hit",
            time,
            endTime: time,
            ...fromSound(sounds[i]),
          });
          i = (i + 1) % sounds.length;
          if (almostEquals(0, tickSpacing)) break;
        }
      } else
        objects.push({
          kind: "drumroll",
          time: object.time,
          endTime: object.time + taikoDuration,
          ...fromSound(object.sound),
          rim: false,
        });
    } else if (object.kind === "spinner" || object.kind === "hold")
      objects.push({
        kind: "swell",
        time: object.time,
        endTime: object.endTime,
        rim: false,
        strong: false,
      });
    else
      objects.push({
        kind: "hit",
        time: object.time,
        endTime: object.time,
        ...fromSound(object.sound),
      });
  }
  // lazer orders converted objects by start time, keeping generation order on ties.
  objects.sort((a, b) => a.time - b.time);
  return { objects, effects: convertedEffects(map) };
}
