import type {
  Beatmap,
  HitObject,
  Mod,
  Ruleset,
  TimingPoint,
} from "@vosu-tools/osu-parse";
import { convertToCatch, type CatchObject } from "./catch";
import { legacyBeatmap, type EffectLine } from "./legacy";
import { convertToMania, maniaLayout } from "./mania";
import { convertToTaiko } from "./taiko";

export { LegacyRandom } from "./random";
// Native maps' key count (lazer's CircleSize rule) beside the convert rule
// (`maniaKeys` / `maniaLayout`): the two ways the clients pick mania columns.
export { maniaColumns, maniaKeyCount } from "@vosu-tools/osu-parse";
export {
  legacyBeatmap,
  timingPointAt,
  precisionAdjustedBeatLength,
  roundHalfEven,
  f32,
} from "./legacy";
export type { LegacyBeatmap, LegacyObject } from "./legacy";
export { convertToMania, maniaLayout, NotEnoughColumnsError } from "./mania";
export type { ManiaConversion, ManiaNote } from "./mania";
export { convertToTaiko } from "./taiko";
export type { TaikoConversion, TaikoObject, TaikoKind } from "./taiko";
export { convertToCatch } from "./catch";
export type { CatchObject, CatchKind, CatchOptions } from "./catch";

/** Whether the clients convert `map` when it is played in `ruleset`. */
export function isConvert(map: Beatmap, ruleset: Ruleset): boolean {
  return map.mode === 0 && ruleset !== 0;
}

/** Key layout lazer picks for an osu! map played in mania (with key mods / DS). */
export function maniaKeys(
  map: Beatmap,
  mods: readonly Mod[] = [],
): { columns: number; stages: number } {
  return maniaLayout(legacyBeatmap(map), mods);
}

const object = (
  time: number,
  endTime: number,
  type: number,
  sound: number,
  x = 256,
): HitObject => ({
  x,
  y: 192,
  time,
  endTime,
  type,
  sound,
  combo: 0,
  number: 1,
  stack: 0,
  path: [],
  repeats: 1,
  length: 0,
  span: endTime - time,
  ticks: [],
  edgeSounds: [],
  sample: "",
});

const line = (
  time: number,
  beatLength: number,
  uninherited: boolean,
  kiai: boolean,
): TimingPoint => ({
  time,
  beatLength,
  meter: 4,
  sampleSet: 0,
  sampleIndex: 0,
  volume: 100,
  uninherited,
  effects: kiai ? 1 : 0,
});

/**
 * Timing for a converted taiko map: the source's beat lengths, with scroll
 * speed carried by inherited lines exactly where lazer's effect points are
 * (repeated after every uninherited line, which would otherwise reset it).
 */
function taikoTiming(source: Beatmap, effects: readonly EffectLine[]) {
  const reds = source.timing.filter((t) => t.uninherited),
    times = [
      ...new Set([...reds.map((t) => t.time), ...effects.map((e) => e.time)]),
    ].sort((a, b) => a - b);
  const out: TimingPoint[] = [];
  let effectIndex = -1;
  for (const time of times) {
    while (
      effectIndex + 1 < effects.length &&
      effects[effectIndex + 1].time <= time
    )
      effectIndex++;
    const effect = effects[effectIndex] ?? { kiai: false, scrollSpeed: 1 };
    for (const red of reds)
      if (red.time === time) out.push({ ...red, effects: effect.kiai ? 1 : 0 });
    out.push(line(time, -100 / effect.scrollSpeed, false, effect.kiai));
  }
  return out;
}

/**
 * The beatmap a client plays when `map` (an osu! map) is converted to
 * `ruleset`, in osu-parse's shape so renderers treat it as a native map of that
 * ruleset. Other maps, and osu! itself, come back unchanged.
 *
 * - mania: lazer's pattern generators; `difficulty.cs` is the total key count
 *   (Dual Stages doubles it). osu! slider velocity does not scroll converts.
 * - taiko: hits, drum rolls and swells; slider velocity becomes scroll speed
 *   at each slider's start.
 * - catch: the objects stay as they are; use `catchObjects` for the fruits.
 */
export function convertBeatmap(
  map: Beatmap,
  ruleset: Ruleset,
  mods: readonly Mod[] = [],
): Beatmap {
  if (!isConvert(map, ruleset)) return map;
  const base: Beatmap = {
    ...map,
    mode: ruleset,
    general: { ...map.general, Mode: String(ruleset) },
  };
  if (ruleset === 2) return base;
  const legacy = legacyBeatmap(map);
  if (ruleset === 1) {
    const converted = convertToTaiko(legacy);
    base.objects = converted.objects.map((o) =>
      object(
        o.time,
        o.endTime,
        o.kind === "hit" ? 1 : o.kind === "drumroll" ? 2 : 8,
        (o.rim ? 2 : 0) | (o.strong ? 4 : 0),
      ),
    );
    base.timing = taikoTiming(map, converted.effects);
  } else {
    const converted = convertToMania(legacy, mods),
      total = converted.columns * converted.stages;
    base.difficulty = { ...base.difficulty, cs: total };
    base.maniaColumns = total;
    base.objects = converted.notes.map((n) =>
      object(
        n.time,
        n.endTime,
        n.hold ? 128 : 1,
        0,
        ((n.column + 0.5) * 512) / total,
      ),
    );
    // Converts have no scroll speed changes in mania; keep kiai only.
    base.timing = map.timing.map((t) =>
      t.uninherited ? { ...t } : { ...t, beatLength: -100 },
    );
  }
  base.duration = base.objects.reduce((end, o) => Math.max(end, o.endTime), 0);
  return base;
}

/**
 * The palpable catch objects lazer builds from an osu!-format map with mods
 * already applied (`applyMods`): circle size sets the catcher width for
 * hyper-dashes and Hard Rock adds its seeded fruit offsets.
 */
export function catchObjects(map: Beatmap): CatchObject[] {
  const objects = convertToCatch(legacyBeatmap(map), {
    circleSize: map.difficulty.cs,
    hardRock: map.catchHardRockOffsets ?? map.visualMods.includes("HR"),
  });
  // CatchModMirror flips every final position after conversion (native catch
  // maps; `applyMods` already mirrors osu! maps before they are converted).
  if (map.mode === 2 && map.visualMods.includes("MR"))
    for (const o of objects) o.x = 512 - o.x;
  return objects;
}
