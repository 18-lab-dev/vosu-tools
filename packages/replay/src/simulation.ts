import { type Replay, type Counts, healthAt } from "./index";
import type { HealthPoint } from "./health";

export type Result = keyof Counts;
export interface Judgement {
  time: number;
  note: number;
  /** The header counter this judgement adds to; `null` for ticks, tails and bonus. */
  result: Result | null;
  offset: number;
  /** `false` when `offset` is not a hit error (ticks, catches, spinners). */
  timed?: boolean;
  /** lazer's result name (`great`, `large_tick_hit`, ...), lazer's rules only. */
  kind?: string;
  /** The judged object (a hold's `head` or `tail`, ...), lazer's rules only. */
  object?: string;
  x: number;
  y: number;
  combo: number;
  counts: Counts;
  accuracy: number;
  /** The client's score after this judgement, when the simulation computes it. */
  score?: number;
}
export interface Simulation {
  events: Judgement[];
  counts: Counts;
  verified: boolean;
  comboVerified: boolean;
  /** The simulated score ends on the recorded one (osu! and catch). */
  scoreVerified: boolean;
  /** Header counters, or lazer statistics, that differ from the replay. */
  differences: Record<string, { expected: number; actual: number }>;
  warnings: string[];
  /** Whose rules judged the replay (osu! and catch). */
  client?: "stable" | "lazer";
  /** lazer `HitResult` counts (lazer's rules). */
  statistics?: Record<string, number>;
  /** lazer's health bar from these judgements (see `health.ts`). */
  health?: HealthPoint[];
}
const empty = (): Counts => ({
  n300: 0,
  n100: 0,
  n50: 0,
  geki: 0,
  katu: 0,
  miss: 0,
});
export function accuracy(mode: number, c: Counts): number {
  if (mode === 0) {
    const total = c.n300 + c.n100 + c.n50 + c.miss;
    return total ? (300 * c.n300 + 100 * c.n100 + 50 * c.n50) / (300 * total) : 1;
  }
  if (mode === 2) {
    const caught = c.n300 + c.n100 + c.n50,
      total = caught + c.katu + c.miss;
    return total ? caught / total : 1;
  }
  if (mode === 3) {
    const total = c.geki + c.n300 + c.katu + c.n100 + c.n50 + c.miss;
    return total
      ? (300 * (c.geki + c.n300) + 200 * c.katu + 100 * c.n100 + 50 * c.n50) /
          (300 * total)
      : 1;
  }
  const total = c.n300 + c.n100 + c.miss;
  return total ? (2 * c.n300 + c.n100) / (2 * total) : 1;
}
export function stateAt(replay: Replay, simulation: Simulation, time: number) {
  let low = 0,
    high = simulation.events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (simulation.events[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  const event = simulation.events[low - 1];
  return {
    combo: simulation.comboVerified ? (event?.combo ?? 0) : null,
    counts: event?.counts ?? empty(),
    accuracy: event?.accuracy ?? 1,
    score: simulation.scoreVerified ? (event?.score ?? 0) : null,
    // The recorded life graph, else lazer's simulated bar (verified judgements only).
    health: replay.life.length
      ? healthAt(replay, time)
      : simulation.verified && simulation.health?.length
        ? healthAt({ life: simulation.health }, time)
        : null,
    verified: simulation.verified,
  };
}
