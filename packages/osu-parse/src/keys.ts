/**
 * The osu!mania key count, as osu! (lazer) `2026.1005.0-lazer`
 * (`9a10d935b05a3b896f4bd811d620f2023331db93`) plays a native mania map. The
 * same rule, and the same test table (`crates/mania-keys/key-counts.json`), is
 * the Rust crate `mania-keys`. Converted osu! maps get their count from
 * `@vosu-tools/ruleset-convert` (`maniaKeys`, `convertBeatmap`) instead.
 */
import type { Beatmap } from "./index";

/** `LegacyBeatmapDecoder.MAX_MANIA_KEY_COUNT`. */
export const MAX_MANIA_KEYS = 18;
/** `ManiaRuleset.MAX_STAGE_KEYS`. */
export const MAX_STAGE_KEYS = 10;
/** osu!'s `CircleSize` when a map has none (`IBeatmapDifficultyInfo.DEFAULT_DIFFICULTY`). */
export const DEFAULT_CIRCLE_SIZE = 5;

/** .NET `Math.Round` / `MathF.Round`: midpoints go to the even neighbour. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value),
    diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Columns lazer plays a native mania map with: `CircleSize` (a float) clamped
 * to 1–18 by `LegacyBeatmapDecoder.applyDifficultyRestrictions`,
 * `Math.Max(1, Math.Round(CircleSize))` in `ManiaBeatmapConverter.getColumnCount`
 * (half to even: 6.5 → 6, 7.5 → 8), and above 10 keys two stages of half each
 * (`TargetColumns /= 2`, `Dual`), so 11, 13, 15 and 17 lose a column. Throws
 * for a non-finite `CircleSize`.
 */
export function maniaKeyCount(circleSize: number = DEFAULT_CIRCLE_SIZE): number {
  if (!Number.isFinite(circleSize))
    throw new Error(`invalid CircleSize ${circleSize}`);
  const size = Math.min(MAX_MANIA_KEYS, Math.max(1, Math.fround(circleSize)));
  const target = Math.max(1, roundHalfEven(size));
  return target > MAX_STAGE_KEYS ? Math.floor(target / 2) * 2 : target;
}

/**
 * The key count of a mania `map` as played: the conversion's count for a
 * converted osu! map (`maniaColumns`, set by `convertBeatmap`), otherwise
 * `maniaKeyCount` of its `CircleSize`.
 */
export function maniaColumns(map: Pick<Beatmap, "difficulty" | "maniaColumns">): number {
  return map.maniaColumns ?? maniaKeyCount(map.difficulty.cs);
}
