// The Keymodes screen's part of a mix recipe: per key count, which image
// each `[Mania]` slot uses and the column values it sets. Composing writes
// the block's keys and copies the images under mania/<N>k/, so the
// skin.ini the mix builds names every slot the screen manages.

import {
  fallbackColumnIndex,
  maniaConfig,
  maniaImageKeys,
  resolveManiaImages,
  type ManiaImageResolution,
} from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { type Ini, maniaBlock, removeInSection, setInSection } from "./ini";
import { frameNames, hasImage, imageIndex } from "./mania";
import { occupied, stageFolder } from "./layout";
import { imageExt } from "./groups";

/** An image copied into the mix: a skin's image with its `@2x` and frames. */
export interface SlotImage {
  /** Library key of the skin the files come from (`uploads:`: dropped files). */
  skin: string;
  /** The image's name there (path without extension, `@2x` or frame number). */
  name: string;
  /** Its files and what each adds to the copy's name (`.png`, `@2x.png`, `-0.png`, …). */
  files: { from: string; suffix: string }[];
}
/**
 * One slot: an image to copy in, a value naming an image the mix already
 * has, or `null` to leave the key out (the client's default-name lookup).
 */
export type Slot = SlotImage | { value: string } | null;
export interface KeymodeDraft {
  /** By `[Mania]` image key (`KeyImage0`, `StageHint`, …). */
  images: Record<string, Slot>;
  /** Other `[Mania]` values by key (`ColumnWidth`, `Colour1`, …); `null` removes it. */
  values: Record<string, string | null>;
  /**
   * Key images as they were before HitPosition first moved them, with the
   * HitPosition they were made for: every later move starts from these, so
   * shifts never stack (or lose rows twice).
   */
  hit?: {
    originals: Record<
      string,
      {
        /** HitPosition when captured. */
        at: number;
        /** The column's width and the note height width when captured (lazer units). */
        width?: number;
        noteHeight?: number;
        slot: SlotImage;
        /** The draft's own slot for the key before the first move (absent: none). */
        prior?: Slot;
        had: boolean;
      }
    >;
    /**
     * HitPosition units moved by hand (stepper, field, calibration) since
     * the capture, at the captured widths. Width changes are not recorded
     * here: the HitPosition they derive is reached by scaling.
     */
    moved?: number;
  };
  /**
   * Keep proportions when changing column width (proportions.ts): on unless
   * turned off for this key count.
   */
  keepProportions?: boolean;
}
/** Drafts by key count. */
export type Keymodes = Record<string, KeymodeDraft>;

/** The image roles of a column, in the screen's (and the wiki's) order. */
export const COLUMN_ROLES = [
  { pattern: "KeyImage#", label: "Key" },
  { pattern: "KeyImage#D", label: "Key pressed" },
  { pattern: "NoteImage#", label: "Note" },
  { pattern: "NoteImage#H", label: "Hold head" },
  { pattern: "NoteImage#L", label: "Hold body" },
  { pattern: "NoteImage#T", label: "Hold tail" },
] as const;
export type ColumnPattern = (typeof COLUMN_ROLES)[number]["pattern"];
export const columnKey = (pattern: string, column: number) =>
  pattern.replace("#", String(column));
/** The role of a per-column key (`NoteImage3H` → `NoteImage#H`). */
export const patternOf = (key: string) => key.replace(/\d+/, "#");

/**
 * The files of image `name` in a skin's `files`: the plain image and its
 * frames `name-0`, `name-1`, … (consecutive), each with its `@2x`; with the
 * part each adds to the name. Empty when the skin has no such image.
 */
export function imageUnit(
  files: readonly string[],
  name: string,
): SlotImage["files"] {
  const index = imageIndex(files);
  const lower = name.toLowerCase();
  return [lower, ...frameNames(index, name)]
    .flatMap((n) => index.get(n) ?? [])
    .map((from) => ({
      from,
      suffix: from.replace(/\\/g, "/").slice(name.length),
    }));
}

/** A copy's name: the image's file name, portable to Windows. */
function copyName(name: string) {
  const base = name
    .split("/")
    .pop()!
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return base || "image";
}

/**
 * Applies the drafts to a mix being composed: each key count's block (made
 * when missing) gets the keys its slots and values set, and copied images
 * go to mania/<N>k/<name> (see layout.ts) under names that stay the same while the
 * draft does (`name (2)` when two images share a name: a `-2` would read as
 * an animation frame).
 */
export function applyKeymodes(
  keymodes: Keymodes,
  ini: Ini,
  out: Map<
    string,
    | { skin: string; from: string; to?: string }
    | { blank: "png" | "wav"; to: string }
  >,
) {
  for (const [count, draft] of Object.entries(keymodes)) {
    const keys = Number(count);
    if (!Number.isInteger(keys) || keys < 1) continue;
    const block = maniaBlock(ini, keys);
    const folder = stageFolder(keys);
    const taken = occupied(out.keys(), folder);
    const identity = (image: SlotImage) =>
      `${image.skin}\n${image.name}`.toLowerCase();
    const copies = new Map<string, SlotImage>();
    for (const slot of Object.values(draft.images))
      if (slot && "files" in slot && slot.files.length)
        copies.set(identity(slot), slot);
    const names = new Map<string, string>();
    for (const id of [...copies.keys()].sort()) {
      const image = copies.get(id)!;
      const base = copyName(image.name);
      let name = base;
      for (let n = 2; taken.has(`${folder}/${name}`.toLowerCase()); n++)
        name = `${base} (${n})`;
      taken.add(`${folder}/${name}`.toLowerCase());
      names.set(id, name);
      for (const file of image.files) {
        const to = `${folder}/${name}${file.suffix}`;
        out.set(to.toLowerCase(), { skin: image.skin, from: file.from, to });
      }
    }
    for (const [key, slot] of Object.entries(draft.images)) {
      if (slot === null) removeInSection(block, key);
      else if ("value" in slot) setInSection(block, key, slot.value);
      else if (names.has(identity(slot)))
        setInSection(block, key, `${folder}/${names.get(identity(slot))}`);
    }
    for (const [key, value] of Object.entries(draft.values)) {
      if (value === null) removeInSection(block, key);
      else setInSection(block, key, value);
    }
  }
}

/** Keys a change between two drafts touches. */
export function touchedKeys(
  before: KeymodeDraft | undefined,
  after: KeymodeDraft | undefined,
): string[] {
  const keys = new Set<string>();
  for (const draft of [before, after])
    if (draft) {
      for (const key of Object.keys(draft.images)) keys.add(key);
      for (const key of Object.keys(draft.values)) keys.add(key);
    }
  return [...keys];
}

/**
 * One stage of a skin as the screen shows it: every image lookup resolved
 * against the skin's files and the classic look (render-core's rules).
 */
export function stageImages(
  text: string,
  files: readonly string[],
  keys: number,
): ManiaImageResolution[] {
  return resolveManiaImages(
    maniaConfig(readSkinIni(text), keys),
    hasImage(imageIndex(files)),
  );
}

/** Column images a stage cannot do without (keys and notes). */
const ESSENTIAL = /^(KeyImage\d+D?|NoteImage\d+)$/;
/**
 * A stage's state for the key count list: `missing` when a key or note is
 * drawn by nothing, `fallback` when a column image comes from the built-in
 * look, else `complete`.
 */
export function stageStatus(
  images: readonly ManiaImageResolution[],
): "complete" | "fallback" | "missing" {
  const columns = images.filter((i) => i.column !== undefined);
  if (columns.some((i) => ESSENTIAL.test(i.key) && !i.drawn)) return "missing";
  return columns.some((i) => i.drawn?.builtin) ? "fallback" : "complete";
}

/** The slot a key has now: the draft's, else a value naming what the mix draws. */
export type Current = (key: string) => Slot;

/**
 * "Apply to all columns": every column's `pattern` slot takes column
 * `from`'s.
 */
export function applyToAll(
  keys: number,
  pattern: string,
  from: number,
  current: Current,
): Record<string, Slot> {
  const slot = current(columnKey(pattern, from));
  const out: Record<string, Slot> = {};
  for (let c = 0; c < keys; c++)
    if (c !== from) out[columnKey(pattern, c)] = slot;
  return out;
}

/**
 * "Mirror": the right half takes the left half's images, column `keys-1-i`
 * from column `i` (1↔7, 2↔6, 3↔5 in 7K; outer pairs inwards for even counts;
 * a middle column keeps its own).
 */
export function mirror(keys: number, current: Current): Record<string, Slot> {
  const out: Record<string, Slot> = {};
  for (let i = 0; i < Math.floor(keys / 2); i++)
    for (const { pattern } of COLUMN_ROLES)
      out[columnKey(pattern, keys - 1 - i)] = current(columnKey(pattern, i));
  return out;
}

/**
 * "Use osu!'s default pattern": columns of one kind share images, the way
 * the client's default names do (`mania-key1`, `mania-key2`, `mania-keyS`;
 * lazer's LegacyManiaColumnElement.FallbackColumnIndex). Every column takes
 * the images of the first column of its kind.
 */
export function defaultPattern(
  keys: number,
  current: Current,
): Record<string, Slot> {
  const first = new Map<string, number>();
  const out: Record<string, Slot> = {};
  for (let c = 0; c < keys; c++) {
    const kind = fallbackColumnIndex(keys, c);
    if (!first.has(kind)) {
      first.set(kind, c);
      continue;
    }
    for (const { pattern } of COLUMN_ROLES)
      out[columnKey(pattern, c)] = current(columnKey(pattern, first.get(kind)!));
  }
  return out;
}

/**
 * The source column each of `target` columns copies when a stage of
 * `source` columns is copied: the source column of the same kind (1, 2, S)
 * nearest in relative position, or the nearest column when the source has
 * no column of that kind (no middle column in an even count).
 */
export function remapColumns(target: number, source: number): number[] {
  const at = (c: number, n: number) => (c + 0.5) / n;
  return Array.from({ length: target }, (_, c) => {
    const kind = fallbackColumnIndex(target, c);
    const all = Array.from({ length: source }, (_, i) => i);
    const same = all.filter((i) => fallbackColumnIndex(source, i) === kind);
    const pool = same.length ? same : all;
    return pool.reduce((best, i) =>
      Math.abs(at(i, source) - at(c, target)) <
      Math.abs(at(best, source) - at(c, target))
        ? i
        : best,
    );
  });
}

/** Per-column list values copied with a stage (one entry per column). */
export const COLUMN_LISTS = ["ColumnWidth", "LightingNWidth", "LightingLWidth"];

/**
 * "Copy key count from…": the slots and column values of a `keys`-column
 * draft taken from a stage of `from` columns. `image(key)` gives the
 * source's slot for one of its keys; `value(key)` its value. Column keys are
 * remapped with {@link remapColumns}, stage images and values keep their key.
 */
export function copyStage(
  keys: number,
  from: number,
  image: (key: string) => Slot,
  value: (key: string) => string | undefined,
): KeymodeDraft {
  const map = remapColumns(keys, from);
  const images: Record<string, Slot> = {};
  for (const lookup of maniaImageKeys(keys)) {
    const key =
      lookup.column === undefined
        ? lookup.key
        : columnKey(patternOf(lookup.key), map[lookup.column]);
    images[lookup.key] = image(key);
  }
  const values: Record<string, string | null> = {};
  for (const list of COLUMN_LISTS) {
    const raw = value(list);
    values[list] =
      raw === undefined
        ? null
        : map.map((i) => raw.split(",")[i]?.trim() ?? "").join(",");
  }
  // Lines: left of each column, then the stage's right edge.
  const lines = value("ColumnLineWidth");
  values.ColumnLineWidth =
    lines === undefined
      ? null
      : [...map, from].map((i) => lines.split(",")[i]?.trim() ?? "").join(",");
  for (let c = 0; c < keys; c++)
    for (const name of ["Colour", "ColourLight"]) {
      const raw = value(`${name}${map[c] + 1}`);
      values[`${name}${c + 1}`] = raw ?? null;
    }
  return { images, values };
}

/** Undo history of draft changes: one entry per screen action. */
export interface Change {
  keys: number;
  before: KeymodeDraft | undefined;
  after: KeymodeDraft | undefined;
  label: string;
}
/**
 * Sets `slot` for every key of `draft` (one undoable change however many
 * slots). A key image chosen by hand is no longer one HitPosition moved.
 */
export function assignSlots(draft: KeymodeDraft, keys: readonly string[], slot: Slot) {
  for (const key of keys) {
    draft.images[key] = slot === null ? null : structuredClone(slot);
    if (draft.hit) delete draft.hit.originals[key];
  }
}

export class History {
  #undo: Change[] = [];
  #redo: Change[] = [];
  push(change: Change) {
    this.#undo.push(change);
    if (this.#undo.length > 200) this.#undo.shift();
    this.#redo.length = 0;
  }
  undo(): Change | undefined {
    const change = this.#undo.pop();
    if (change) this.#redo.push(change);
    return change;
  }
  redo(): Change | undefined {
    const change = this.#redo.pop();
    if (change) this.#undo.push(change);
    return change;
  }
  get canUndo() {
    return this.#undo.length > 0;
  }
  get canRedo() {
    return this.#redo.length > 0;
  }
  /** The next undo / redo, for button labels. */
  get next(): { undo?: string; redo?: string } {
    return { undo: this.#undo.at(-1)?.label, redo: this.#redo.at(-1)?.label };
  }
}
