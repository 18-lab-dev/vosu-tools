/**
 * lazer's health bar, replayed from simulated judgements (ppy/osu, MIT):
 * `DrainingHealthProcessor` (osu!), its stable-like `LegacyDrainingHealthProcessor`
 * (osu! with Classic, catch and mania; mania never drains) and taiko's
 * `AccumulatingHealthProcessor`. Drain rates come from lazer's own autoplay
 * search over the map; increases follow each ruleset's health processor.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import type { ReplayMod } from "./mods";
import { difficultyRange } from "./osu";
import type { Replay } from "./index";
import { isBonus, isHit, tally, verify, type HitResult, type Outcome, type Rules } from "./scoring";
import type { Simulation } from "./simulation";

export interface HealthPoint {
  time: number;
  health: number;
}
type Processor = "osu" | "osu-legacy" | "taiko" | "catch" | "mania";

export interface HealthSimulation {
  points: HealthPoint[];
  /** Index (in `outcomes`) of the judgement that failed the play, if any. */
  failedAt: number | null;
}

export interface HealthOptions {
  mode: 0 | 1 | 2 | 3;
  map: Pick<Beatmap, "difficulty" | "breaks">;
  mods: readonly ReplayMod[];
  /** The replay is judged with Classic (osu!stable replays, or lazer's Classic mod). */
  classic: boolean;
}

const DEFAULT_MAX = 0.05;
/** `Judgement.HealthIncreaseFor`, the default every ruleset falls back to. */
function judgementHealth(r: HitResult): number {
  switch (r) {
    case "small_tick_hit":
      return DEFAULT_MAX * 0.5;
    case "small_tick_miss":
      return -DEFAULT_MAX * 0.5;
    case "slider_tail_hit":
    case "large_tick_hit":
      return DEFAULT_MAX;
    case "large_tick_miss":
      return -DEFAULT_MAX;
    case "miss":
      return -DEFAULT_MAX * 2;
    case "meh":
      return DEFAULT_MAX * 0.05;
    case "ok":
      return DEFAULT_MAX * 0.5;
    case "good":
      return DEFAULT_MAX * 0.75;
    case "great":
      return DEFAULT_MAX;
    case "perfect":
      return DEFAULT_MAX * 1.05;
    case "small_bonus":
      return DEFAULT_MAX * 0.5;
    case "large_bonus":
      return DEFAULT_MAX;
    default:
      return 0;
  }
}

interface Top {
  start: number;
  end: number;
  self: Outcome | null;
  nested: Outcome[];
}

/**
 * Tallies judgements (in the order they were applied) with lazer's health:
 * a lazer play that failed stops judging at the failing judgement.
 */
export function judgeWithHealth(
  replay: Replay,
  options: HealthOptions,
  perfect: readonly Outcome[],
  judged: readonly Outcome[],
  rules: Rules,
  warnings: string[],
): Simulation {
  const health = simulateHealth(options, perfect, judged);
  const kept = replay.lazer && health.failedAt !== null ? judged.slice(0, health.failedAt + 1) : judged;
  const simulation = verify(replay, tally(kept, perfect, rules), rules, warnings);
  simulation.health = health.points;
  return simulation;
}

/**
 * The simulated health over time: a step at every judgement and linear drain
 * between them. `perfect` is the ruleset's autoplay (lazer's enumeration
 * order), `outcomes` the replay's judgements in the order they were applied;
 * both carry `hp` information.
 */
export function simulateHealth(
  options: HealthOptions,
  perfect: readonly Outcome[],
  outcomes: readonly Outcome[],
): HealthSimulation {
  const { mode, map, mods } = options;
  const setting = (acronym: string, key: string) => mods.find((m) => m.acronym === acronym)?.settings?.[key];
  const has = (acronym: string) => mods.some((m) => m.acronym === acronym);
  const processor: Processor =
    mode === 1
      ? "taiko"
      : mode === 2
        ? "catch"
        : mode === 3
          ? "mania"
          : options.classic && setting("CL", "classic_health") !== false
            ? "osu-legacy"
            : "osu";
  const drain = Math.fround(map.difficulty.hp);
  const range = (min: number, mid: number, max: number) => difficultyRange(drain, min, mid, max);

  // Top-level objects with their nested ones, in beatmap order.
  const groups = new Map<number, Top>();
  for (const o of perfect) {
    const key = o.hp?.group ?? o.note;
    const top = groups.get(key) ?? { start: Infinity, end: -Infinity, self: null, nested: [] };
    top.start = Math.min(top.start, o.time, o.hp?.end ?? Infinity);
    top.end = Math.max(top.end, o.hp?.end ?? o.time);
    if (o.hp?.top) top.self = o;
    else top.nested.push(o);
    groups.set(key, top);
  }
  const tops = [...groups.entries()].sort((a, b) => a[1].start - b[1].start || a[0] - b[0]).map(([, t]) => t);
  if (!tops.length) return { points: [], failedAt: null };
  const drainStart = tops[0].start,
    gameplayEnd = tops[tops.length - 1].end;
  const breaks = [...map.breaks].sort((a, b) => a[0] - b[0]);
  // `DrainingHealthProcessor`: no drain from the last object before a break to the first after it.
  const noDrain = breaks.map(([start, end]) => [
    tops.filter((t) => t.end <= start).at(-1)?.end ?? -Infinity,
    tops.find((t) => t.start >= end)?.start ?? Infinity,
  ]);

  let hpMultiplierNormal = 1;
  // osu!'s per-combo bonus state (`OsuHealthProcessor`).
  let comboResult = 2;
  const increase = (o: Outcome, simulating: boolean): number => {
    const r = o.type,
      object = o.hp?.object;
    switch (processor) {
      case "osu": {
        const base = (): number => {
          switch (r) {
            case "small_tick_miss":
            case "large_tick_miss":
              return range(-0.02, -0.075, -0.14);
            case "miss":
              return range(-0.03, -0.125, -0.2);
            case "small_tick_hit":
              return 0.02;
            case "slider_tail_hit":
            case "large_tick_hit":
              if (object === "slider_tick") return 0.015;
              if (object === "slider_head" || object === "slider_tail" || object === "slider_repeat") return 0.02;
              return judgementHealth(r);
            case "meh":
              return 0.002;
            case "ok":
              return 0.011;
            case "great":
              return 0.03;
            case "small_bonus":
              return 0.0085;
            case "large_bonus":
              return 0.01;
            default:
              return judgementHealth(r);
          }
        };
        if (simulating) return base();
        if (o.hp?.newCombo) comboResult = 2;
        if (r === "large_tick_miss" || r === "ok") comboResult = Math.min(comboResult, 1);
        if (r === "meh" || r === "miss") comboResult = 0;
        if (object === "slider_tail" && !isHit(r)) comboResult = Math.min(comboResult, 1);
        if (o.hp?.lastInCombo && isHit(r)) return base() + [0.03, 0.05, 0.07][comboResult];
        return base();
      }
      case "osu-legacy": {
        let value = 0;
        switch (r) {
          case "small_tick_miss":
          case "large_tick_miss":
            return range(-0.02, -0.075, -0.14);
          case "miss":
            return range(-0.03, -0.125, -0.2);
          case "small_tick_hit":
            value = 0.02;
            break;
          case "slider_tail_hit":
          case "large_tick_hit":
            value = object === "slider_tick" ? 0.015 : 0.02;
            break;
          case "meh":
            value = 0.002;
            break;
          case "ok":
            value = 0.011;
            break;
          case "great":
            value = 0.03;
            break;
          case "small_bonus":
            value = 0.0085;
            break;
          case "large_bonus":
            value = 0.01;
            break;
        }
        return hpMultiplierNormal * value;
      }
      case "catch": {
        let value = 0;
        switch (r) {
          case "small_tick_miss":
            return 0;
          case "large_tick_miss":
          case "miss":
            return range(-0.03, -0.125, -0.2);
          case "small_tick_hit":
            value = 0.0015;
            break;
          case "large_tick_hit":
            value = 0.015;
            break;
          case "great":
            value = 0.03;
            break;
          case "large_bonus":
            value = 0.0025;
            break;
        }
        return hpMultiplierNormal * value;
      }
      case "mania": {
        let value = 0;
        switch (r) {
          case "miss":
            return -(drain + 1) * (object === "head" || object === "tail" ? 0.00375 : 0.0075);
          case "meh":
            return -(drain + 1) * 0.0016;
          case "ok":
            return 0;
          case "good":
            value = 0.004 - drain * 0.0004;
            break;
          case "great":
            value = 0.005 - drain * 0.0005;
            break;
          case "perfect":
            value = 0.0055 - drain * 0.0005;
            break;
        }
        return hpMultiplierNormal * value;
      }
      case "taiko": {
        // Hits: TaikoJudgement; swells cost health when missed; strong hits and ticks give none.
        const value =
          object === "hit"
            ? r === "miss"
              ? -1
              : r === "ok"
                ? 1.1
                : r === "great"
                  ? 3
                  : 0
            : object === "swell" && r === "ignore_miss"
              ? -0.65
              : 0;
        return value * (isHit(r) ? taikoHit : taikoMiss);
      }
    }
  };

  // Taiko: `TaikoHealthProcessor` scales by the number of hits.
  const hits = perfect.filter((o) => o.hp?.object === "hit").length;
  const taikoHit = 1 / (3 * Math.max(1, hits) * range(0.5, 0.75, 0.98)),
    taikoMiss = range(0.0018, 0.0075, 0.012);

  let drainRate = 0;
  if (processor === "osu") drainRate = drainingRate();
  else if (processor !== "taiko") {
    const rate = legacyRate();
    drainRate = processor === "mania" ? 0 : rate;
  }

  /** `DrainingHealthProcessor.ComputeDrainRate`: autoplay just reaches the target minimum. */
  function drainingRate(): number {
    const increases = perfect
      .filter((o) => !isBonus(o.type))
      .map((o) => ({ time: o.hp?.end ?? o.time, amount: increase(o, true) }));
    if (increases.length <= 1) return 0;
    const target = Math.min(1, Math.max(0, range(0.99, 0.9, 0.4)));
    let adjustment = 1,
      result = 1;
    while (adjustment > 0) {
      let current = 1,
        lowest = 1,
        currentBreak = 0;
      for (let i = 0; i < increases.length; i++) {
        const time = increases[i].time;
        let last = i > 0 ? increases[i - 1].time : drainStart;
        while (currentBreak < breaks.length && breaks[currentBreak][1] <= time) {
          last = time;
          currentBreak++;
        }
        current -= (time - last) * result;
        lowest = Math.min(lowest, current);
        current = Math.min(1, current + increases[i].amount);
        if (lowest < 0) break;
      }
      if (Math.abs(lowest - target) <= 0.01) break;
      // C# `int` doubling: it overflows to a negative value and ends the search.
      adjustment = (adjustment * 2) | 0;
      result += (1 / adjustment) * Math.sign(lowest - target);
    }
    return result;
  }

  /** `LegacyDrainingHealthProcessor.ComputeDrainRate`, which also sets the HP multiplier. */
  function legacyRate(): number {
    const lowestHpEver = range(0.975, 0.8, 0.3),
      lowestHpEnd = range(0.99, 0.9, 0.4),
      recoveryAvailable = range(0.04, 0.02, 0);
    let testDrop = 0.00025;
    hpMultiplierNormal = 1;
    for (;;) {
      let current = 1,
        uncapped = 1,
        last = drainStart,
        currentBreak = 0,
        fail = false;
      const reduce = (amount: number) => {
        uncapped = Math.max(0, uncapped - amount);
        current = Math.max(0, current - amount);
      };
      const add = (o: Outcome) => {
        const amount = increase({ ...o, type: o.max }, true);
        uncapped += amount;
        current = Math.max(0, Math.min(1, current + amount));
      };
      for (const top of tops) {
        while (currentBreak < breaks.length && breaks[currentBreak][1] <= top.start) {
          last = top.start;
          currentBreak++;
        }
        reduce(testDrop * (top.start - last));
        last = top.end;
        if (current <= lowestHpEver) {
          fail = true;
          testDrop *= 0.96;
          break;
        }
        const reduction = testDrop * (top.end - top.start);
        const overkill = Math.max(0, reduction - current);
        reduce(reduction);
        for (const nested of top.nested) add(nested);
        if (overkill > 0 && current - overkill <= lowestHpEver) {
          fail = true;
          testDrop *= 0.96;
          break;
        }
        if (top.self) add(top.self);
      }
      if (!fail && current < lowestHpEnd) {
        fail = true;
        testDrop *= 0.94;
        hpMultiplierNormal *= 1.01;
      }
      const recovery = (uncapped - 1) / Math.max(1, tops.length);
      if (!fail && recovery < recoveryAvailable) {
        fail = true;
        testDrop *= 0.96;
        hpMultiplierNormal *= 1.01;
      }
      if (!fail && !Number.isFinite(hpMultiplierNormal)) {
        hpMultiplierNormal = 1;
        return 0;
      }
      if (!fail) return testDrop;
    }
  }

  // Taiko starts empty unless nothing can give health; the rest start full.
  let health =
    processor === "taiko" ? (perfect.some((o) => o.hp?.object === "hit" && increase(o, true) !== 0) ? 0 : 1) : 1;
  let failedAt: number | null = null;
  // `ModEasyWithExtraLives` (not taiko): refills the bar instead of failing.
  let lives = mode !== 1 && has("EZ") ? Number(setting("EZ", "retries") ?? 2) : 0;
  const noFail = has("NF");
  const points: HealthPoint[] = [{ time: drainStart, health }];
  const draining = (time: number) =>
    time > drainStart && time <= gameplayEnd && !noDrain.some(([a, b]) => time >= a && time <= b);
  /** Drains from `from` to `to`, recording the moment the bar empties. */
  const drainTo = (from: number, to: number) => {
    if (drainRate <= 0 || to <= from) return;
    // Integrate over the drained parts of [from, to].
    const cuts = [from, to, drainStart, gameplayEnd, ...noDrain.flat()].filter((t) => t >= from && t <= to);
    cuts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i],
        b = cuts[i + 1];
      if (b <= a || !draining((a + b) / 2)) continue;
      const next = health - drainRate * (b - a);
      if (next <= 0 && health > 0) {
        points.push({ time: a, health });
        points.push({ time: a + health / drainRate, health: 0 });
      }
      health = Math.max(0, next);
      points.push({ time: b, health });
    }
  };
  let last = drainStart;
  for (const [index, o] of outcomes.entries()) {
    const time = Math.max(o.time, last);
    drainTo(last, time);
    last = time;
    if (failedAt !== null) continue;
    const before = health;
    health = Math.min(1, Math.max(0, health + increase(o, false)));
    if (health !== before) {
      points.push({ time, health: before });
      points.push({ time, health });
    }
    // `HealthProcessor` fail conditions: an empty bar (not on bonus/ignored
    // results; never in taiko, which only checks at the end), Sudden Death and Perfect.
    const empty =
      processor !== "taiko" &&
      !isBonus(o.max) &&
      o.type !== "ignore_hit" &&
      !(processor === "catch" && o.type === "small_tick_miss") &&
      health < 1e-7;
    const comboBreak = ["miss", "large_tick_miss", "combo_break"].includes(o.type);
    const imperfect = !isBonus(o.max) && o.max !== "ignore_hit" && o.type !== o.max;
    if (empty || (has("SD") && comboBreak) || (has("PF") && (comboBreak || imperfect))) {
      if (noFail) continue;
      if (empty && lives > 0) {
        lives--;
        points.push({ time, health });
        health = 1;
        points.push({ time, health });
        continue;
      }
      failedAt = index;
    }
  }
  drainTo(last, Math.max(last, gameplayEnd));
  return { points, failedAt };
}
