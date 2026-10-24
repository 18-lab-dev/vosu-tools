/**
 * osu!taiko judgement simulation, following lazer (ppy/osu, MIT): hit windows
 * (`TaikoHitWindows`), presses offered to the earliest object first, wrong
 * colours missing the note, one press per object per frame
 * (`DrawableHit.OnPressed`), strong notes' second hit within 30 ms
 * (`StrongNestedHit`), drum roll ticks within half their spacing and swells
 * that need alternating hits (`DrawableSwell`). Drum rolls and swells are
 * bonus: they never touch combo or accuracy.
 *
 * osu!stable replays are judged the way stable counted them. These rules
 * were measured against the header counts of 415 real stable replays (stable's
 * source is not public), one rule at a time:
 * - the miss window includes its whole last millisecond, and a note stays
 *   open until it passes: a late press there misses the note instead of
 *   reaching the next one;
 * - notes take presses before drum roll ticks;
 * - in a frame that presses both colours, the colour that does not match the
 *   next note is applied first, and a press of the other colour in the same
 *   frame carries on to the following note;
 * - with ScoreV2, every drum roll and every completed swell also counts as a
 *   300 in the header.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import { convertToTaiko, legacyBeatmap, timingPointAt } from "@vosu-tools/ruleset-convert";
import type { Replay } from "./index";
import { replayMods, replayRate } from "./mods";
import { difficultyRange } from "./osu";
import { clientOf, lazerMultiplier, type HealthInfo, type HitResult, type Outcome, type Rules } from "./scoring";
import { realWindows, type Result, type Simulation } from "./simulation";
import { judgeWithHealth } from "./health";

/** `TaikoHitWindows` for an overall difficulty: great, ok and miss. */
export function taikoHitWindows(od: number): [number, number, number] {
  return [
    Math.floor(difficultyRange(od, 50, 35, 20)) - 0.5,
    Math.floor(difficultyRange(od, 120, 80, 50)) - 0.5,
    Math.floor(difficultyRange(od, 135, 95, 70)) - 0.5,
  ];
}

/** `DrawableHit.StrongNestedHit.SECOND_HIT_WINDOW`. */
const SECOND_HIT_WINDOW = 30;

/** Legacy taiko buttons (`TaikoReplayFrame.FromLegacy` order): rim, rim, centre, centre. */
const ACTIONS = [
  { bit: 2, rim: true },
  { bit: 8, rim: true },
  { bit: 1, rim: false },
  { bit: 4, rim: false },
] as const;
type Action = 0 | 1 | 2 | 3;
const isRim = (action: Action) => ACTIONS[action].rim;

interface Hit {
  kind: "hit";
  index: number;
  time: number;
  rim: boolean;
  strong: boolean;
  judged: boolean;
  hit: boolean;
  offset: number;
  /** The action that hit it, until released (a strong note's second hit needs it held). */
  action: Action | null;
  /** `lastPressHandleTime`: later presses in the same frame are swallowed. */
  lastPress: number;
  /** The colour of that press (osu!stable passes the other colour on). */
  lastRim: boolean;
  strongJudged: boolean;
}
interface Tick {
  time: number;
  judged: boolean;
}
interface DrumRoll {
  kind: "drumroll";
  index: number;
  time: number;
  end: number;
  strong: boolean;
  window: number;
  ticks: Tick[];
  judged: boolean;
}
interface Swell {
  kind: "swell";
  index: number;
  time: number;
  end: number;
  required: number;
  hits: number;
  judged: boolean;
  lastWasCentre: boolean | null;
  lastPress: number;
}
type TaikoHitObject = Hit | DrumRoll | Swell;

/**
 * Judges an osu!taiko replay on the taiko `map` (mods applied): with lazer's
 * rules, or osu!stable's for stable replays. For a converted map, `source` is
 * the osu! map it came from (`convertBeatmap`), so drum rolls keep the
 * lengths the conversion gave them.
 */
export function simulateTaiko(replay: Replay, map: Beatmap, options: { source?: Beatmap } = {}): Simulation {
  if (replay.mode !== 1 || map.mode !== 1) throw new Error("Not an osu!taiko replay on a taiko map");
  const mods = replayMods(replay);
  if (mods.some((m) => ["RX", "AT", "CN"].includes(m.acronym)))
    throw new Error("Relax and autoplay replays are not judged from input");
  const stable = clientOf(replay) === "stable";
  const scoreV2 = stable && mods.some((m) => m.acronym === "SV2");
  const legacy = legacyBeatmap(map);
  const [great, ok, lazerMiss] = taikoHitWindows(legacy.od);
  const miss = stable ? lazerMiss + 0.5 : lazerMiss;
  /** How late a note can still take a press: lazer misses it after the ok window. */
  const lateLimit = stable ? miss : ok;
  const hitsPerSecond = difficultyRange(legacy.od, 3, 5, 7.5) * Math.fround(1.65);

  const objects: TaikoHitObject[] = [];
  const perfect: Outcome[] = [],
    outcomes: Outcome[] = [];
  const outcome = (
    object: TaikoHitObject,
    time: number,
    type: HitResult,
    max: HitResult,
    hp: HealthInfo,
    offset: number | null = null,
    scale?: number,
  ): Outcome => ({
    time,
    note: object.index,
    type,
    max,
    count: max === "great" ? (({ great: "n300", ok: "n100", miss: "miss" }) as Record<string, Result>)[type] : null,
    offset,
    x: 0,
    y: 0,
    // osu!stable's combo: notes only.
    v1: { value: 0, multiplied: false, bonus: false, combo: max !== "great" ? "none" : type === "miss" ? "break" : "increase" },
    scale,
    hp,
  });
  const converted = options.source
    ? // Same objects in the same order as `map`, whose colours carry the replay's mods.
      convertToTaiko(legacyBeatmap(options.source)).objects.map((o, i) =>
        o.kind === "hit" ? { ...o, rim: !!((map.objects[i]?.sound ?? 0) & 10) } : o,
      )
    : convertToTaiko(legacy, { native: true }).objects;
  converted.forEach((o, index) => {
    if (o.kind === "hit") {
      const hit: Hit = {
        kind: "hit",
        index,
        time: o.time,
        rim: o.rim,
        strong: o.strong,
        judged: false,
        hit: false,
        offset: 0,
        action: null,
        lastPress: NaN,
        lastRim: false,
        strongJudged: !o.strong,
      };
      objects.push(hit);
      // lazer's autoplay order: nested objects, then the object itself.
      if (o.strong) perfect.push(outcome(hit, o.time, "large_bonus", "large_bonus", { object: "strong", end: o.time, top: false }, null, 7));
      perfect.push(outcome(hit, o.time, "great", "great", { object: "hit", end: o.time, top: true }));
    } else if (o.kind === "drumroll") {
      const spacing = timingPointAt(legacy.points, o.time).beatLength / (legacy.sliderTickRate === 3 ? 3 : 4);
      const ticks: Tick[] = [];
      if (spacing !== 0)
        for (let t = o.time; t < o.endTime + spacing / 2; t += spacing) ticks.push({ time: t, judged: false });
      const roll: DrumRoll = {
        kind: "drumroll",
        index,
        time: o.time,
        end: o.endTime,
        strong: o.strong,
        window: spacing / 2,
        ticks,
        judged: false,
      };
      objects.push(roll);
      for (const tick of ticks) {
        if (o.strong) perfect.push(outcome(roll, tick.time, "large_bonus", "large_bonus", { object: "strong", end: tick.time, top: false }, null, 3));
        perfect.push(outcome(roll, tick.time, "small_bonus", "small_bonus", { object: "drumroll_tick", end: tick.time, top: false }));
      }
    } else {
      const swell: Swell = {
        kind: "swell",
        index,
        time: o.time,
        end: o.endTime,
        required: Math.trunc(Math.max(1, ((o.endTime - o.time) / 1000) * hitsPerSecond)),
        hits: 0,
        judged: false,
        lastWasCentre: null,
        lastPress: NaN,
      };
      objects.push(swell);
      perfect.push(outcome(swell, o.endTime, "large_bonus", "large_bonus", { object: "swell", end: o.endTime, top: true }));
    }
  });

  const judgeHit = (hit: Hit, time: number, type: HitResult, offset: number) => {
    hit.judged = true;
    hit.hit = type !== "miss";
    hit.offset = offset;
    outcomes.push(outcome(hit, time, type, "great", { object: "hit", end: hit.time, top: true }, offset));
    if (hit.strong && !hit.hit) judgeStrong(hit, time, false);
  };
  const judgeStrong = (hit: Hit, time: number, ok: boolean) => {
    hit.strongJudged = true;
    outcomes.push(
      outcome(hit, time, ok ? "large_bonus" : "ignore_miss", "large_bonus", { object: "strong", end: hit.time, top: false }, null, 7),
    );
  };
  const judgeTick = (roll: DrumRoll, tick: Tick, time: number, ok: boolean) => {
    tick.judged = true;
    if (roll.strong)
      outcomes.push(
        outcome(roll, time, ok ? "large_bonus" : "ignore_miss", "large_bonus", { object: "strong", end: tick.time, top: false }, null, 3),
      );
    outcomes.push(
      outcome(roll, time, ok ? "small_bonus" : "ignore_miss", "small_bonus", { object: "drumroll_tick", end: tick.time, top: false }),
    );
  };
  const judgeSwell = (swell: Swell, time: number, ok: boolean) => {
    swell.judged = true;
    const judged = outcome(swell, time, ok ? "large_bonus" : "ignore_miss", "large_bonus", { object: "swell", end: swell.end, top: true });
    if (scoreV2 && ok) judged.count = "n300";
    outcomes.push(judged);
  };
  /** osu!stable's ScoreV2 counts each drum roll as a 300 once it ends. */
  const endDrumRoll = (roll: DrumRoll, time: number) => {
    roll.judged = true;
    if (!scoreV2) return;
    const counted = outcome(roll, time, "ignore_hit", "ignore_hit", { object: "drumroll", end: roll.end, top: false });
    counted.count = "n300";
    outcomes.push(counted);
  };
  /** osu!stable: a note open for this press takes it before any drum roll tick. */
  const noteTakes = (from: number, time: number) => {
    for (let i = from; i < objects.length; i++) {
      const o = objects[i];
      if (o.time - time > miss) return false;
      if (o.kind === "hit" && !o.judged && time - o.time <= lateLimit) return true;
    }
    return false;
  };

  /** Objects still able to take input or be judged, in start order. */
  let first = 0;
  const done = (o: TaikoHitObject) =>
    o.kind === "hit" ? o.judged && o.strongJudged : o.kind === "drumroll" ? o.judged && o.ticks.every((t) => t.judged) : o.judged;
  const press = (action: Action, time: number) => {
    for (let i = first; i < objects.length; i++) {
      const o = objects[i];
      if (o.time - time > Math.max(miss, o.kind === "drumroll" ? o.window : 0)) return;
      if (o.kind === "hit") {
        // The strong nested hit sees the press before its parent.
        if (!o.strongJudged && o.hit && o.action !== null && isRim(action) === o.rim) {
          if (Math.abs(time - o.time - o.offset) <= SECOND_HIT_WINDOW) {
            judgeStrong(o, time, true);
            return;
          }
        }
        if (o.lastPress === time && !(stable && o.lastRim !== isRim(action))) return;
        if (o.judged) continue;
        o.lastPress = time;
        o.lastRim = isRim(action);
        const offset = time - o.time;
        if (Math.abs(offset) > miss) continue;
        if (isRim(action) !== o.rim) judgeHit(o, time, "miss", offset);
        else {
          const error = Math.abs(offset);
          judgeHit(o, time, error <= great ? "great" : error <= ok ? "ok" : "miss", offset);
          if (o.hit) o.action = action;
        }
        return;
      }
      if (o.kind === "drumroll") {
        if (stable && noteTakes(i + 1, time)) continue;
        const tick = o.ticks.find((t) => !t.judged && Math.abs(time - t.time) <= o.window);
        if (tick) {
          judgeTick(o, tick, time, true);
          return;
        }
        continue;
      }
      if (time < o.time || o.judged) continue;
      const centre = !isRim(action);
      if (o.lastWasCentre === centre) continue;
      if (o.lastPress === time) return;
      o.lastWasCentre = centre;
      o.lastPress = time;
      if (o.hits < o.required) o.hits++;
      if (o.hits === o.required) judgeSwell(o, time, true);
      return;
    }
  };
  const release = (action: Action) => {
    for (let i = first; i < objects.length; i++) {
      const o = objects[i];
      if (o.kind === "hit" && o.action === action) o.action = null;
    }
  };
  const update = (time: number) => {
    for (let i = first; i < objects.length; i++) {
      const o = objects[i];
      if (o.time > time) break;
      if (o.kind === "hit") {
        if (!o.judged && time - o.time > lateLimit) judgeHit(o, time, "miss", time - o.time);
        if (!o.strongJudged && o.judged && time - o.time - o.offset > SECOND_HIT_WINDOW) judgeStrong(o, time, false);
      } else if (o.kind === "drumroll") {
        for (const tick of o.ticks) if (!tick.judged && time - tick.time > o.window) judgeTick(o, tick, time, false);
        if (!o.judged && time >= o.end) endDrumRoll(o, time);
      } else if (!o.judged && time >= o.end) judgeSwell(o, time, o.hits === o.required);
    }
    while (first < objects.length && done(objects[first])) first++;
  };

  let previous = 0;
  for (const frame of replay.frames) {
    // Live play updates far more often than frames are recorded: whatever
    // timed out before this frame's input was already judged.
    update(frame.time - 1e-6);
    for (let a = 0 as Action; a < 4; a++)
      if (previous & ACTIONS[a].bit && !(frame.keys & ACTIONS[a].bit)) release(a);
    const fresh: Action[] = [];
    for (let a = 0 as Action; a < 4; a++) if (frame.keys & ACTIONS[a].bit && !(previous & ACTIONS[a].bit)) fresh.push(a);
    if (stable && fresh.length > 1) {
      // osu!stable applies the colour that does not match the next note first.
      const next = objects.slice(first).find((o): o is Hit => o.kind === "hit" && !o.judged);
      if (next) fresh.sort((a, b) => Number(isRim(a) === next.rim) - Number(isRim(b) === next.rim));
    }
    for (const a of fresh) press(a, frame.time);
    previous = frame.keys;
    update(frame.time);
  }
  const unjudged = objects.filter((o) => o.kind === "hit" && !o.judged).length;
  const warnings = unjudged ? [`${unjudged} notes were never judged (replay ends early)`] : [];
  const rules: Rules = {
    mode: 1,
    client: stable ? "stable" : "lazer",
    v1Multiplier: null,
    lazerMultiplier: lazerMultiplier(1, mods, replay.version),
  };
  const order = outcomes.map((o, i) => ({ o, i })).sort((a, b) => a.o.time - b.o.time || a.i - b.i);
  const judged = order.map(({ o }) => o);
  const simulation = judgeWithHealth(replay, { mode: 1, map, mods, classic: false }, perfect, judged, rules, warnings);
  simulation.hitWindow = realWindows({ great, ok, miss }, replayRate(replay));
  return simulation;
}
