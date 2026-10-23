/**
 * osu!catch judgement simulation, following lazer (ppy/osu, MIT): every
 * palpable object is judged on the first update at or after its time, caught
 * when its x lies within half the catcher's width of the catcher
 * (`Catcher.CanCatch`). The catcher's x comes from the replay, so walking,
 * dashing and hyper-dashes are already in the positions.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import { catchObjects, f32 } from "@vosu-tools/ruleset-convert";
import type { Replay, ReplayFrame } from "./index";
import { playbackFrames } from "./osu";
import {
  clientOf,
  lazerMultiplier,
  legacyMultiplier,
  peppyStars,
  replayMods,
  tally,
  verify,
  type HitResult,
  type Outcome,
  type Rules,
} from "./scoring";
import type { Result, Simulation } from "./simulation";

/** Half of `Catcher.CalculateCatchWidth` for a circle size (after mods). */
export function halfCatchWidth(cs: number): number {
  const scale = f32(f32(f32(1 - f32(0.7) * ((f32(cs) - 5) / 5)) / 2) * 2);
  return f32(f32(f32(f32(106.75) * Math.abs(scale)) * f32(0.8)) * 0.5);
}

/** How long after an object's time its judging update may have been recorded (ms). */
const JUDGED_WITHIN = 4;

/**
 * The catcher's x when an object due at `time` was judged. lazer records a
 * frame on the update that judges a catch, and frame times are whole
 * milliseconds: the first frame from `time - 0.5` up to `JUDGED_WITHIN`
 * later is that update. Without one (sparse frames), the position is
 * interpolated at `time`. (Derived from lazer replays: interpolating at the
 * object's time misjudges edge catches far more often.)
 */
export function catcherAt(frames: readonly ReplayFrame[], time: number): number {
  if (!frames.length) return 256;
  let low = 0,
    high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].time < time - 0.5) low = middle + 1;
    else high = middle;
  }
  const judged = frames[low];
  if (judged && judged.time - time <= JUDGED_WITHIN) return judged.x;
  // Interpolate between the last frame at or before `time` and the next.
  let a = Math.max(0, low - 1);
  while (a + 1 < frames.length && frames[a + 1].time <= time) a++;
  const from = frames[a],
    to = frames[Math.min(a + 1, frames.length - 1)];
  if (from.time > time || to.time === from.time) return from.x;
  return from.x + ((to.x - from.x) * (time - from.time)) / (to.time - from.time);
}

interface Kind {
  hit: HitResult;
  miss: HitResult;
  counts: [Result | null, Result | null];
  v1: Outcome["v1"];
}
const KINDS: Record<"fruit" | "droplet" | "tiny" | "banana", Kind> = {
  fruit: {
    hit: "great",
    miss: "miss",
    counts: ["n300", "miss"],
    v1: { value: 300, multiplied: true, bonus: false, combo: "increase" },
  },
  droplet: {
    hit: "large_tick_hit",
    miss: "large_tick_miss",
    counts: ["n100", "miss"],
    v1: { value: 100, multiplied: false, bonus: false, combo: "increase" },
  },
  tiny: {
    hit: "small_tick_hit",
    miss: "small_tick_miss",
    counts: ["n50", "katu"],
    v1: { value: 10, multiplied: false, bonus: false, combo: "none" },
  },
  banana: {
    hit: "large_bonus",
    miss: "ignore_miss",
    counts: [null, null],
    v1: { value: 1100, multiplied: false, bonus: true, combo: "none" },
  },
};

export interface CatchSimulationOptions {
  /** The map's difficulty before mods: stable's ScoreV1 multiplier uses it. */
  baseDifficulty: Beatmap["difficulty"];
}

/** Judges an osu!catch replay on the osu!-format `map` (mods applied). */
export function simulateCatch(replay: Replay, map: Beatmap, options: CatchSimulationOptions): Simulation {
  if (replay.mode !== 2) throw new Error("Not an osu!catch replay");
  if (map.mode !== 0 && map.mode !== 2) throw new Error("osu!catch plays osu! and catch maps only");
  const client = clientOf(replay),
    mods = replayMods(replay);
  if (mods.some((m) => m.acronym === "RX" || m.acronym === "AT" || m.acronym === "CN"))
    throw new Error("Relax and autoplay replays are not judged from input");
  const objects = catchObjects(map),
    frames = playbackFrames(replay.frames),
    half = halfCatchWidth(map.difficulty.cs);
  const perfect: Outcome[] = [],
    outcomes: Outcome[] = [];
  objects.forEach((o) => {
    const kind = KINDS[o.kind];
    const outcome = (hit: boolean): Outcome => ({
      time: o.time,
      note: o.index,
      type: hit ? kind.hit : kind.miss,
      max: kind.hit,
      count: kind.counts[hit ? 0 : 1],
      offset: null,
      x: o.x,
      y: 0,
      v1: { ...kind.v1, combo: hit ? kind.v1.combo : kind.v1.combo === "increase" ? "break" : "none" },
    });
    perfect.push(outcome(true));
    const x = catcherAt(frames, o.time);
    outcomes.push(outcome(o.x >= x - half && o.x <= x + half));
  });
  // Judged in time order; objects due together resolve in beatmap order.
  const order = outcomes.map((o, i) => ({ o, i }));
  order.sort((a, b) => a.o.time - b.o.time || a.i - b.i);
  const stableV2 = mods.some((m) => m.acronym === "SV2");
  const rules: Rules = {
    mode: 2,
    client,
    v1Multiplier:
      client === "stable" && !stableV2
        ? peppyStars(map, options.baseDifficulty) * legacyMultiplier(2, mods)
        : null,
    lazerMultiplier: lazerMultiplier(2, mods, replay.version),
  };
  return verify(
    replay,
    tally(
      order.map(({ o }) => o),
      perfect,
      rules,
    ),
    rules,
    [],
  );
}
