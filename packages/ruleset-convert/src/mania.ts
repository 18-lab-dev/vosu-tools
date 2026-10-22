import type { Mod } from "@vosu-tools/osu-parse";
import {
  effectAt,
  f32,
  precisionAdjustedBeatLength,
  roundHalfEven,
  Sound,
  timingPointAt,
  type LegacyBeatmap,
  type LegacyObject,
} from "./legacy";
import { LegacyRandom } from "./random";

/**
 * osu! → osu!mania conversion, ported from osu!lazer's `ManiaBeatmapConverter`
 * and its legacy pattern generators (ppy/osu 2026.1005.0-lazer, MIT).
 * Integer casts, float/double boundaries and the order of random draws are
 * kept exactly, because every later pattern depends on them.
 */

export interface ManiaNote {
  time: number;
  /** Equal to `time` for notes; the release time for holds. */
  endTime: number;
  column: number;
  hold: boolean;
}

export interface ManiaConversion {
  /** Columns per stage. */
  columns: number;
  /** 1, or 2 with Dual Stages. */
  stages: number;
  notes: ManiaNote[];
}

/** lazer's `ManiaRuleset.MAX_STAGE_KEYS`. */
const maxStageKeys = 10;
const maxNotesForDensity = 7;

enum PatternType {
  None = 0,
  ForceStack = 1,
  ForceNotStack = 1 << 1,
  KeepSingle = 1 << 2,
  LowProbability = 1 << 3,
  Alternate = 1 << 4,
  ForceSigSlider = 1 << 5,
  ForceNotSlider = 1 << 6,
  Gathered = 1 << 7,
  Mirror = 1 << 8,
  Reverse = 1 << 9,
  Cycle = 1 << 10,
  Stair = 1 << 11,
  ReverseStair = 1 << 12,
}

class Pattern {
  readonly notes: ManiaNote[] = [];
  private readonly columns = new Set<number>();
  hasColumn(column: number): boolean {
    return this.columns.has(column);
  }
  get columnsWithObjects(): number {
    return this.columns.size;
  }
  add(note: ManiaNote): void {
    this.notes.push(note);
    this.columns.add(note.column);
  }
  addAll(other: Pattern): void {
    for (const note of other.notes) this.add(note);
  }
  clear(): void {
    this.notes.length = 0;
    this.columns.clear();
  }
}

export class NotEnoughColumnsError extends Error {
  constructor() {
    super("There were not enough columns to complete conversion.");
  }
}

/** The key-count mods lazer applies to converts ("1K" … "10K"). */
function keyMod(mods: readonly Mod[]): number | undefined {
  for (const mod of mods) {
    const match = /^(10|[1-9])K$/i.exec(mod.acronym);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * `ManiaBeatmapConverter.GetColumnCount` for an osu! map: the automatic key
 * count from CS, OD and the share of sliders/spinners, then key-count mods and
 * Dual Stages.
 */
export function maniaLayout(
  map: LegacyBeatmap,
  mods: readonly Mod[] = [],
): { columns: number; stages: number } {
  const roundedCircleSize = roundHalfEven(map.cs),
    roundedOverallDifficulty = roundHalfEven(map.od);
  let columns: number;
  const total = map.objects.length,
    special = map.objects.filter(
      (o) => o.kind === "slider" || o.kind === "spinner" || o.kind === "hold",
    ).length;
  automatic: {
    if (total > 0) {
      const percentSpecialObjects = special / total;
      if (percentSpecialObjects < 0.2) {
        columns = 7;
        break automatic;
      }
      if (percentSpecialObjects < 0.3 || roundedCircleSize >= 5) {
        columns = roundedOverallDifficulty > 5 ? 7 : 6;
        break automatic;
      }
      if (percentSpecialObjects > 0.6) {
        columns = roundedOverallDifficulty > 4 ? 5 : 4;
        break automatic;
      }
    }
    columns = Math.max(4, Math.min(roundedOverallDifficulty + 1, 7));
  }
  columns = keyMod(mods) ?? columns;
  const dual = mods.some((mod) => mod.acronym.toUpperCase() === "DS");
  return { columns, stages: dual ? 2 : 1 };
}

/** `LegacyPatternGenerator.ConversionDifficulty`. */
function conversionDifficulty(map: LegacyBeatmap): number {
  const objects = map.objects,
    first = objects[0]?.time ?? 0,
    last = objects[objects.length - 1]?.time ?? 0;
  let drainTime = Math.trunc((last - first - map.totalBreakTime) / 1000);
  if (drainTime === 0) drainTime = 10000;
  const value =
    (((f32(map.hp + Math.min(7, Math.max(4, map.ar))) / 1.5 +
      (objects.length / drainTime) * 9) /
      38) *
      5) /
    1.15;
  return Math.min(value, 12);
}

const has = (sound: number, flag: number): boolean => (sound & flag) !== 0;

interface Context {
  random: LegacyRandom;
  map: LegacyBeatmap;
  totalColumns: number;
  difficulty: number;
}

abstract class Generator {
  protected readonly randomStart: number;
  constructor(
    protected readonly ctx: Context,
    protected readonly object: LegacyObject,
    protected readonly previous: Pattern,
  ) {
    this.randomStart = ctx.totalColumns === 8 ? 1 : 0;
  }
  protected get total(): number {
    return this.ctx.totalColumns;
  }
  protected get random(): LegacyRandom {
    return this.ctx.random;
  }
  abstract generate(): Pattern[];

  protected getColumn(position: number, allowSpecial = false): number {
    if (allowSpecial && this.total === 8)
      return (
        Math.min(6, Math.max(0, Math.floor(f32(position / f32(512 / 7))))) + 1
      );
    const divisor = f32(512 / this.total);
    return Math.min(
      this.total - 1,
      Math.max(0, Math.floor(f32(position / divisor))),
    );
  }

  protected getRandomNoteCount(p2: number, p3: number, p4 = 0, p5 = 0, p6 = 0) {
    for (const p of [p2, p3, p4, p5, p6])
      if (p < 0 || p > 1) throw new RangeError("note count probability");
    const value = this.random.nextDouble();
    if (value >= 1 - p6) return 6;
    if (value >= 1 - p5) return 5;
    if (value >= 1 - p4) return 4;
    if (value >= 1 - p3) return 3;
    return value >= 1 - p2 ? 2 : 1;
  }

  protected getRandomColumn(lower?: number, upper?: number): number {
    return this.random.nextInRange(
      lower ?? this.randomStart,
      upper ?? this.total,
    );
  }

  protected findAvailableColumn(
    initial: number,
    options: {
      lower?: number;
      upper?: number;
      next?: (column: number) => number;
      validation?: (column: number) => boolean;
      patterns?: readonly Pattern[];
    } = {},
  ): number {
    const lower = options.lower ?? this.randomStart,
      upper = options.upper ?? this.total,
      next = options.next ?? (() => this.getRandomColumn(lower, upper)),
      patterns = options.patterns ?? [];
    const isValid = (column: number) =>
      options.validation?.(column) !== false &&
      !patterns.some((p) => p.hasColumn(column));
    if (isValid(initial)) return initial;
    let hasValid = false;
    for (let i = lower; i < upper && !hasValid; i++) hasValid = isValid(i);
    if (!hasValid) throw new NotEnoughColumnsError();
    do initial = next(initial);
    while (!isValid(initial));
    return initial;
  }
}

class CircleGenerator extends Generator {
  stairType: PatternType;
  private convertType = PatternType.None;

  constructor(
    ctx: Context,
    object: LegacyObject,
    previous: Pattern,
    previousTime: number,
    previousPosition: { x: number; y: number },
    density: number,
    lastStair: PatternType,
  ) {
    super(ctx, object, previous);
    this.stairType = lastStair;
    const beatLength = timingPointAt(ctx.map.points, object.time).beatLength,
      kiai = effectAt(ctx.map.points, object.time).kiai;
    const dx = f32(object.x - previousPosition.x),
      dy = f32(object.y - previousPosition.y),
      positionSeparation = f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
    const timeSeparation = object.time - previousTime;
    let t = PatternType.None;
    if (timeSeparation <= 80)
      t |= PatternType.ForceNotStack | PatternType.KeepSingle;
    else if (timeSeparation <= 95)
      t |= PatternType.ForceNotStack | PatternType.KeepSingle | lastStair;
    else if (timeSeparation <= 105)
      t |= PatternType.ForceNotStack | PatternType.LowProbability;
    else if (timeSeparation <= 125) t |= PatternType.ForceNotStack;
    else if (timeSeparation <= 135 && positionSeparation < 20)
      t |= PatternType.Cycle | PatternType.KeepSingle;
    else if (timeSeparation <= 150 && positionSeparation < 20)
      t |= PatternType.ForceStack | PatternType.LowProbability;
    else if (positionSeparation < 20 && density >= beatLength / 2.5)
      t |= PatternType.Reverse | PatternType.LowProbability;
    else if (density < beatLength / 2.5 || kiai) {
      // Default pattern.
    } else t |= PatternType.LowProbability;
    if (!(t & PatternType.KeepSingle)) {
      if (has(object.sound, Sound.finish) && this.total !== 8)
        t |= PatternType.Mirror;
      else if (has(object.sound, Sound.clap)) t |= PatternType.Gathered;
    }
    this.convertType = t;
  }

  generate(): Pattern[] {
    const p = this.generateCore();
    for (const note of p.notes) {
      if (
        this.convertType & PatternType.Stair &&
        note.column === this.total - 1
      )
        this.stairType = PatternType.ReverseStair;
      if (
        this.convertType & PatternType.ReverseStair &&
        note.column === this.randomStart
      )
        this.stairType = PatternType.Stair;
    }
    return [p];
  }

  private generateCore(): Pattern {
    const pattern = new Pattern(),
      type = this.convertType,
      total = this.total,
      start = this.randomStart,
      previous = this.previous;
    if (total === 1) {
      this.add(pattern, 0);
      return pattern;
    }
    const lastColumn = previous.notes[0]?.column ?? 0;
    if (type & PatternType.Reverse && previous.notes.length) {
      for (let i = start; i < total; i++)
        if (previous.hasColumn(i)) this.add(pattern, start + total - i - 1);
      return pattern;
    }
    if (
      type & PatternType.Cycle &&
      previous.notes.length === 1 &&
      (total !== 8 || lastColumn !== 0) &&
      (total % 2 === 0 || lastColumn !== Math.trunc(total / 2))
    ) {
      this.add(pattern, start + total - lastColumn - 1);
      return pattern;
    }
    if (type & PatternType.ForceStack && previous.notes.length) {
      for (let i = start; i < total; i++)
        if (previous.hasColumn(i)) this.add(pattern, i);
      return pattern;
    }
    if (previous.notes.length === 1) {
      if (type & PatternType.Stair) {
        let target = lastColumn + 1;
        if (target === total) target = start;
        this.add(pattern, target);
        return pattern;
      }
      if (type & PatternType.ReverseStair) {
        let target = lastColumn - 1;
        if (target === start - 1) target = total - 1;
        this.add(pattern, target);
        return pattern;
      }
    }
    if (type & PatternType.KeepSingle) return this.randomNotes(1);
    const difficulty = this.ctx.difficulty,
      low = !!(type & PatternType.LowProbability);
    if (type & PatternType.Mirror) {
      if (difficulty > 6.5) return this.randomPatternMirrored(0.12, 0.38, 0.12);
      if (difficulty > 4) return this.randomPatternMirrored(0.12, 0.17, 0);
      return this.randomPatternMirrored(0.12, 0, 0);
    }
    if (difficulty > 6.5)
      return low
        ? this.randomPattern(0.78, 0.42, 0, 0)
        : this.randomPattern(1, 0.62, 0, 0);
    if (difficulty > 4)
      return low
        ? this.randomPattern(0.35, 0.08, 0, 0)
        : this.randomPattern(0.52, 0.15, 0, 0);
    if (difficulty > 2)
      return low
        ? this.randomPattern(0.18, 0, 0, 0)
        : this.randomPattern(0.45, 0, 0, 0);
    return this.randomPattern(0, 0, 0, 0);
  }

  private randomNotes(noteCount: number): Pattern {
    const pattern = new Pattern(),
      allowStacking = !(this.convertType & PatternType.ForceNotStack);
    if (!allowStacking)
      noteCount = Math.min(
        noteCount,
        this.total - this.randomStart - this.previous.columnsWithObjects,
      );
    let nextColumn = this.getColumn(this.object.x, true);
    const next = (last: number): number => {
      if (this.convertType & PatternType.Gathered) {
        last++;
        if (last === this.total) last = this.randomStart;
        return last;
      }
      return this.getRandomColumn();
    };
    for (let i = 0; i < noteCount; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, {
        next,
        patterns: allowStacking ? [pattern] : [pattern, this.previous],
      });
      this.add(pattern, nextColumn);
    }
    return pattern;
  }

  private get hasSpecialColumn(): boolean {
    return (
      has(this.object.sound, Sound.clap) && has(this.object.sound, Sound.finish)
    );
  }

  private randomPattern(p2: number, p3: number, p4: number, p5: number) {
    const pattern = new Pattern();
    pattern.addAll(this.randomNotes(this.randomNoteCount(p2, p3, p4, p5)));
    if (this.randomStart > 0 && this.hasSpecialColumn) this.add(pattern, 0);
    return pattern;
  }

  private randomPatternMirrored(centre: number, p2: number, p3: number) {
    if (this.convertType & PatternType.ForceNotStack)
      return this.randomPattern(0.5 + p2 / 2, p2, (p2 + p3) / 2, p3);
    const pattern = new Pattern(),
      total = this.total;
    const { noteCount, addToCentre } = this.randomNoteCountMirrored(
      centre,
      p2,
      p3,
    );
    const columnLimit = Math.trunc((total % 2 === 0 ? total : total - 1) / 2);
    let nextColumn = this.getRandomColumn(undefined, columnLimit);
    for (let i = 0; i < noteCount; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, {
        upper: columnLimit,
        patterns: [pattern],
      });
      this.add(pattern, nextColumn);
      this.add(pattern, this.randomStart + total - nextColumn - 1);
    }
    if (addToCentre) this.add(pattern, Math.trunc(total / 2));
    if (this.randomStart > 0 && this.hasSpecialColumn) this.add(pattern, 0);
    return pattern;
  }

  private randomNoteCount(p2: number, p3: number, p4: number, p5: number) {
    switch (this.total) {
      case 2:
        p2 = p3 = p4 = p5 = 0;
        break;
      case 3:
        p2 = Math.min(p2, 0.1);
        p3 = p4 = p5 = 0;
        break;
      case 4:
        p2 = Math.min(p2, 0.23);
        p3 = Math.min(p3, 0.04);
        p4 = p5 = 0;
        break;
      case 5:
        p3 = Math.min(p3, 0.15);
        p4 = Math.min(p4, 0.03);
        p5 = 0;
        break;
    }
    if (has(this.object.sound, Sound.clap)) p2 = 1;
    return this.getRandomNoteCount(p2, p3, p4, p5);
  }

  private randomNoteCountMirrored(centre: number, p2: number, p3: number) {
    switch (this.total) {
      case 2:
        centre = p2 = p3 = 0;
        break;
      case 3:
        centre = Math.min(centre, 0.03);
        p2 = p3 = 0;
        break;
      case 4:
        centre = 0;
        p2 = 1 - Math.max((1 - p2) * 2, 0.8);
        p3 = 0;
        break;
      case 5:
        centre = Math.min(centre, 0.03);
        p3 = 0;
        break;
      case 6:
        centre = 0;
        p2 = 1 - Math.max((1 - p2) * 2, 0.5);
        p3 = 1 - Math.max((1 - p3) * 2, 0.85);
        break;
    }
    p2 = Math.min(1, Math.max(0, p2));
    p3 = Math.min(1, Math.max(0, p3));
    const centreValue = this.random.nextDouble();
    const noteCount = this.getRandomNoteCount(p2, p3);
    return {
      noteCount,
      addToCentre:
        this.total % 2 !== 0 && noteCount !== 3 && centreValue > 1 - centre,
    };
  }

  private add(pattern: Pattern, column: number): void {
    pattern.add({
      time: this.object.time,
      endTime: this.object.time,
      column,
      hold: false,
    });
  }
}

class SliderGenerator extends Generator {
  readonly startTime: number;
  readonly endTime: number;
  readonly segmentDuration: number;
  readonly spanCount: number;
  private convertType: PatternType;

  constructor(ctx: Context, object: LegacyObject, previous: Pattern) {
    super(ctx, object, previous);
    this.convertType = effectAt(ctx.map.points, object.time).kiai
      ? PatternType.None
      : PatternType.LowProbability;
    const beatLength = precisionAdjustedBeatLength(
      object.sliderVelocity,
      timingPointAt(ctx.map.points, object.time).beatLength,
      "mania",
    );
    this.spanCount = object.spans;
    this.startTime = roundHalfEven(object.time);
    const distance = object.expectedDistance ?? 0;
    this.endTime = Math.floor(
      this.startTime +
        (distance * beatLength * this.spanCount * 0.01) /
          ctx.map.sliderMultiplier,
    );
    this.segmentDuration = Math.trunc(
      (this.endTime - this.startTime) / this.spanCount,
    );
  }

  generate(): Pattern[] {
    const original = this.generateCore();
    if (original.notes.length === 1) return [original];
    const intermediate = new Pattern(),
      ends = new Pattern();
    for (const note of original.notes)
      (this.endTime !== roundHalfEven(note.endTime) ? intermediate : ends).add(
        note,
      );
    return [intermediate, ends];
  }

  private generateCore(): Pattern {
    const total = this.total,
      difficulty = this.ctx.difficulty;
    if (total === 1) {
      const pattern = new Pattern();
      this.add(pattern, 0, this.startTime, this.endTime);
      return pattern;
    }
    if (this.spanCount > 1) {
      if (this.segmentDuration <= 90)
        return this.randomHoldNotes(this.startTime, 1);
      if (this.segmentDuration <= 120) {
        this.convertType |= PatternType.ForceNotStack;
        return this.randomNotes(this.startTime, this.spanCount + 1);
      }
      if (this.segmentDuration <= 160) return this.stair(this.startTime);
      if (this.segmentDuration <= 200 && difficulty > 3)
        return this.randomMultipleNotes(this.startTime);
      const duration = this.endTime - this.startTime;
      if (duration >= 4000)
        return this.nRandomNotes(this.startTime, 0.23, 0, 0);
      if (
        this.segmentDuration > 400 &&
        this.spanCount < total - 1 - this.randomStart
      )
        return this.tiledHoldNotes(this.startTime);
      return this.holdAndNormalNotes(this.startTime);
    }
    if (this.segmentDuration <= 110) {
      if (this.previous.columnsWithObjects < total)
        this.convertType |= PatternType.ForceNotStack;
      else this.convertType &= ~PatternType.ForceNotStack;
      return this.randomNotes(
        this.startTime,
        this.segmentDuration < 80 ? 1 : 2,
      );
    }
    const low = !!(this.convertType & PatternType.LowProbability);
    if (difficulty > 6.5)
      return low
        ? this.nRandomNotes(this.startTime, 0.78, 0.3, 0)
        : this.nRandomNotes(this.startTime, 0.85, 0.36, 0.03);
    if (difficulty > 4)
      return low
        ? this.nRandomNotes(this.startTime, 0.43, 0.08, 0)
        : this.nRandomNotes(this.startTime, 0.56, 0.18, 0);
    if (difficulty > 2.5)
      return low
        ? this.nRandomNotes(this.startTime, 0.3, 0, 0)
        : this.nRandomNotes(this.startTime, 0.37, 0.08, 0);
    return low
      ? this.nRandomNotes(this.startTime, 0.17, 0, 0)
      : this.nRandomNotes(this.startTime, 0.27, 0, 0);
  }

  private randomHoldNotes(startTime: number, noteCount: number): Pattern {
    const pattern = new Pattern(),
      usableColumns =
        this.total - this.randomStart - this.previous.columnsWithObjects;
    let nextColumn = this.getRandomColumn();
    for (let i = 0; i < Math.min(usableColumns, noteCount); i++) {
      nextColumn = this.findAvailableColumn(nextColumn, {
        patterns: [pattern, this.previous],
      });
      this.add(pattern, nextColumn, startTime, this.endTime);
    }
    for (let i = 0; i < noteCount - usableColumns; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, {
        patterns: [pattern],
      });
      this.add(pattern, nextColumn, startTime, this.endTime);
    }
    return pattern;
  }

  private randomNotes(startTime: number, noteCount: number): Pattern {
    const pattern = new Pattern();
    let nextColumn = this.getColumn(this.object.x, true);
    if (
      this.convertType & PatternType.ForceNotStack &&
      this.previous.columnsWithObjects < this.total
    )
      nextColumn = this.findAvailableColumn(nextColumn, {
        patterns: [this.previous],
      });
    let lastColumn = nextColumn;
    for (let i = 0; i < noteCount; i++) {
      this.add(pattern, nextColumn, startTime, startTime);
      nextColumn = this.findAvailableColumn(nextColumn, {
        validation: (c) => c !== lastColumn,
      });
      lastColumn = nextColumn;
      startTime += this.segmentDuration;
    }
    return pattern;
  }

  private stair(startTime: number): Pattern {
    const pattern = new Pattern();
    let column = this.getColumn(this.object.x, true),
      increasing = this.random.nextDouble() > 0.5;
    for (let i = 0; i <= this.spanCount; i++) {
      this.add(pattern, column, startTime, startTime);
      startTime += this.segmentDuration;
      if (increasing) {
        if (column >= this.total - 1) {
          increasing = false;
          column--;
        } else column++;
      } else if (column <= this.randomStart) {
        increasing = true;
        column++;
      } else column--;
    }
    return pattern;
  }

  private randomMultipleNotes(startTime: number): Pattern {
    const pattern = new Pattern(),
      total = this.total,
      legacy = total >= 4 && total <= 8,
      interval = this.random.nextInRange(1, total - (legacy ? 1 : 0));
    let nextColumn = this.getColumn(this.object.x, true);
    for (let i = 0; i <= this.spanCount; i++) {
      this.add(pattern, nextColumn, startTime, startTime);
      nextColumn += interval;
      if (nextColumn >= total - this.randomStart)
        nextColumn = nextColumn - total - this.randomStart + (legacy ? 1 : 0);
      nextColumn += this.randomStart;
      if (total > 2) this.add(pattern, nextColumn, startTime, startTime);
      nextColumn = this.getRandomColumn();
      startTime += this.segmentDuration;
    }
    return pattern;
  }

  private nRandomNotes(startTime: number, p2: number, p3: number, p4: number) {
    switch (this.total) {
      case 2:
        p2 = p3 = p4 = 0;
        break;
      case 3:
        p2 = Math.min(p2, 0.1);
        p3 = p4 = 0;
        break;
      case 4:
        p2 = Math.min(p2, 0.3);
        p3 = Math.min(p3, 0.04);
        p4 = 0;
        break;
      case 5:
        p2 = Math.min(p2, 0.34);
        p3 = Math.min(p3, 0.1);
        p4 = Math.min(p4, 0.03);
        break;
    }
    const isDouble = (sound: number) =>
      has(sound, Sound.clap) || has(sound, Sound.finish);
    const canGenerateTwoNotes =
      !(this.convertType & PatternType.LowProbability) &&
      (isDouble(this.object.sound) || isDouble(this.soundAt(this.startTime)));
    if (canGenerateTwoNotes) p2 = 1;
    return this.randomHoldNotes(startTime, this.getRandomNoteCount(p2, p3, p4));
  }

  private tiledHoldNotes(startTime: number): Pattern {
    const pattern = new Pattern(),
      columnRepeat = Math.min(this.spanCount, this.total),
      endTime = startTime + this.segmentDuration * this.spanCount;
    let nextColumn = this.getColumn(this.object.x, true);
    if (
      this.convertType & PatternType.ForceNotStack &&
      this.previous.columnsWithObjects < this.total
    )
      nextColumn = this.findAvailableColumn(nextColumn, {
        patterns: [this.previous],
      });
    for (let i = 0; i < columnRepeat; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, {
        patterns: [pattern],
      });
      this.add(pattern, nextColumn, startTime, endTime);
      startTime += this.segmentDuration;
    }
    return pattern;
  }

  private holdAndNormalNotes(startTime: number): Pattern {
    const pattern = new Pattern(),
      total = this.total,
      difficulty = this.ctx.difficulty;
    let holdColumn = this.getColumn(this.object.x, true);
    if (
      this.convertType & PatternType.ForceNotStack &&
      this.previous.columnsWithObjects < total
    )
      holdColumn = this.findAvailableColumn(holdColumn, {
        patterns: [this.previous],
      });
    this.add(pattern, holdColumn, startTime, this.endTime);
    let nextColumn = this.getRandomColumn();
    let noteCount: number;
    if (difficulty > 6.5) noteCount = this.getRandomNoteCount(0.63, 0);
    else if (difficulty > 4)
      noteCount = this.getRandomNoteCount(total < 6 ? 0.12 : 0.45, 0);
    else if (difficulty > 2.5)
      noteCount = this.getRandomNoteCount(total < 6 ? 0 : 0.24, 0);
    else noteCount = 0;
    noteCount = Math.min(total - 1, noteCount);
    const ignoreHead = !(
      this.soundAt(startTime) &
      (Sound.whistle | Sound.finish | Sound.clap)
    );
    const row = new Pattern();
    for (let i = 0; i <= this.spanCount; i++) {
      if (!(ignoreHead && startTime === this.startTime))
        for (let j = 0; j < noteCount; j++) {
          nextColumn = this.findAvailableColumn(nextColumn, {
            validation: (c) => c !== holdColumn,
            patterns: [row],
          });
          this.add(row, nextColumn, startTime, startTime);
        }
      pattern.addAll(row);
      row.clear();
      startTime += this.segmentDuration;
    }
    return pattern;
  }

  /** The node sound at `time` (`sampleInfoListAt`). */
  private soundAt(time: number): number {
    const index =
      this.segmentDuration === 0
        ? 0
        : Math.trunc((time - this.startTime) / this.segmentDuration);
    const sound = this.object.nodeSounds[index];
    if (sound === undefined)
      throw new RangeError("slider node index outside its node samples");
    return sound;
  }

  private add(
    pattern: Pattern,
    column: number,
    startTime: number,
    endTime: number,
  ): void {
    pattern.add({
      time: startTime,
      endTime,
      column,
      hold: startTime !== endTime,
    });
  }
}

class SpinnerGenerator extends Generator {
  private readonly endTime: number;
  private readonly forceNotStack: boolean;

  constructor(ctx: Context, object: LegacyObject, previous: Pattern) {
    super(ctx, object, previous);
    this.endTime = Math.trunc(object.endTime);
    this.forceNotStack = previous.columnsWithObjects !== this.total;
  }

  generate(): Pattern[] {
    const pattern = new Pattern(),
      hold = this.endTime - this.object.time >= 100;
    let column: number;
    if (
      this.total === 8 &&
      has(this.object.sound, Sound.finish) &&
      this.endTime - this.object.time < 1000
    )
      column = 0;
    else if (this.total === 8) column = this.randomColumn();
    else column = this.randomColumn(0);
    pattern.add({
      time: this.object.time,
      endTime: hold ? this.endTime : this.object.time,
      column,
      hold,
    });
    return [pattern];
  }

  private randomColumn(lower?: number): number {
    return this.findAvailableColumn(this.getRandomColumn(lower), {
      lower,
      patterns: this.forceNotStack ? [this.previous] : [],
    });
  }
}

/** `ManiaBeatmapConverter` for an osu!-ruleset beatmap. */
export function convertToMania(
  map: LegacyBeatmap,
  mods: readonly Mod[] = [],
): ManiaConversion {
  const { columns, stages } = maniaLayout(map, mods);
  const seed =
    roundHalfEven(f32(map.hp + map.cs)) * 20 +
    Math.trunc(map.od * 41.2) +
    roundHalfEven(map.ar);
  const ctx: Context = {
    random: new LegacyRandom(seed),
    map,
    totalColumns: columns * stages,
    difficulty: conversionDifficulty(map),
  };
  let lastPattern = new Pattern(),
    lastTime = 0,
    lastPosition = { x: 0, y: 0 },
    lastStair = PatternType.Stair,
    density = 2147483647;
  const recent: number[] = [];
  const computeDensity = (time: number) => {
    recent.push(time);
    if (recent.length > maxNotesForDensity) recent.shift();
    if (recent.length >= 2)
      density = (recent[recent.length - 1] - recent[0]) / recent.length;
  };
  const record = (time: number, position: { x: number; y: number }) => {
    lastTime = time;
    lastPosition = position;
  };
  const notes: ManiaNote[] = [];
  for (const object of map.objects) {
    const position = { x: object.x, y: object.y };
    let generator: Generator;
    switch (object.kind) {
      case "circle":
        computeDensity(object.time);
        generator = new CircleGenerator(
          ctx,
          object,
          lastPattern,
          lastTime,
          lastPosition,
          density,
          lastStair,
        );
        record(object.time, position);
        break;
      case "slider": {
        const slider = new SliderGenerator(ctx, object, lastPattern);
        generator = slider;
        for (let i = 0; i <= slider.spanCount; i++) {
          const time = object.time + slider.segmentDuration * i;
          record(time, position);
          computeDensity(time);
        }
        break;
      }
      case "spinner":
        generator = new SpinnerGenerator(ctx, object, lastPattern);
        record(object.endTime, { x: 256, y: 192 });
        computeDensity(object.endTime);
        break;
      case "hold":
        throw new Error("osu! beatmaps cannot contain mania hold notes");
    }
    for (const pattern of generator.generate()) {
      if (generator instanceof CircleGenerator) lastStair = generator.stairType;
      if (
        generator instanceof CircleGenerator ||
        generator instanceof SliderGenerator
      )
        lastPattern = pattern;
      notes.push(...pattern.notes);
    }
  }
  // lazer orders converted objects by start time, keeping generation order on ties.
  notes.sort((a, b) => a.time - b.time);
  return { columns, stages, notes };
}
