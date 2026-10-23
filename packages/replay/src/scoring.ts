import type { Beatmap } from "@vosu-tools/osu-parse";
import { roundHalfEven } from "@vosu-tools/ruleset-convert";
import type { Counts, Replay } from "./index";
import { FIRST_LAZER_VERSION } from "./index";
import { accuracy, type Judgement, type Result, type Simulation } from "./simulation";

/** lazer `HitResult`, by the names lazer stores in replays. */
export type HitResult =
  | "great"
  | "ok"
  | "meh"
  | "miss"
  | "large_tick_hit"
  | "large_tick_miss"
  | "small_tick_hit"
  | "small_tick_miss"
  | "slider_tail_hit"
  | "small_bonus"
  | "large_bonus"
  | "ignore_hit"
  | "ignore_miss";

/** One judgement as a ruleset simulator reports it. */
export interface Outcome {
  time: number;
  /** Index of the top-level object in `map.objects`. */
  note: number;
  type: HitResult;
  /** The judgement's best result (`Judgement.MaxResult`). */
  max: HitResult;
  /** The replay-header counter this result adds to, if any. */
  count: Result | null;
  /** Hit error in map milliseconds, for timed hits only. */
  offset: number | null;
  x: number;
  y: number;
  /**
   * osu!stable ScoreV1: points when hit, whether the combo bonus applies,
   * whether it is bonus score, and what it does to stable's combo.
   */
  v1: { value: number; multiplied: boolean; bonus: boolean; combo: "increase" | "break" | "none" };
}

export type Client = "stable" | "lazer";

/** lazer replays carry its rules; anything older was set on osu!stable. */
export const clientOf = (replay: Pick<Replay, "version">): Client =>
  replay.version >= FIRST_LAZER_VERSION ? "lazer" : "stable";

const AFFECTS_COMBO: Partial<Record<HitResult, true>> = {
  great: true,
  ok: true,
  meh: true,
  miss: true,
  large_tick_hit: true,
  large_tick_miss: true,
  slider_tail_hit: true,
};
const affectsCombo = (r: HitResult) => AFFECTS_COMBO[r] === true;
const isHit = (r: HitResult) =>
  r !== "miss" && r !== "large_tick_miss" && r !== "small_tick_miss" && r !== "ignore_miss";
const isBonus = (r: HitResult) => r === "small_bonus" || r === "large_bonus";
const isScorable = (r: HitResult) => r !== "ignore_hit" && r !== "ignore_miss";
const affectsAccuracy = (r: HitResult) => isScorable(r) && !isBonus(r);

/** `ScoreProcessor.GetBaseScoreForResult` (with catch's equal weighting). */
function baseScore(mode: number, r: HitResult): number {
  if (mode === 2) {
    if (r === "great" || r === "large_tick_hit" || r === "small_tick_hit") return 300;
    if (r === "large_bonus") return 200;
  }
  switch (r) {
    case "small_tick_hit":
    case "small_bonus":
      return 10;
    case "large_tick_hit":
      return 30;
    case "slider_tail_hit":
      return 150;
    case "meh":
    case "large_bonus":
      return 50;
    case "ok":
      return 100;
    case "great":
      return 300;
    default:
      return 0;
  }
}

/** `GetComboScoreChange`: catch caps a logarithmic combo bonus; others use √combo. */
function comboScore(mode: number, outcome: Outcome, comboAfter: number): number {
  if (mode !== 2) return baseScore(mode, outcome.max) * Math.sqrt(comboAfter);
  const base = outcome.type === "great" ? 300 : outcome.type === "large_tick_hit" ? 100 : 0;
  if (!base) return 0;
  const log4 = (n: number) => Math.log(n) / Math.log(4);
  return base * Math.min(Math.max(0.5, log4(comboAfter)), log4(200));
}

interface LazerTotals {
  maxComboPortion: number;
  maxAccuracyCount: number;
  /** catch: `fruitTinyScale` and the maximum tiny droplet count. */
  tinyScale: number;
  maxTiny: number;
}

function lazerTotals(mode: number, perfect: readonly Outcome[]): LazerTotals {
  let combo = 0,
    portion = 0,
    accuracyCount = 0,
    tiny = 0,
    great = 0;
  for (const o of perfect) {
    if (affectsCombo(o.max)) combo++;
    if (affectsAccuracy(o.max)) accuracyCount++;
    if (!isBonus(o.max) && isScorable(o.max))
      portion += comboScore(mode, { ...o, type: o.max }, combo);
    if (o.max === "small_tick_hit") tiny++;
    if (o.max === "great") great++;
  }
  return {
    maxComboPortion: portion,
    maxAccuracyCount: accuracyCount,
    tinyScale: tiny + great ? tiny / (tiny + great) : 0,
    maxTiny: tiny,
  };
}

/** `ComputeTotalScore` for osu! and catch. */
function lazerTotal(
  mode: number,
  totals: LazerTotals,
  state: { comboPortion: number; accuracyCount: number; accuracy: number; bonus: number; tiny: number },
): number {
  const comboProgress = totals.maxComboPortion > 0 ? state.comboPortion / totals.maxComboPortion : 1;
  if (mode === 2) {
    const dropletsPortion = 400000 * totals.tinyScale;
    return (
      (1000000 - dropletsPortion) * comboProgress +
      dropletsPortion * (totals.maxTiny ? state.tiny / totals.maxTiny : 0) +
      state.bonus
    );
  }
  const accuracyProgress =
    totals.maxAccuracyCount > 0 ? state.accuracyCount / totals.maxAccuracyCount : 1;
  return (
    500000 * state.accuracy * comboProgress +
    500000 * state.accuracy ** 5 * accuracyProgress +
    state.bonus
  );
}

type LazerMod = { acronym: string; settings?: Record<string, unknown> };
const LEGACY_MODS: [number, string][] = [
  [1, "NF"],
  [2, "EZ"],
  [4, "TD"],
  [8, "HD"],
  [16, "HR"],
  [32, "SD"],
  [512, "NC"],
  [64, "DT"],
  [128, "RX"],
  [256, "HT"],
  [1024, "FL"],
  [4096, "SO"],
  [8192, "AP"],
  [1 << 29, "SV2"],
];
/** The replay's mods: lazer's own list (with settings) when stored, else the legacy bits. */
export function replayMods(replay: Pick<Replay, "mods" | "lazer">): LazerMod[] {
  if (replay.lazer) return replay.lazer.mods;
  const mods: LazerMod[] = [];
  for (const [bit, acronym] of LEGACY_MODS)
    if (replay.mods & bit && !(acronym === "DT" && replay.mods & 512)) mods.push({ acronym });
  return mods;
}

const customised = (mod: LazerMod) => !!mod.settings && Object.keys(mod.settings).length > 0;
/** `rateAdjustMultiplier` (catch, osu! V1): steps of 0.1x speed. */
const rateV1 = (speed: number) => {
  const value = Math.trunc(speed * 10) / 10 - 1;
  return speed >= 1 ? 1 + value / 5 : 0.6 + value;
};
const speedOf = (mod: LazerMod) =>
  Number(mod.settings?.speed_change ?? (mod.acronym === "DT" || mod.acronym === "NC" ? 1.5 : 0.75));

/** Gameplay rate: lazer's own speed setting when stored, else the legacy DT/HT rate. */
export function replayRate(replay: Pick<Replay, "rate" | "lazer">): number {
  const mod = replay.lazer?.mods.find((m) => ["DT", "NC", "HT", "DC"].includes(m.acronym));
  const speed = mod ? speedOf(mod) : replay.rate;
  return Number.isFinite(speed) && speed > 0 ? speed : replay.rate;
}

/**
 * lazer's score multiplier (`Osu/CatchScoreMultiplierCalculator`, default mod
 * settings): osu! uses its V2 table from score version 30000017 onwards.
 */
export function lazerMultiplier(mode: number, mods: readonly LazerMod[], version: number): number {
  let multiplier = 1;
  const has = (a: string) => mods.some((m) => m.acronym === a);
  for (const mod of mods) {
    const a = mod.acronym;
    if (mode === 2) {
      if (a === "EZ" || a === "NF" || a === "DA") multiplier *= 0.5;
      else if (["HT", "DC", "DT", "NC"].includes(a)) multiplier *= rateV1(speedOf(mod));
      else if (a === "HR" || a === "FL") multiplier *= customised(mod) ? 1 : 1.12;
      else if (a === "HD") multiplier *= customised(mod) ? 1 : 1.06;
      else if (a === "CL") multiplier *= version < 30000017 ? 0.96 : 1;
      else if (a === "RX") multiplier *= 0.1;
    } else if (version < 30000017) {
      if (a === "EZ" || a === "NF" || a === "DA") multiplier *= 0.5;
      else if (["HT", "DC", "DT", "NC"].includes(a)) multiplier *= rateV1(speedOf(mod));
      else if (a === "HR" || a === "HD") multiplier *= customised(mod) ? 1 : 1.06;
      else if (a === "FL") multiplier *= customised(mod) ? 1 : 1.12;
      else if (a === "CL") multiplier *= 0.96;
      else if (a === "RX" || a === "AP") multiplier *= 0.1;
      else if (a === "SO") multiplier *= 0.9;
    } else {
      if (a === "EZ") multiplier *= 0.8;
      else if (a === "NF") multiplier *= 0.5;
      else if (a === "HT" || a === "DC")
        multiplier *= (Math.trunc(speedOf(mod) * 20) / 20) * 1.4 - 0.5;
      else if (a === "DT" || a === "NC") {
        const value = Math.trunc(speedOf(mod) * 10) / 10;
        multiplier *= (value - 1) * 0.46 + 1 - (value !== 1.5 && value !== 1 ? 0.01 : 0);
      } else if (a === "HR") multiplier *= 1.09;
      else if (a === "HD")
        multiplier *= 1.04 - (mod.settings?.only_fade_approach_circles ? 0.02 : 0);
      else if (a === "FL") multiplier *= customised(mod) ? 1.04 : 1.2;
      else if (a === "CL") multiplier *= mod.settings?.classic_note_lock === false ? 0.96 : 0.985;
      else if (a === "RX" || a === "AP") multiplier *= 0.1;
      else if (a === "SO") multiplier *= 0.95;
    }
  }
  return has("AT") || has("CN") ? 0 : multiplier;
}

/** osu!stable's ScoreV1 mod multiplier (`GetLegacyScoreMultiplier`). */
export function legacyMultiplier(mode: number, mods: readonly LazerMod[]): number {
  let multiplier = 1;
  for (const { acronym: a } of mods) {
    if (a === "NF" || a === "EZ") multiplier *= 0.5;
    else if (a === "HT" || a === "DC") multiplier *= 0.3;
    else if (a === "HD") multiplier *= 1.06;
    else if (a === "HR") multiplier *= mode === 2 ? 1.12 : 1.06;
    else if (a === "DT" || a === "NC") multiplier *= mode === 2 ? 1.06 : 1.12;
    else if (a === "FL") multiplier *= 1.12;
    else if (a === "SO") multiplier *= 0.9;
    else if (a === "RX" || a === "AP") return 0;
  }
  return multiplier;
}

/**
 * `CalculateDifficultyPeppyStars`: stable's difficulty multiplier, from the
 * unmodded difficulty, the object count and the drain time in whole seconds.
 */
export function peppyStars(map: Pick<Beatmap, "objects" | "breaks">, base: Beatmap["difficulty"]): number {
  const objects = map.objects;
  let drain = 0;
  if (objects.length) {
    const breaks = map.breaks.reduce(
      (sum, [start, end]) => sum + roundHalfEven(end) - roundHalfEven(start),
      0,
    );
    drain = Math.trunc(
      (roundHalfEven(objects[objects.length - 1].time) - roundHalfEven(objects[0].time) - breaks) / 1000,
    );
  }
  const ratio = drain ? Math.min(16, Math.max(0, (objects.length / drain) * 8)) : 16;
  const f = Math.fround;
  return roundHalfEven(((f(base.hp) + f(base.od) + f(base.cs) + ratio) / 38) * 5);
}

export interface Rules {
  mode: 0 | 2;
  client: Client;
  /** Combo-bonus multiplier for ScoreV1: difficulty × mods; `null` when stable's score is not ScoreV1. */
  v1Multiplier: number | null;
  lazerMultiplier: number;
}

export interface Tally {
  events: Judgement[];
  counts: Counts;
  statistics: Record<string, number>;
  maximumStatistics: Record<string, number>;
  maxCombo: number;
  score: number | null;
  scoreWithoutMods: number | null;
}

/**
 * Plays `outcomes` (in judgement order) through the client's combo, accuracy
 * and score rules. `perfect` is lazer's autoplay order, for its maxima.
 */
export function tally(outcomes: readonly Outcome[], perfect: readonly Outcome[], rules: Rules): Tally {
  const { mode, client } = rules;
  const counts: Counts = { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 };
  const statistics: Record<string, number> = {},
    maximumStatistics: Record<string, number> = {};
  for (const o of perfect) maximumStatistics[o.max] = (maximumStatistics[o.max] ?? 0) + 1;
  const totals = lazerTotals(mode, perfect);
  const lazer = { comboPortion: 0, accuracyCount: 0, accuracy: 1, bonus: 0, tiny: 0 };
  let base = 0,
    maxBase = 0,
    combo = 0,
    maxCombo = 0,
    v1Score = 0,
    total = 0,
    withoutMods = 0;
  const events: Judgement[] = [];
  for (const o of outcomes) {
    statistics[o.type] = (statistics[o.type] ?? 0) + 1;
    if (o.count) counts[o.count]++;
    // Combo: lazer's result semantics, or stable's own rules.
    const before = combo;
    if (client === "lazer") {
      if (affectsCombo(o.type)) combo = isHit(o.type) ? combo + 1 : 0;
    } else if (o.v1.combo === "increase") combo++;
    else if (o.v1.combo === "break") combo = 0;
    maxCombo = Math.max(maxCombo, combo);
    // lazer's standardised score.
    if (affectsAccuracy(o.max)) {
      maxBase += baseScore(mode, o.max);
      lazer.accuracyCount++;
    }
    if (affectsAccuracy(o.type)) base += baseScore(mode, o.type);
    if (isBonus(o.type)) lazer.bonus += baseScore(mode, o.type);
    else if (isScorable(o.type)) lazer.comboPortion += comboScore(mode, o, combo);
    if (o.type === "small_tick_hit") lazer.tiny++;
    lazer.accuracy = maxBase > 0 ? base / maxBase : 1;
    // stable's ScoreV1.
    if (rules.v1Multiplier !== null && isHit(o.type) && o.type !== "ignore_hit") {
      v1Score += o.v1.value;
      if (o.v1.multiplied && !o.v1.bonus)
        v1Score += Math.trunc(Math.max(0, before - 1) * (Math.trunc(o.v1.value / 25) * rules.v1Multiplier));
    }
    if (client === "lazer") {
      withoutMods = Math.round(lazerTotal(mode, totals, lazer));
      total = Math.round(withoutMods * rules.lazerMultiplier);
    } else total = v1Score;
    if (o.type === "ignore_hit" || o.type === "ignore_miss") continue;
    events.push({
      time: o.time,
      note: o.note,
      result: o.count,
      offset: o.offset ?? 0,
      timed: o.offset !== null,
      kind: o.type,
      x: o.x,
      y: o.y,
      combo,
      counts: { ...counts },
      accuracy: client === "lazer" ? lazer.accuracy : accuracy(mode, counts),
      score: total,
    });
  }
  return {
    events,
    counts,
    statistics,
    maximumStatistics,
    maxCombo,
    score: client === "lazer" || rules.v1Multiplier !== null ? total : null,
    scoreWithoutMods: client === "lazer" ? withoutMods : null,
  };
}

/** Header counters each ruleset grades (stable's geki/katu in osu! are section bonuses). */
const GRADED: Record<0 | 2, Result[]> = {
  0: ["n300", "n100", "n50", "miss"],
  2: ["n300", "n100", "n50", "katu", "miss"],
};
/** lazer statistics that change accuracy, combo or score. */
const COMPARED: HitResult[] = [
  "great",
  "ok",
  "meh",
  "miss",
  "large_tick_hit",
  "large_tick_miss",
  "small_tick_hit",
  "small_tick_miss",
  "slider_tail_hit",
  "small_bonus",
  "large_bonus",
];

/** Compares a tally with what the replay recorded. */
export function verify(replay: Replay, tallied: Tally, rules: Rules, warnings: string[]): Simulation {
  const differences: Simulation["differences"] = {};
  for (const key of GRADED[rules.mode])
    if (tallied.counts[key] !== replay.counts[key])
      differences[key] = { expected: replay.counts[key], actual: tallied.counts[key] };
  const info = replay.lazer;
  if (info && rules.client === "lazer") {
    for (const key of COMPARED) {
      const expected = info.statistics[key] ?? 0,
        actual = tallied.statistics[key] ?? 0;
      if (expected !== actual) differences[key] = { expected, actual };
    }
    for (const key of COMPARED) {
      const expected = info.maximumStatistics[key] ?? 0,
        actual = tallied.maximumStatistics[key] ?? 0;
      if (expected !== actual) differences[`maximum ${key}`] = { expected, actual };
    }
  }
  const verified = !Object.keys(differences).length;
  const scoreMatches =
    tallied.score === replay.score &&
    (!info || info.totalScoreWithoutMods === null || tallied.scoreWithoutMods === info.totalScoreWithoutMods);
  if (verified && tallied.score === null) warnings.push("Score: stable ScoreV2 is not simulated");
  else if (verified && !scoreMatches)
    warnings.push(`Score: simulated ${tallied.score} vs recorded ${replay.score}`);
  if (verified && tallied.maxCombo !== replay.maxCombo)
    warnings.push(`Combo: simulated max ${tallied.maxCombo} vs recorded ${replay.maxCombo}`);
  return {
    events: tallied.events,
    counts: tallied.counts,
    verified,
    comboVerified: verified && tallied.maxCombo === replay.maxCombo,
    scoreVerified: verified && scoreMatches,
    differences,
    warnings,
    client: rules.client,
    statistics: tallied.statistics,
  };
}
