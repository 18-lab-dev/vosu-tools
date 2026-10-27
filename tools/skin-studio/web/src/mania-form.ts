// The Keymodes screen's form for a key count's whole `[Mania]` block,
// generated from skin-spec's wiki-revisioned schema: every [Mania] key gets
// a control, here or (once) elsewhere on the screen. Keys the schema gains
// later appear under "Other" with a control for their type.

import { spec, type Spec } from "@vosu-tools/skin-spec";

const MANIA = spec.filter((s) => s.section === "Mania");

/** [Mania] keys another part of the Keymodes screen edits (never shown twice). */
export const ELSEWHERE: Readonly<Record<string, string>> = {
  Keys: "key count list",
  ColumnWidth: "column grid: Width",
  ColumnLineWidth: "column grid: Line",
  "Colour#": "column grid: Colour",
  "ColourLight#": "column grid: Light",
  HitPosition: "Hit position",
};
const elsewhere = (s: Spec) => s.type === "image" || s.key in ELSEWHERE;

export type Control = "number" | "integer" | "switch" | "select" | "colour";
export interface Field {
  key: string;
  label: string;
  group: string;
  control: Control;
  /** Shown when the block leaves the key out. */
  fallback?: string;
  options?: { value: string; label: string }[];
  /** rgba: the colour has an alpha channel. */
  alpha?: boolean;
  /** One line, only where the name alone is ambiguous. */
  /** Hover tip, only where the label alone is ambiguous. */
  help?: string;
  min?: number;
  max?: number;
}
export interface ColumnField {
  /** The schema key: a comma list (`ColumnSpacing`) or a per-column key (`NoteBodyStyle#`). */
  key: string;
  label: string;
  control: Control;
  /** List entries per key count (gaps: keys − 1), or one key per column. */
  list: boolean;
  length(keys: number): number;
  fallback?: string;
  options?: { value: string; label: string }[];
  /** Hover tip, only where the label alone is ambiguous. */
  help?: string;
}

const GROUPS: Record<string, string> = {
  ColumnStart: "Stage",
  ColumnRight: "Stage",
  StageSeparation: "Stage",
  SplitStages: "Stage",
  SeparateScore: "Stage",
  SpecialStyle: "Stage",
  UpsideDown: "Stage",
  KeysUnderNotes: "Stage",
  JudgementLine: "Stage",
  BarlineHeight: "Stage",
  LightPosition: "Positions",
  ScorePosition: "Positions",
  ComboPosition: "Positions",
  ComboBurstStyle: "Positions",
  NoteBodyStyle: "Notes",
  WidthForNoteHeightScale: "Notes",
  KeyFlipWhenUpsideDown: "Notes",
  NoteFlipWhenUpsideDown: "Notes",
  LightFramePerSecond: "Lighting",
};
/** Readable names; the skin.ini key is the tooltip. */
const LABELS: Record<string, string> = {
  ColumnStart: "Stage left edge",
  ColumnRight: "Stage right limit",
  StageSeparation: "Stage separation",
  SplitStages: "Split stages",
  SeparateScore: "Separate score",
  SpecialStyle: "Special column",
  UpsideDown: "Upside down",
  KeysUnderNotes: "Keys under notes",
  JudgementLine: "Judgement line",
  BarlineHeight: "Bar line height",
  LightPosition: "Light position",
  ScorePosition: "Judgement position",
  ComboPosition: "Combo position",
  ComboBurstStyle: "Combo burst side",
  NoteBodyStyle: "Hold body style",
  WidthForNoteHeightScale: "Note height width",
  KeyFlipWhenUpsideDown: "Flip all keys",
  NoteFlipWhenUpsideDown: "Flip all notes",
  LightFramePerSecond: "Stage light frame rate",
  ColourColumnLine: "Column lines",
  ColourBarline: "Bar lines",
  ColourJudgementLine: "Judgement line",
  ColourKeyWarning: "Key reminders",
  ColourHold: "Hold combo",
  ColourBreak: "Break combo",
  ColumnSpacing: "Gap after",
  LightingNWidth: "Hit light width",
  LightingLWidth: "Hold light width",
  "NoteBodyStyle#": "Body style",
  "KeyFlipWhenUpsideDown#": "Key flip",
  "KeyFlipWhenUpsideDown#D": "Key flip (pressed)",
  "NoteFlipWhenUpsideDown#": "Note flip",
  "NoteFlipWhenUpsideDown#H": "Head flip",
  "NoteFlipWhenUpsideDown#L": "Body flip",
  "NoteFlipWhenUpsideDown#T": "Tail flip",
};
/**
 * A hover tip for names that are ambiguous on their own (osu! wiki's skin.ini
 * page; osu!lazer 2026.1005.0 for what it ignores).
 */
const HELP: Record<string, string> = {
  ColumnStart: "Where the stage's left edge is in osu!stable. osu!lazer centres the stage.",
  ColumnRight: "How far right columns may be drawn in osu!stable. osu!lazer centres the stage.",
  SpecialStyle:
    "osu!stable, even key counts above 4: the lane with the special style, left or right (outer or inner with two stages). osu!lazer ignores it.",
  WidthForNoteHeightScale: "Notes are as tall as they would be in a column this wide. Unset: the narrowest column's width.",
  ScorePosition: "Height of the hit judgements (300, miss, …) on the stage.",
  ColourKeyWarning: "Colour of the key binding reminders shown before a map starts.",
  KeyFlipWhenUpsideDown: "Flip every key image when the stage is upside down (upscroll).",
  NoteFlipWhenUpsideDown: "Flip every note image when the stage is upside down (upscroll).",
  "NoteBodyStyle#": "How this column's hold body fills its length: stretched, or repeated from the top or from the bottom.",
};
const OPTIONS: Record<string, string[]> = {
  SpecialStyle: ["None", "Left", "Right"],
  NoteBodyStyle: ["Stretch", "Repeat from top", "Repeat from bottom"],
  // Per column, in a cell a column wide; the row's tip says what they mean.
  "NoteBodyStyle#": ["Stretch", "Top", "Bottom"],
  // Its text spellings (Left/Right/Both) mean the same as 0/1/2.
  ComboBurstStyle: ["Left", "Right", "Both"],
};

const controlOf = (s: Spec): Control =>
  s.type === "rgb" || s.type === "rgba"
    ? "colour"
    : s.type === "enum" && s.enum?.length === 2 && s.enum[0] === "0" && s.enum[1] === "1"
      ? "switch"
      : s.type === "enum"
        ? "select"
        : s.type === "integer"
          ? "integer"
          : "number";
const options = (s: Spec) =>
  s.type === "enum" && controlOf(s) === "select"
    ? s.enum!
        .slice(0, OPTIONS[s.key]?.length ?? s.enum!.length)
        .map((value, i) => ({ value, label: OPTIONS[s.key]?.[i] ?? value }))
    : undefined;

/** Scalar fields, grouped (Stage, Positions, Notes, Lighting, Colours, Other). */
export const MANIA_FIELDS: readonly Field[] = MANIA.filter(
  (s) => !elsewhere(s) && !s.key.includes("#") && s.type !== "numbers",
).map((s) => ({
  key: s.key,
  label: LABELS[s.key] ?? s.key,
  group: controlOf(s) === "colour" ? "Colours" : (GROUPS[s.key] ?? "Other"),
  control: controlOf(s),
  fallback: s.default,
  options: options(s),
  alpha: s.type === "rgba",
  help: HELP[s.key],
  min: s.min,
  max: s.max,
}));

/** Per-column settings: comma lists and `#` keys, one input per column (gaps between them). */
export const MANIA_COLUMNS: readonly ColumnField[] = MANIA.filter(
  (s) => !elsewhere(s) && (s.key.includes("#") || s.type === "numbers"),
).map((s) => ({
  key: s.key,
  label: LABELS[s.key] ?? s.key,
  control: s.type === "numbers" ? "number" : controlOf(s),
  list: s.type === "numbers",
  length: (keys: number) => (s.type === "numbers" ? keys + (s.columns ?? 0) : keys),
  fallback: s.default,
  options: options(s),
  help: HELP[s.key],
}));

/** The concrete key of a per-column field for column `c` (`NoteBodyStyle3`, `KeyFlipWhenUpsideDown0D`). */
export const columnKey = (field: ColumnField, c: number) => field.key.replace("#", String(c));

/** [Mania] keys with no control on the Keymodes screen (should be none). */
export function uncovered(): string[] {
  const here = new Set([...MANIA_FIELDS.map((f) => f.key), ...MANIA_COLUMNS.map((f) => f.key)]);
  return MANIA.filter((s) => !elsewhere(s) && !here.has(s.key)).map((s) => s.key);
}

/**
 * A comma list with entry `index` set (null: back to the default): the
 * other entries keep their values, missing ones take `fill(i)` (the value
 * the client uses for them), so setting one column never shifts another.
 */
export function setListEntry(
  raw: string | undefined,
  length: number,
  index: number,
  value: string | null,
  fill: (i: number) => string,
): string {
  const parts = (raw ?? "").split(",").map((v) => v.trim());
  const out = Array.from({ length }, (_, i) => (parts[i] !== undefined && parts[i] !== "" ? parts[i] : fill(i)));
  out[index] = value ?? fill(index);
  return out.join(",");
}
