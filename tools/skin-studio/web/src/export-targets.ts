// Export targets of the Mix panel: osu! stable folder, lazer .osk, and the
// mix's osu!mania stages converted for Quaver or Etterna. This module
// resolves every [Mania] lookup of a composed plan the way lazer does
// (render-core) into the stages the service converts; the mapping itself
// (sizes, names, sprite sheets, config files) is the service's
// (src/export/, EXPORT.md).

import {
  fallbackColumnIndex,
  maniaConfig,
  maniaImageKeys,
  resolveManiaImages,
  type ManiaConfig,
  type Rgba,
} from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { maniaBlocks, parseIni } from "./ini";
import { frameNames, hasImage, imageIndex } from "./mania";
import type { Plan } from "./plan";

export type ExportTarget = "stable" | "osk" | "quaver" | "etterna";
export type ConvertTarget = "quaver" | "etterna";

export const TARGETS: readonly {
  id: ExportTarget;
  label: string;
  button: string;
}[] = [
  { id: "stable", label: "osu! stable folder", button: "Create stable skin" },
  { id: "osk", label: "osu!lazer .osk", button: "Download .osk" },
  { id: "quaver", label: "Quaver", button: "Download Quaver skin" },
  { id: "etterna", label: "Etterna", button: "Download Etterna noteskins" },
];
export const isTarget = (value: string): value is ExportTarget =>
  TARGETS.some((t) => t.id === value);

/**
 * The game each key count loads as in Etterna (NotesLoaderOSU.cpp maps
 * osu!mania 3K–10K; 1K and 2K load as nothing).
 */
export const ETTERNA_GAMES: Readonly<Record<number, string>> = {
  3: "dance",
  4: "dance",
  5: "pump",
  6: "solo",
  7: "kb7",
  8: "dance double",
  9: "popn",
  10: "pump double",
};
/** Whether a target game can play `keys` columns. */
export function supports(target: ConvertTarget, keys: number): boolean {
  return target === "quaver" ? keys >= 1 && keys <= 10 : keys in ETTERNA_GAMES;
}

/**
 * The mix's osu!mania key counts: every `[Mania]` block's `Keys`, or
 * lazer's default 4K and 7K stages when it has none.
 */
export function mixKeyCounts(ini: string): number[] {
  const counts = [...maniaBlocks(parseIni(ini)).keys()]
    .filter((k) => k >= 1 && k <= 18)
    .sort((a, b) => a - b);
  return counts.length ? counts : [4, 7];
}

const list = (keys: readonly number[]) =>
  keys.map((k) => `${k}K`).join(", ");

/** What a target exports and skips, for the line under the choice. */
export function targetNote(target: ExportTarget, keys: readonly number[]) {
  if (target === "stable")
    return "A new skin in the stable Skins folder; replacing one asks first.";
  if (target === "osk") return "One file lazer imports; nothing is written here.";
  const exported = keys.filter((k) => supports(target, k));
  const skipped = keys.filter((k) => !supports(target, k));
  const parts = [
    exported.length
      ? `${list(exported)} mania only`
      : "No key count this game plays",
  ];
  if (skipped.length)
    parts.push(
      `skips ${list(skipped)} (${target === "quaver" ? "Quaver plays 1K–10K" : "Etterna loads 3K–10K"})`,
    );
  parts.push(
    target === "quaver"
      ? "one lane width per key count; judgements shared"
      : "a noteskin per key count at Etterna's column spacing; judgements as an asset",
  );
  return parts.join(" · ");
}

/** One frame file of an image: a path the plan produces, `@2x` or not. */
export interface ExportFrame {
  path: string;
  hd: boolean;
}
/** What a lookup draws: the mix's frames, osu!'s built-in look, or nothing (`null`). */
export type Drawn = { frames: ExportFrame[] } | { builtin: true } | null;
export interface ExportColumn {
  width: number;
  spacing: number;
  kind: "1" | "2" | "S";
  key: Drawn;
  keyDown: Drawn;
  note: Drawn;
  head: Drawn;
  tail: Drawn;
  body: Drawn;
  colour: number[];
  light: number[];
  explosionScale: number;
  holdLightScale: number;
}
/** One stage in lazer units (the stage is 768 tall), as the service reads it. */
export interface ExportStage {
  keys: number;
  hitPosition: number;
  lightPosition: number;
  scorePosition: number;
  noteHeightWidth: number;
  noteBodyStyle: number;
  keysUnderNotes: boolean;
  judgementLine: number[] | null;
  barline: number[];
  columns: ExportColumn[];
  stageLeft: Drawn;
  stageRight: Drawn;
  hint: Drawn;
  stageLight: Drawn;
  lightingN: Drawn;
  lightingL: Drawn;
  judgements: Record<
    "perfect" | "great" | "good" | "ok" | "meh" | "miss",
    Drawn
  >;
}

const WHITE: Rgba = [1, 1, 1, 1];
const BLACK: Rgba = [0, 0, 0, 1];
/** render-core's `disallowZeroAlpha` (LegacyColourCompatibility). */
const opaque = (c: Rgba): Rgba => (c[3] === 0 ? [c[0], c[1], c[2], 1] : c);
/** render-core's `doubledAlpha` for column backgrounds. */
const doubled = (c: Rgba): Rgba => [c[0], c[1], c[2], c[3] * c[3]];
const bytes = (c: Rgba) => c.map((v) => Math.round(v * 255));

/** Output paths of a plan (what the mix skin contains). */
export const planFiles = (plan: Plan): string[] => [
  ...plan.sources.flatMap((s) =>
    s.files.map((f) => (typeof f === "string" ? f : f[1])),
  ),
  ...plan.blanks.filter((b) => b.kind === "png").map((b) => b.to),
];

/**
 * The files one image lookup reads: an animation's frames (`name-0`, …)
 * when animated and present, else the plain image; each frame its `@2x`
 * file when the mix has one (lazer's LegacySkin texture lookup).
 */
export function lookupFrames(
  index: ReadonlyMap<string, string[]>,
  name: string,
  animated: boolean,
): ExportFrame[] {
  const frames = animated ? frameNames(index, name) : [];
  const names = frames.length ? frames : [name.toLowerCase()];
  const out: ExportFrame[] = [];
  for (const n of names) {
    const files = index.get(n) ?? [];
    const hd = files.find((f) => /@2x\.[^./]+$/i.test(f));
    const plain = files.find((f) => !/@2x\.[^./]+$/i.test(f));
    const path = hd ?? plain;
    if (path) out.push({ path, hd: path === hd });
  }
  return out;
}

/** Every stage of `keys` as the mix draws it. */
export function exportStages(plan: Plan, keys: readonly number[]): ExportStage[] {
  const index = imageIndex(planFiles(plan));
  const skin = readSkinIni(plan.ini);
  return keys.map((count) => stage(maniaConfig(skin, count), index));
}

function stage(
  config: ManiaConfig,
  index: ReadonlyMap<string, string[]>,
): ExportStage {
  const keys = config.keys;
  const lookups = new Map(maniaImageKeys(keys).map((l) => [l.key, l]));
  const resolved = new Map(
    resolveManiaImages(config, hasImage(index)).map((r) => [r.key, r]),
  );
  const drawn = (key: string): Drawn => {
    const image = resolved.get(key)?.drawn;
    if (!image) return null;
    if (image.builtin) return { builtin: true };
    const frames = lookupFrames(
      index,
      image.name,
      lookups.get(image.key)?.animated ?? false,
    );
    return frames.length ? { frames } : null;
  };
  const colour = (key: string, fallback: Rgba) =>
    config.colours.get(key) ?? fallback;
  return {
    keys,
    hitPosition: config.hitPosition,
    lightPosition: config.lightPosition,
    scorePosition: config.scorePosition,
    noteHeightWidth: config.noteHeightWidth,
    noteBodyStyle: config.noteBodyStyle,
    keysUnderNotes: config.keysUnderNotes,
    judgementLine: config.showJudgementLine
      ? bytes(opaque(colour("ColourJudgementLine", WHITE)))
      : null,
    barline: bytes(colour("ColourBarline", WHITE)),
    columns: Array.from({ length: keys }, (_, i) => ({
      width: config.columnWidth[i],
      spacing: config.columnSpacing[i] ?? 0,
      kind: fallbackColumnIndex(keys, i),
      key: drawn(`KeyImage${i}`),
      keyDown: drawn(`KeyImage${i}D`),
      note: drawn(`NoteImage${i}`),
      head: drawn(`NoteImage${i}H`),
      tail: drawn(`NoteImage${i}T`),
      body: drawn(`NoteImage${i}L`),
      colour: bytes(doubled(colour(`Colour${i + 1}`, BLACK))),
      light: bytes(opaque(colour(`ColourLight${i + 1}`, WHITE))),
      explosionScale: config.explosionScale[i],
      holdLightScale: config.holdLightScale[i],
    })),
    stageLeft: drawn("StageLeft"),
    stageRight: drawn("StageRight"),
    hint: drawn("StageHint"),
    stageLight: drawn("StageLight"),
    lightingN: drawn("LightingN"),
    lightingL: drawn("LightingL"),
    judgements: {
      perfect: drawn("Hit300g"),
      great: drawn("Hit300"),
      good: drawn("Hit200"),
      ok: drawn("Hit100"),
      meh: drawn("Hit50"),
      miss: drawn("Hit0"),
    },
  };
}

/** The body of `POST /v1/exports` converting `plan` for `target`. */
export function convertRequest(plan: Plan, target: ConvertTarget) {
  const keys = mixKeyCounts(plan.ini);
  return { ...plan, target, stages: exportStages(plan, keys) };
}

/** The service's report of a converted export. */
export interface ExportReport {
  exported: number[];
  skipped: { keys: number; reason: string }[];
  notes: string[];
}
/** Lines describing a finished conversion. */
export function reportLines(report: ExportReport): string[] {
  return [
    `Exported ${list(report.exported)}`,
    ...report.skipped.map((s) => `Skipped ${s.keys}K: ${s.reason}`),
    ...report.notes,
  ];
}
