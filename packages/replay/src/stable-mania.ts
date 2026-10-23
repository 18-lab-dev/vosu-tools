/**
 * osu!mania judgement for osu!stable replays. stable's source is not public:
 * the windows follow the osu! wiki (osu!mania judgement, ScoreV2), and every
 * other rule was measured against the header counts of real stable replays,
 * one rule at a time (see the replay renderer's README for the numbers):
 *
 * - windows are whole real milliseconds (`64 - 3 × OD` and so on, converts use
 *   the fixed table), Hard Rock and Easy divide or multiply them by 1.4 before
 *   truncating, and rate mods leave them unchanged in real time;
 * - a press reaches the first open object in its column. It does nothing more
 *   than a miss window early, misses a note from the meh window outwards, and
 *   cannot reach a note before the previous object in the column has started
 *   (not with ScoreV2). A note is missed once the press would be an ok window
 *   late or later;
 * - a hold note is one judgement from the head error and head + tail error
 *   (1.2/2.4 × perfect, 1.1/2.2 × great, 2 × good and ok, else meh). A press
 *   more than a meh window early counts the whole hold as the head error;
 *   releasing before the tail's meh window drops the hold, a press later picks
 *   it up again with the new head error, capped at good; a hold never picked
 *   up again, or not pressed before its tail's ok window, is a miss;
 * - while a hold is held its combo rises every 100 map milliseconds from the
 *   press until its end, and dropping it breaks the combo;
 * - with ScoreV2 the perfect window is `difficultyRange(OD, 22.4, 19.4, 13.9)`,
 *   heads and tails are judged separately (tails with 1.5× windows, at most
 *   meh after a missed head or a dropped hold) and both count in the header.
 *
 * Replays keep whole map milliseconds, but with a rate mod stable judged at
 * fractional ones: judgements within half a map millisecond of a window edge
 * are settled with the replay's header counts.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import type { Replay } from "./index";
import { replayMods, replayRate } from "./mods";
import { difficultyRange } from "./osu";
import { judgeWithHealth } from "./health";
import type { HealthInfo, HitResult, Outcome, Rules } from "./scoring";
import type { Result, Simulation } from "./simulation";

/** Results best first, as header counters and as lazer results. */
const COUNTS: Result[] = ["geki", "n300", "katu", "n100", "n50", "miss"];
const RESULTS: HitResult[] = ["perfect", "great", "good", "ok", "meh", "miss"];
/** Hold notes: head and head + tail factors for perfect, great, good and ok. */
const HOLD_FACTORS = [
  [1.2, 2.4],
  [1.1, 2.2],
  [1, 2],
  [1, 2],
] as const;
/** ScoreV2's tail release leniency. */
const TAIL_LENIENCE = 1.5;
/** Map milliseconds between a held hold note's combo ticks. */
const COMBO_TICK = 100;

/**
 * osu!stable's mania windows in real milliseconds, best first: perfect, great,
 * good, ok, meh and miss.
 */
export function stableManiaWindows(
  od: number,
  options: { convert?: boolean; hardRock?: boolean; easy?: boolean; scoreV2?: boolean } = {},
): number[] {
  let base: number[];
  if (options.convert) {
    const easy = od <= 4;
    base = [16, easy ? 47 : 34, easy ? 77 : 67, 97, 121, 158];
  } else base = [16, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od, 188 - 3 * od];
  if (options.scoreV2 && !options.convert) base[0] = difficultyRange(od, 22.4, 19.4, 13.9);
  const scale = options.hardRock ? 1 / 1.4 : options.easy ? 1.4 : 1;
  return base.map((window) => Math.floor(window * scale));
}

interface Note {
  index: number;
  column: number;
  time: number;
  end: number;
  hold: boolean;
  judged: boolean;
  holding: boolean;
  /** Dropped before its tail: a hold picked up again is capped at good. */
  dropped: boolean;
  /** Real-millisecond head error of the press holding it. */
  headError: number;
  /** ScoreV2: the head's own judgement. */
  head: "open" | "hit" | "miss";
  /** The next combo tick while held (from the first press). */
  nextTick: number | null;
}
interface Judged extends Outcome {
  /** The result on the other side of a window edge the recorded time cannot place. */
  alternative?: number;
}

/** Judges an osu!stable mania replay on `map` (a mania map, converted if needed, with mods applied). */
export function simulateStableMania(replay: Replay, map: Beatmap, options: { convert?: boolean } = {}): Simulation {
  if (replay.mode !== 3 || map.mode !== 3) throw new Error("Not an osu!mania replay on a mania map");
  const mods = replayMods(replay),
    has = (acronym: string) => mods.some((m) => m.acronym === acronym);
  const scoreV2 = has("SV2");
  const columns = Math.max(1, Math.round(map.difficulty.cs));
  const rate = replayRate(replay);
  // `map` keeps the original OD: stable's Hard Rock and Easy scale the windows.
  const real = stableManiaWindows(map.difficulty.od, { convert: options.convert, hardRock: has("HR"), easy: has("EZ"), scoreV2 });
  const [okWindow, mehWindow, missWindow] = [real[3], real[4], real[5]].map((window) => window * rate);
  /** Map-millisecond offset to real-millisecond error. */
  const error = (offset: number) => Math.abs(offset) / rate;
  const resultIndex = (realError: number) => {
    const i = real.findIndex((window, i) => i < 5 && realError <= window);
    return i < 0 ? 5 : i;
  };
  const holdIndex = (head: number, total: number) => {
    const i = HOLD_FACTORS.findIndex(([h, t], i) => head <= real[i] * h && total <= real[i] * t);
    return i < 0 ? 4 : i;
  };

  const byColumn: Note[][] = Array.from({ length: columns }, () => []);
  const perfect: Outcome[] = [];
  const outcomes: Judged[] = [];
  const outcome = (note: Note, time: number, index: number, offset: number | null, part: "note" | "head" | "tail"): Judged => {
    const hp: HealthInfo =
      part === "note"
        ? { object: "note", end: note.end, top: true }
        : { object: part, end: part === "head" ? note.time : note.end, top: true, group: -(2 * note.index + (part === "head" ? 1 : 2)) };
    return {
      time,
      note: note.index,
      type: RESULTS[index],
      max: "perfect",
      count: COUNTS[index],
      offset,
      x: note.column,
      y: 0,
      v1: { value: 0, multiplied: false, bonus: false, combo: index === 5 ? "break" : "increase" },
      hp,
    };
  };
  map.objects.forEach((source, index) => {
    const column = Math.min(columns - 1, Math.max(0, Math.floor((source.x * columns) / 512)));
    const hold = !!(source.type & 128) && source.endTime > source.time;
    const note: Note = {
      index,
      column,
      time: source.time,
      end: hold ? source.endTime : source.time,
      hold,
      judged: false,
      holding: false,
      dropped: false,
      headError: 0,
      head: "open",
      nextTick: null,
    };
    byColumn[column].push(note);
    if (hold && scoreV2) {
      perfect.push(outcome(note, note.time, 0, null, "head"), outcome(note, note.end, 0, null, "tail"));
    } else perfect.push(outcome(note, note.end, 0, null, "note"));
  });
  perfect.sort((a, b) => a.time - b.time || a.x - b.x);

  const judge = (note: Note, time: number, index: number, offset: number | null, part: "note" | "head" | "tail" = "note") => {
    if (part !== "head") note.judged = true;
    const judged = outcome(note, time, index, offset, part);
    outcomes.push(judged);
    return judged;
  };
  /** A result whose edge lies within half a map millisecond of the recorded time. */
  const settleLater = (judged: Judged, index: number, alternatives: number[]) => {
    if (rate === 1) return;
    const other = alternatives.find((i) => i !== index && i !== 5);
    if (other !== undefined) judged.alternative = other;
  };
  const judgeHead = (note: Note, time: number) => {
    const offset = time - note.time;
    const index = offset >= okWindow ? 5 : offset < 0 && error(offset) > real[4] ? 5 : resultIndex(error(offset));
    note.head = index === 5 ? "miss" : "hit";
    const judged = judge(note, time, index, offset, note.hold ? "head" : "note");
    if (index !== 5) settleLater(judged, index, [-0.5, 0.5].map((d) => resultIndex(Math.max(0, Math.abs(offset) + d) / rate)));
  };

  /** A hold's combo tick, or the break of dropping it: combo only, no header count. */
  const comboStep = (note: Note, time: number, combo: "increase" | "break") =>
    outcomes.push({
      ...outcome(note, time, 0, null, "note"),
      type: combo === "increase" ? "ignore_hit" : "ignore_miss",
      count: null,
      v1: { value: 0, multiplied: false, bonus: false, combo },
      hp: undefined,
    });

  const first = new Array<number>(columns).fill(0);
  const press = (column: number, time: number) => {
    const list = byColumn[column];
    for (let i = first[column]; i < list.length; i++) {
      const note = list[i];
      if (note.judged) continue;
      if (note.time - time > missWindow) return;
      if (!note.hold && time - note.time >= okWindow) {
        judge(note, time, 5, time - note.time);
        continue;
      }
      if (!scoreV2 && i > 0 && time < list[i - 1].time) return;
      if (!note.hold) {
        judgeHead(note, time);
        return;
      }
      if (scoreV2) {
        if (time - note.end > okWindow * TAIL_LENIENCE) continue;
        note.holding = true;
        if (note.head === "open") judgeHead(note, time);
        else note.dropped = true;
        return;
      }
      if (time - note.end > okWindow) {
        judge(note, time, 5, null);
        continue;
      }
      note.headError = time < note.time - mehWindow ? (note.end - 1 - note.time) / rate : error(time - note.time);
      note.holding = true;
      note.nextTick ??= Math.max(time, note.time) + COMBO_TICK;
      return;
    }
  };
  const release = (column: number, time: number) => {
    const list = byColumn[column];
    for (let i = first[column]; i < list.length; i++) {
      const note = list[i];
      if (note.judged || !note.hold || !note.holding) {
        if (note.time > time) return;
        continue;
      }
      note.holding = false;
      const offset = time - note.end;
      if (scoreV2) {
        if (offset < -mehWindow * TAIL_LENIENCE) {
          note.dropped = true;
          return;
        }
        let index = offset > okWindow * TAIL_LENIENCE ? 5 : resultIndex(error(offset) / TAIL_LENIENCE);
        if ((note.dropped || note.head !== "hit") && index < 4) index = 4;
        judge(note, time, index, offset, "tail");
        return;
      }
      if (offset < -mehWindow) {
        note.dropped = true;
        comboStep(note, time, "break");
        return;
      }
      const head = note.headError,
        total = head + error(offset);
      const capped = (index: number) => (note.dropped && index < 2 ? 2 : index);
      const index = capped(holdIndex(head, total));
      const judged = judge(note, time, index, offset);
      if (!note.dropped) {
        const q = 0.5 / rate;
        const shifts = [
          [-q, -2 * q],
          [q, 2 * q],
          [0, q],
          [0, -q],
          [q, q],
          [-q, -q],
        ];
        settleLater(
          judged,
          index,
          shifts.map(([h, t]) => holdIndex(Math.max(0, head + h), Math.max(0, total + t))),
        );
      }
      return;
    }
  };
  const update = (time: number) => {
    for (let column = 0; column < columns; column++) {
      const list = byColumn[column];
      for (let i = first[column]; i < list.length; i++) {
        const note = list[i];
        if (note.time > time) break;
        if (note.judged) continue;
        if (!note.hold) {
          if (time - note.time >= okWindow) judge(note, time, 5, time - note.time);
        } else if (scoreV2) {
          if (note.head === "open" && time - note.time > okWindow) {
            note.head = "miss";
            judge(note, time, 5, null, "head");
          }
          if (time - note.end > okWindow * TAIL_LENIENCE) judge(note, time, 5, null, "tail");
        } else {
          if (note.holding && note.nextTick !== null)
            for (; note.nextTick <= Math.min(time, note.end); note.nextTick += COMBO_TICK) comboStep(note, note.nextTick, "increase");
          if (!note.holding && time - note.end > okWindow) judge(note, time, 5, null);
        }
      }
      while (first[column] < list.length && list[first[column]].judged) first[column]++;
    }
  };

  let previous = 0;
  for (const frame of replay.frames) {
    const keys = Math.trunc(frame.x);
    // Whatever timed out before this frame's input was already judged.
    update(frame.time - 1e-6);
    for (let c = 0; c < columns; c++) if (previous & (1 << c) && !(keys & (1 << c))) release(c, frame.time);
    for (let c = 0; c < columns; c++) if (keys & (1 << c) && !(previous & (1 << c))) press(c, frame.time);
    previous = keys;
    update(frame.time);
  }
  const unjudged = byColumn.flat().filter((note) => !note.judged).length;
  const warnings = unjudged ? [`${unjudged} notes were never judged (replay ends early)`] : [];

  // Settle edge cases toward the recorded header, one judgement at a time.
  const counted: Record<string, number> = {};
  for (const o of outcomes) if (o.count) counted[o.count] = (counted[o.count] ?? 0) + 1;
  for (const o of outcomes) {
    if (o.alternative === undefined) continue;
    const from = o.count!,
      to = COUNTS[o.alternative];
    if ((counted[from] ?? 0) > replay.counts[from] && (counted[to] ?? 0) < replay.counts[to]) {
      counted[from]--;
      counted[to] = (counted[to] ?? 0) + 1;
      o.type = RESULTS[o.alternative];
      o.count = to;
    }
  }
  const rules: Rules = { mode: 3, client: "stable", v1Multiplier: null, lazerMultiplier: 1 };
  const order = outcomes.map((o, i) => ({ o, i })).sort((a, b) => a.o.time - b.o.time || a.i - b.i);
  return judgeWithHealth(replay, { mode: 3, map, mods, classic: true }, perfect, order.map(({ o }) => o), rules, warnings);
}
