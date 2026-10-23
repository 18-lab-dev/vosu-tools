/**
 * One entry point for judging a replay: the map gets the replay's mods (with
 * lazer's settings), then each ruleset's simulator judges it with the rules of
 * the client that set it.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import { convertBeatmap, isConvert } from "@vosu-tools/ruleset-convert";
import { healthAt, type Replay } from "./index";
import { simulateCatch } from "./catch";
import { simulateMania } from "./mania";
import { beatmapForReplay, replayMods, unreproducedMods } from "./mods";
import { simulateOsu } from "./osu";
import { clientOf } from "./scoring";
import { simulateStableMania } from "./stable-mania";
import { simulateTaiko } from "./taiko";
import type { Simulation } from "./simulation";

export interface Judged {
  /** The playable map: the `.osu` (converted to the replay's ruleset) with the replay's mods applied. */
  map: Beatmap;
  simulation: Simulation;
}

/**
 * The map a replay plays: an osu! map converted to the replay's ruleset (key
 * mods and Dual Stages choose mania's layout), then the replay's mods.
 */
export function playableMap(replay: Pick<Replay, "mode" | "mods" | "lazer">, raw: Beatmap): Beatmap {
  if (raw.mode !== replay.mode && !isConvert(raw, replay.mode))
    throw new Error("This replay belongs to another ruleset than its map");
  return beatmapForReplay(isConvert(raw, replay.mode) ? convertBeatmap(raw, replay.mode, replayMods(replay)) : raw, replay);
}

/**
 * Judges `replay` on the parsed `.osu` (no mods applied). osu! and catch use
 * lazer's rules (Classic for osu!stable replays); taiko and mania use lazer's
 * rules for lazer replays and osu!stable's for stable ones.
 */
export function judgeReplay(replay: Replay, raw: Beatmap): Judged {
  const unreproduced = unreproducedMods(replay);
  if (unreproduced.length) throw new Error(`Not judged: ${unreproduced.join(", ")} not reproduced`);
  const map = playableMap(replay, raw);
  const convert = isConvert(raw, replay.mode);
  const simulation =
    replay.mode === 0
      ? simulateOsu(replay, map, { baseDifficulty: raw.difficulty })
      : replay.mode === 2
        ? simulateCatch(replay, map, { baseDifficulty: raw.difficulty })
        : replay.mode === 1
          ? simulateTaiko(replay, map, { source: convert ? raw : undefined })
          : clientOf(replay) === "stable"
            ? simulateStableMania(replay, map, { convert })
            : simulateMania(replay, map, { convert });
  return { map, simulation };
}

/**
 * The health shown at `time`: the replay's recorded life graph (osu!stable),
 * else lazer's health simulated from verified judgements, else nothing.
 */
export function replayHealth(replay: Pick<Replay, "life">, simulation: Simulation | null | undefined, time: number): number | null {
  if (replay.life.length) return healthAt(replay, time);
  if (simulation?.verified && simulation.health?.length) return healthAt({ life: simulation.health }, time);
  return null;
}

/**
 * How far the simulated health strays from a recorded life graph, sampled at
 * the graph's own points while the map plays: mean and largest absolute error.
 */
export function healthDeviation(
  replay: Pick<Replay, "life">,
  simulation: Simulation,
): { samples: number; mean: number; max: number } | null {
  const graph = simulation.health;
  if (!replay.life.length || !graph?.length) return null;
  const start = graph[0].time,
    end = graph[graph.length - 1].time;
  let samples = 0,
    sum = 0,
    max = 0;
  for (const point of replay.life) {
    if (point.time < start || point.time > end) continue;
    const error = Math.abs(point.health - (healthAt({ life: graph }, point.time) ?? 0));
    samples++;
    sum += error;
    max = Math.max(max, error);
  }
  return samples ? { samples, mean: sum / samples, max } : null;
}
