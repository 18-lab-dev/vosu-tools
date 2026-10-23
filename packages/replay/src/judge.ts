/**
 * One entry point for judging a replay: the map gets the replay's mods (with
 * lazer's settings), then each ruleset's simulator judges it with the rules of
 * the client that set it.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import { healthAt, type Replay } from "./index";
import { simulateCatch } from "./catch";
import { simulateMania } from "./mania";
import { beatmapForReplay, unreproducedMods } from "./mods";
import { simulateOsu } from "./osu";
import { simulateTaiko } from "./taiko";
import { simulate, type Simulation } from "./simulation";

export interface Judged {
  /** The playable map: the `.osu` with the replay's mods applied. */
  map: Beatmap;
  simulation: Simulation;
}

/**
 * Judges `replay` on the parsed `.osu` (no mods applied). osu! and catch use
 * lazer's rules (Classic for osu!stable replays). Taiko and mania replays set
 * on lazer use lazer's rules; osu!stable ones keep stable's counting, and get
 * lazer's Classic judgements only for the simulated health (compared with the
 * recorded life graph, see `healthDeviation`).
 */
export function judgeReplay(replay: Replay, raw: Beatmap): Judged {
  if (raw.mode !== replay.mode) throw new Error("Converted rulesets are not yet supported: select a native-ruleset replay");
  const unreproduced = unreproducedMods(replay);
  if (unreproduced.length) throw new Error(`Not judged: ${unreproduced.join(", ")} not reproduced`);
  const map = beatmapForReplay(raw, replay);
  if (replay.mode === 0) return { map, simulation: simulateOsu(replay, map, { baseDifficulty: raw.difficulty }) };
  if (replay.mode === 2) return { map, simulation: simulateCatch(replay, map, { baseDifficulty: raw.difficulty }) };
  const lazer = replay.mode === 1 ? simulateTaiko(replay, map) : simulateMania(replay, map);
  if (replay.lazer) return { map, simulation: lazer };
  const columns = Math.round(map.difficulty.cs);
  const stable = simulate(
    replay,
    map.objects.map((o) => ({
      time: o.time,
      endTime: o.type & 128 ? o.endTime : undefined,
      column: Math.min(columns - 1, Math.floor((o.x * columns) / 512)),
      rim: !!(o.sound & 10),
      kind: o.type & 128 ? "hold" : o.type & 2 ? "slider" : o.type & 8 ? "spinner" : "circle",
      x: o.x,
      y: o.y,
    })),
    map.difficulty.od,
    columns,
  );
  stable.health = lazer.health;
  return { map, simulation: stable };
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
