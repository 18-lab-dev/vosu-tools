/**
 * osu!mania judgement simulation, following lazer (ppy/osu, MIT): hit windows
 * (`ManiaHitWindows`, including the Classic mod's and rate/Easy/Hard Rock
 * multipliers), note lock per column (`OrderedHitPolicy`), and hold notes as a
 * head, a tail judged on release with 1.5× leniency (capped at meh after a
 * missed head or a broken hold) and a body that breaks combo when the hold is
 * dropped (`DrawableHoldNote`).
 */
import { maniaColumns, type Beatmap } from "@vosu-tools/osu-parse";
import type { Replay } from "./index";
import { isClassic, replayMods, replayRate } from "./mods";
import { difficultyRange } from "./osu";
import { lazerMultiplier, type HealthInfo, type HitResult, type Outcome, type Rules } from "./scoring";
import { realWindows, type Result, type Simulation } from "./simulation";
import { judgeWithHealth } from "./health";

/** The windows in order perfect, great, good, ok, meh, miss. */
export type ManiaWindows = [number, number, number, number, number, number];

/**
 * `ManiaHitWindows`: OD ranges, or with Classic stable's (converted maps use
 * fixed values), each scaled by rate and divided by the difficulty multiplier.
 */
export function maniaHitWindows(
  od: number,
  options: { rate?: number; difficulty?: number; classic?: boolean; scoreV2?: boolean; convert?: boolean } = {},
): ManiaWindows {
  const multiplier = (options.rate ?? 1) / (options.difficulty ?? 1);
  const at = (value: number) => Math.floor(value * multiplier) + 0.5;
  if (options.classic && !options.scoreV2) {
    if (options.convert) {
      const easy = Math.round(od) <= 4;
      return [at(16), at(easy ? 47 : 34), at(easy ? 77 : 67), at(97), at(121), at(158)];
    }
    const inverted = Math.min(10, Math.max(0, 10 - od));
    return [16, 34, 67, 97, 121, 158].map((base, i) => at(i === 0 ? base : base + 3 * inverted)) as ManiaWindows;
  }
  return [
    at(difficultyRange(od, 22.4, 19.4, 13.9)),
    at(difficultyRange(od, 64, 49, 34)),
    at(difficultyRange(od, 97, 82, 67)),
    at(difficultyRange(od, 127, 112, 97)),
    at(difficultyRange(od, 151, 136, 121)),
    at(difficultyRange(od, 188, 173, 158)),
  ];
}

/** `TailNote.RELEASE_WINDOW_LENIENCE`. */
const RELEASE_LENIENCE = 1.5;
const RESULTS: HitResult[] = ["perfect", "great", "good", "ok", "meh", "miss"];
const COUNT: Partial<Record<HitResult, Result>> = {
  perfect: "geki",
  great: "n300",
  good: "katu",
  ok: "n100",
  meh: "n50",
  miss: "miss",
};

interface Part {
  judged: boolean;
  hit: boolean;
}
interface Note {
  kind: "note";
  index: number;
  column: number;
  time: number;
  end: number;
  head: Part;
}
interface Hold {
  kind: "hold";
  index: number;
  column: number;
  time: number;
  end: number;
  head: Part;
  tail: Part;
  body: Part;
  /** Kept for physical releases after NoRelease auto-judges the tail. */
  tailOutcome?: Outcome;
  /** The hold's own (ignored) judgement. */
  self: Part;
  holding: boolean;
}
type ManiaHitObject = Note | Hold;

/**
 * Judges an osu!mania replay with lazer's rules on the mania `map` (mods
 * applied); `convert` when it was converted from an osu! map.
 */
export function simulateMania(replay: Replay, map: Beatmap, options: { convert?: boolean } = {}): Simulation {
  if (replay.mode !== 3 || map.mode !== 3) throw new Error("Not an osu!mania replay on a mania map");
  const mods = replayMods(replay),
    has = (a: string) => mods.some((m) => m.acronym === a);
  if (has("AT") || has("CN")) throw new Error("Autoplay replays are not judged from input");
  const columns = maniaColumns(map);
  const windows = maniaHitWindows(Math.fround(map.difficulty.od), {
    // Rate mods widen the windows in map time (`IManiaRateAdjustmentMod`).
    rate: replayRate(replay),
    difficulty: has("HR") ? 1.4 : has("EZ") ? 1 / 1.4 : 1,
    classic: isClassic(replay),
    scoreV2: has("SV2"),
    convert: options.convert,
  });
  const [, , , , meh, missWindow] = windows;
  const noRelease = has("NR");
  const resultFor = (offset: number): HitResult | null => {
    const error = Math.abs(offset);
    const i = windows.findIndex((window) => error <= window);
    return i < 0 ? null : RESULTS[i];
  };

  const objects: ManiaHitObject[] = [];
  const byColumn: ManiaHitObject[][] = Array.from({ length: columns }, () => []);
  // Keep physical inputs after timeout too: late key-up still counts as an excluded release.
  const heldInputs: Set<Hold>[] = Array.from({ length: columns }, () => new Set());
  const releases: { note: number; time: number; offset: number; outcome?: Outcome }[] = [];
  const perfect: (Outcome & { order: number })[] = [],
    outcomes: Outcome[] = [];
  const record = (
    o: ManiaHitObject,
    time: number,
    type: HitResult,
    max: HitResult,
    hp: HealthInfo,
    offset: number | null,
  ): Outcome => ({
    time,
    note: o.index,
    type,
    max,
    count: COUNT[max] ? (COUNT[type] ?? null) : null,
    offset,
    x: o.column,
    y: 0,
    v1: { value: 0, multiplied: false, bonus: false, combo: "none" },
    hp,
  });
  map.objects.forEach((source, index) => {
    const column = Math.min(columns - 1, Math.floor((source.x * columns) / 512));
    const part = (): Part => ({ judged: false, hit: false });
    const o: ManiaHitObject =
      source.type & 128 && source.endTime > source.time
        ? {
            kind: "hold",
            index,
            column,
            time: source.time,
            end: source.endTime,
            head: part(),
            tail: part(),
            body: part(),
            self: part(),
            holding: false,
          }
        : { kind: "note", index, column, time: source.time, end: source.time, head: part() };
    objects.push(o);
    byColumn[column].push(o);
    // lazer's autoplay order: nested then the object, ordered by end time,
    // notes before other objects, then column (`JudgementOrderComparer`).
    const add = (end: number, isNote: boolean, max: HitResult, hp: HealthInfo) =>
      perfect.push({ ...record(o, end, max, max, hp, null), order: isNote ? 0 : 1 });
    if (o.kind === "hold") {
      add(o.time, true, "perfect", { object: "head", end: o.time, top: false });
      add(o.end, true, "perfect", { object: "tail", end: o.end, top: false });
      add(o.end, false, "ignore_hit", { object: "body", end: o.end, top: false });
      add(o.end, false, "ignore_hit", { object: "hold", end: o.end, top: true });
    } else add(o.time, true, "perfect", { object: "note", end: o.time, top: true });
  });
  perfect.sort((a, b) => a.time - b.time || a.order - b.order || a.x - b.x);

  const judge = (o: ManiaHitObject, part: Part, which: "head" | "tail" | "body" | "self", time: number, type: HitResult, offset: number | null) => {
    part.judged = true;
    part.hit = type !== "miss" && type !== "combo_break" && type !== "ignore_miss";
    const hp: HealthInfo =
      which === "self"
        ? { object: "hold", end: o.end, top: true }
        : which === "body"
          ? { object: "body", end: o.end, top: false }
          : o.kind === "note"
            ? { object: "note", end: o.time, top: true }
            : { object: which, end: which === "head" ? o.time : o.end, top: false };
    const max: HitResult = which === "body" || which === "self" ? "ignore_hit" : "perfect";
    const outcome = record(o, time, type, max, hp, offset);
    outcomes.push(outcome);
    if (o.kind === "hold" && which === "tail") o.tailOutcome = outcome;
    if (part.hit && which !== "body" && which !== "self") handleHit(o, which === "tail" ? o.end : o.time, time);
    return outcome;
  };
  const missForcefully = (o: ManiaHitObject, time: number) => {
    if (o.kind === "note") {
      if (!o.head.judged) judge(o, o.head, "head", time, "miss", null);
      return;
    }
    if (!o.self.judged) judge(o, o.self, "self", time, "ignore_miss", null);
    o.holding = false;
    if (!o.head.judged) judge(o, o.head, "head", time, "miss", null);
    if (!o.body.judged) judge(o, o.body, "body", time, "combo_break", null);
    if (!o.tail.judged) judge(o, o.tail, "tail", time, "miss", null);
  };
  /** `OrderedHitPolicy.HandleHit`: a hit misses everything in its column that ended before it. */
  const handleHit = (hitObject: ManiaHitObject, start: number, time: number) => {
    for (const o of byColumn[hitObject.column]) {
      if (o === hitObject || o.end >= start) break;
      missForcefully(o, time);
    }
  };
  /** `OrderedHitPolicy.IsHittable`: until the next object in the column starts. */
  const hittable = (o: ManiaHitObject, time: number) => {
    const list = byColumn[o.column],
      next = list[list.indexOf(o) + 1];
    return !next || time < next.time;
  };
  const allJudged = (o: ManiaHitObject) =>
    o.kind === "note" ? o.head.judged : o.self.judged && o.head.judged && o.tail.judged && o.body.judged;

  const firstOpen = new Array<number>(columns).fill(0);
  const press = (column: number, time: number) => {
    const list = byColumn[column];
    for (let i = firstOpen[column]; i < list.length; i++) {
      const o = list[i];
      if (o.time - time > missWindow) return;
      if (allJudged(o) || !hittable(o, time)) continue;
      if (o.kind === "note") {
        if (o.head.judged) continue;
        const result = resultFor(time - o.time);
        if (!result) continue;
        judge(o, o.head, "head", time, result, time - o.time);
        return;
      }
      // A hold can no longer be grabbed once its tail cannot be hit.
      if (time > o.end && time - o.end > meh) continue;
      if (time - o.time >= -missWindow) {
        o.holding = true;
        heldInputs[column].add(o);
      }
      if (o.head.judged) continue;
      const result = resultFor(time - o.time);
      if (!result) continue;
      judge(o, o.head, "head", time, result, time - o.time);
      return;
    }
  };
  /**
   * Replays keep whole milliseconds, so a release recorded within half a
   * millisecond of a tail window edge (windows are 1.5× there, so edges fall
   * between milliseconds) may have landed on either side during play.
   */
  const ambiguous: { index: number; alternative: HitResult }[] = [];
  const capped = (o: Hold, result: HitResult): HitResult => {
    // `DrawableHoldNoteTail.GetCappedResult`.
    const broken = !o.head.hit || (o.body.judged && !o.body.hit);
    return broken && RESULTS.indexOf(result) < RESULTS.indexOf("meh") ? "meh" : result;
  };
  const release = (column: number, time: number) => {
    const samples = [...heldInputs[column]].map((o) => ({ note: o.index, time, offset: time - o.end, outcome: noRelease ? o.tailOutcome : undefined as Outcome | undefined }));
    releases.push(...samples);
    heldInputs[column].clear();
    const list = byColumn[column];
    for (let i = firstOpen[column]; i < list.length; i++) {
      const o = list[i];
      // Holds can be grabbed up to a miss window early.
      if (o.time - time > missWindow) return;
      if (o.kind !== "hold" || allJudged(o) || !o.holding) continue;
      if (!o.tail.judged) {
        const error = Math.abs(time - o.end);
        const result = resultFor(error / RELEASE_LENIENCE);
        if (result) {
          const early = resultFor((error - 0.5) / RELEASE_LENIENCE),
            late = resultFor((error + 0.5) / RELEASE_LENIENCE);
          const sides = [early, late].map((r) => (r ? capped(o, r) : null));
          const alternative = sides.find((r) => r !== null && r !== capped(o, result));
          if (alternative) ambiguous.push({ index: outcomes.length, alternative });
          const outcome = judge(o, o.tail, "tail", time, capped(o, result), time - o.end);
          const sample = samples.find((s) => s.note === o.index);
          if (sample) sample.outcome = outcome;
        }
      }
      if (!o.body.judged) judge(o, o.body, "body", time, o.tail.hit ? "ignore_hit" : "combo_break", null);
      o.holding = false;
    }
  };
  const update = (time: number) => {
    for (let column = 0; column < columns; column++) {
      const list = byColumn[column];
      for (let i = firstOpen[column]; i < list.length; i++) {
        const o = list[i];
        if (o.time > time) break;
        if (!o.head.judged && time - o.time > meh) judge(o, o.head, "head", time, "miss", time - o.time);
        if (o.kind === "hold") {
          // ManiaModNoRelease: holding through the end is a perfect tail.
          if (noRelease && !o.tail.judged && o.holding && time >= o.end)
            judge(o, o.tail, "tail", time, capped(o, "perfect"), time - o.end);
          if (!o.tail.judged && (time - o.end) / RELEASE_LENIENCE > meh)
            judge(o, o.tail, "tail", time, "miss", time - o.end);
          if (o.tail.judged && !o.self.judged) {
            judge(o, o.self, "self", time, o.tail.hit ? "ignore_hit" : "ignore_miss", null);
            if (!o.body.judged) judge(o, o.body, "body", time, o.tail.hit ? "ignore_hit" : "combo_break", null);
            o.holding = false;
          }
        }
      }
      while (firstOpen[column] < list.length && allJudged(list[firstOpen[column]])) firstOpen[column]++;
    }
  };

  let previous = 0;
  for (const frame of replay.frames) {
    const keys = Math.trunc(frame.x);
    // Live play updates far more often than frames are recorded: whatever
    // timed out before this frame's input was already judged.
    update(frame.time - 1e-6);
    // Releases reach the playfield before presses of the same frame.
    for (let c = 0; c < columns; c++) if (previous & (1 << c) && !(keys & (1 << c))) release(c, frame.time);
    for (let c = 0; c < columns; c++) if (keys & (1 << c) && !(previous & (1 << c))) press(c, frame.time);
    previous = keys;
    update(frame.time);
  }
  const unjudged = objects.filter((o) => !allJudged(o)).length;
  const warnings = unjudged ? [`${unjudged} notes were never judged (replay ends early)`] : [];
  const rules: Rules = {
    mode: 3,
    client: "lazer",
    v1Multiplier: null,
    lazerMultiplier: lazerMultiplier(3, mods, replay.version, replay.lazer?.clientVersion ?? ""),
  };
  // lazer's own statistics settle ambiguous tails, one side at a time.
  const stats = replay.lazer?.statistics;
  if (stats) {
    const counted: Record<string, number> = {};
    for (const o of outcomes) counted[o.type] = (counted[o.type] ?? 0) + 1;
    for (const { index, alternative } of ambiguous) {
      const o = outcomes[index];
      if ((stats[o.type] ?? 0) < counted[o.type] && (stats[alternative] ?? 0) > (counted[alternative] ?? 0)) {
        counted[o.type]--;
        counted[alternative] = (counted[alternative] ?? 0) + 1;
        o.type = alternative;
        o.count = COUNT[alternative] ?? null;
      }
    }
  }
  // Results land in judgement order (time, then the order they were applied).
  const order = outcomes.map((o, i) => ({ o, i })).sort((a, b) => a.o.time - b.o.time || a.i - b.i);
  const judged = order.map(({ o }) => o);
  const simulation = judgeWithHealth(replay, { mode: 3, map, mods, classic: false }, perfect, judged, rules, warnings);
  const [perfectWindow, great, good, ok] = windows;
  simulation.hitWindow = realWindows(
    { perfect: perfectWindow, great, good, ok, meh, miss: missWindow },
    replayRate(replay),
  );
  simulation.releases = releases.map(({ outcome, ...release }) => ({
    ...release, hit: !!outcome && outcome.type !== "miss" && outcome.type !== "combo_break" && outcome.type !== "ignore_miss", veryLate: false,
  }));
  return simulation;
}
