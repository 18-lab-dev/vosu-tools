// Single assets as mix units, and how taking one from a skin carries the
// skin.ini keys that make the client actually draw it.
//
// A unit is an image with its @2x variant and animation frames, a sound, or a
// font (a prefix's glyph set). Lookups follow the clients' legacy skin rules:
// skin.ini image keys name a file relative to the skin (extension and @2x
// dropped), prefix keys name `<prefix>-<glyph>` files, and anything a key does
// not name falls back to the element's default file name.

import { resolve } from "@vosu-tools/skin-spec";
import { audioExt, elementMatches, groups, imageExt, stem } from "./groups";
import {
  type Ini,
  type Section,
  entries,
  getValue,
  keyOf,
  maniaBlock,
  maniaBlocks,
  removeInSection,
  removeKeys,
  setInSection,
  setValue,
  valueOf,
} from "./ini";

export type AssetKind = "image" | "sound" | "font";
export interface AssetRef {
  kind: AssetKind;
  /** Lower-case skin-relative path without extension, @2x or frame number; a font's prefix. */
  name: string;
}
export const assetId = (ref: AssetRef) => `${ref.kind}:${ref.name}`;
export function parseAssetId(id: string): AssetRef | undefined {
  const at = id.indexOf(":");
  const kind = id.slice(0, at);
  return kind === "image" || kind === "sound" || kind === "font"
    ? { kind, name: id.slice(at + 1) }
    : undefined;
}

/** Offered (not automatic) skin.ini changes that also affect other assets. */
export type Carry = "framerate" | "overlap" | "clear";
export interface Override {
  /** Library key of the skin the asset comes from. */
  skin: string;
  /** Offers the user accepted. */
  carry?: Carry[];
}
export interface Offer {
  id: Carry;
  label: string;
  /** The skin.ini lines it changes, `[Section] Key: value` (or `-Key` to clear). */
  changes: string[];
  applied: boolean;
}
export interface OverrideNote {
  ref: AssetRef;
  /** Group id the asset belongs to, for listing (`other` when none). */
  group: string;
  files: number;
  /** Keys set automatically so the chosen file is the one drawn. */
  carried: string[];
  offers: Offer[];
  /** Nothing in skin.ini names this file and it is no default element name. */
  unreferenced: boolean;
}

const GLYPH = /^(.+)-(\d|comma|dot|percent|x)$/;
/** Animations whose frames have no dash before the number. */
const noDash = (name: string) =>
  name === "sliderb" || name.startsWith("pippidon");

/** Normalised file name of a skin.ini image value (lazer's lookup form). */
export const imageValue = (value: string) =>
  value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.png$/i, "")
    .replace(/@2x$/i, "")
    .toLowerCase();

/**
 * Whether a skin-relative file belongs to the unit. `fonts` are the skin's font
 * prefixes: `<prefix>-<digit>` files are glyphs there, not animation frames
 * (a skin with `HitCirclePrefix: hitcircle` has `hitcircle-1.png` glyphs).
 */
export function inUnit(
  ref: AssetRef,
  file: string,
  fonts: ReadonlySet<string> = new Set(),
): boolean {
  const s = stem(file);
  if (ref.kind === "sound") return audioExt.test(file) && s === ref.name;
  if (!imageExt.test(file)) return false;
  if (ref.kind === "font") return GLYPH.exec(s)?.[1] === ref.name;
  if (s === ref.name) return true;
  if (!s.startsWith(ref.name) || fonts.has(ref.name)) return false;
  const rest = s.slice(ref.name.length);
  return noDash(ref.name) ? /^\d+$/.test(rest) : /^-\d+$/.test(rest);
}
export const unitFiles = (
  ref: AssetRef,
  files: readonly string[],
  fonts?: ReadonlySet<string>,
) => files.filter((f) => inUnit(ref, f, fonts));

/** The font prefixes a skin.ini uses (its own or the clients' defaults). */
export const fontPrefixes = (ini: Ini): Set<string> =>
  new Set(
    FONT_KEYS.map((f) =>
      imageValue(getValue(ini, "Fonts", f.prefix) ?? f.fallback),
    ),
  );

/** The font prefix of a glyph file (`<prefix>-<digit|comma|dot|percent|x>`); only meaningful for font elements, since animation frames look the same. */
export const fontOf = (file: string) =>
  imageExt.test(file) ? GLYPH.exec(stem(file))?.[1] : undefined;

const FONT_KEYS = [
  {
    prefix: "HitCirclePrefix",
    overlap: "HitCircleOverlap",
    fallback: "default",
    overlapDefault: "-2",
  },
  {
    prefix: "ScorePrefix",
    overlap: "ScoreOverlap",
    fallback: "score",
    overlapDefault: "0",
  },
  {
    prefix: "ComboPrefix",
    overlap: "ComboOverlap",
    fallback: "score",
    overlapDefault: "0",
  },
] as const;

/** [Mania] keys whose default file name is the given element (lower case). */
function maniaFamily(name: string): ((key: string) => boolean) | undefined {
  let m = /^mania-note[12s]([hlt]?)$/.exec(name);
  if (m) {
    const suffix = m[1].toUpperCase();
    return (key) => new RegExp(`^NoteImage\\d+${suffix}$`).test(key);
  }
  m = /^mania-key[12s](d?)$/.exec(name);
  if (m) {
    const suffix = m[1].toUpperCase();
    return (key) => new RegExp(`^KeyImage\\d+${suffix}$`).test(key);
  }
  m = /^mania-stage-(left|right|bottom|hint|light)$/.exec(name);
  if (m) {
    const key = `Stage${m[1][0].toUpperCase()}${m[1].slice(1)}`;
    return (k) => k === key;
  }
  m = /^lighting([nl])$/.exec(name);
  if (m) {
    const key = `Lighting${m[1].toUpperCase()}`;
    return (k) => k === key;
  }
  m = /^mania-hit(0|50|100|200|300g?)$/.exec(name);
  if (m) {
    const key = `Hit${m[1]}`;
    return (k) => k === key;
  }
  return undefined;
}

/** Whether a client looks this file name up without any skin.ini key. */
function defaultNamed(ref: AssetRef): boolean {
  if (ref.kind === "font")
    return FONT_KEYS.some((f) => f.fallback === ref.name);
  if (ref.name.includes("/")) return false;
  if (maniaFamily(ref.name)) return true;
  const file = `${ref.name}.${ref.kind === "sound" ? "wav" : "png"}`;
  return groups.some((g) => g.elements.some((e) => elementMatches(e, file)));
}

interface KeyRef {
  section: string;
  /** For [Mania]: the block's key count. */
  keys?: number;
  key: string;
  value: string;
}
const label = (k: KeyRef) =>
  `[${k.section}${k.keys !== undefined ? ` ${k.keys}K` : ""}] ${k.key}`;

/** skin.ini keys of a skin that name the unit (image keys, or prefix keys for a font). */
function keysNaming(ini: Ini, ref: AssetRef): KeyRef[] {
  if (ref.kind === "sound") return [];
  const want = ref.kind === "font" ? "prefix" : "image";
  const out: KeyRef[] = [];
  for (const section of ini) {
    const keys =
      section.name === "Mania"
        ? Number(entries([section], "Mania", "Keys")[0]?.value)
        : undefined;
    if (section.name === "Mania" && !Number.isInteger(keys)) continue;
    for (const line of section.lines) {
      const key = keyOf(line);
      if (!key || resolve(section.name, key)?.type !== want) continue;
      const value = valueOf(line);
      if (imageValue(value) === ref.name)
        out.push({ section: section.name, keys, key, value });
    }
  }
  return out;
}

function sectionOf(
  ini: Ini,
  k: { section: string; keys?: number },
): Section | undefined {
  if (k.keys !== undefined) return maniaBlocks(ini).get(k.keys);
  return ini.find((s) => s.name === k.section);
}

/** Group id an asset is listed under. */
export function groupOf(ref: AssetRef, sourceIni: Ini): string {
  if (ref.kind === "font") return "numbers";
  const file = `${ref.name}.${ref.kind === "sound" ? "wav" : "png"}`;
  const group = groups.find((g) =>
    g.elements.some((e) => elementMatches(e, file)),
  );
  if (group) return group.id;
  const mania = keysNaming(sourceIni, ref).find((k) => k.keys !== undefined);
  return mania ? `mania-keys-${mania.keys}` : "other";
}

/**
 * Applies one override to the composed output and skin.ini. `out` maps
 * lower-case output paths to their source; the unit's files there are
 * replaced by the source skin's.
 */
export function applyOverride<T>(
  ref: AssetRef,
  override: Override,
  source: { files: readonly string[]; ini: Ini },
  ini: Ini,
  out: Map<string, T>,
  entry: (file: string) => T,
): OverrideNote {
  const mixFonts = fontPrefixes(ini);
  for (const path of [...out.keys()])
    if (inUnit(ref, path, mixFonts)) out.delete(path);
  const files = unitFiles(ref, source.files, fontPrefixes(source.ini));
  for (const file of files) out.set(file.toLowerCase(), entry(file));

  // Keys that name the file in its skin come along wherever the mix would
  // otherwise look up a different name.
  const carried: string[] = [];
  const naming = keysNaming(source.ini, ref);
  for (const k of naming) {
    const target = k.keys !== undefined ? maniaBlock(ini, k.keys) : undefined;
    if (target) {
      const current = entries([target], "Mania", k.key)[0]?.value;
      if (current !== undefined && imageValue(current) === ref.name) continue;
      setInSection(target, k.key, k.value);
    } else {
      const current = getValue(ini, k.section, k.key);
      if (current !== undefined && imageValue(current) === ref.name) continue;
      setValue(ini, k.section, k.key, k.value);
    }
    carried.push(`${label(k)}: ${k.value}`);
  }

  const accepted = new Set(override.carry ?? []);
  const offers: Offer[] = [];

  // Frame timing is global: carrying it changes every animation.
  const animated = files.filter((f) => stem(f) !== ref.name).length >= 2;
  if (ref.kind === "image" && animated) {
    const theirs = getValue(source.ini, "General", "AnimationFramerate");
    const ours = getValue(ini, "General", "AnimationFramerate");
    if ((theirs ?? "-1") !== (ours ?? "-1")) {
      const applied = accepted.has("framerate");
      if (applied) {
        if (theirs === undefined)
          removeKeys(ini, "General", "AnimationFramerate");
        else setValue(ini, "General", "AnimationFramerate", theirs);
      }
      offers.push({
        id: "framerate",
        label: "Frame rate",
        changes: [`[General] AnimationFramerate: ${theirs ?? "-1"}`],
        applied,
      });
    }
  }

  // A font's glyph spacing belongs to every key that uses the prefix.
  if (ref.kind === "font") {
    const changes: [string, string][] = [];
    for (const f of FONT_KEYS) {
      const prefix = getValue(ini, "Fonts", f.prefix) ?? f.fallback;
      if (imageValue(prefix) !== ref.name) continue;
      const theirs =
        getValue(source.ini, "Fonts", f.overlap) ?? f.overlapDefault;
      const ours = getValue(ini, "Fonts", f.overlap) ?? f.overlapDefault;
      if (Number(theirs) !== Number(ours)) changes.push([f.overlap, theirs]);
    }
    if (changes.length) {
      const applied = accepted.has("overlap");
      if (applied)
        for (const [key, value] of changes) setValue(ini, "Fonts", key, value);
      offers.push({
        id: "overlap",
        label: "Glyph overlap",
        changes: changes.map(([key, value]) => `[Fonts] ${key}: ${value}`),
        applied,
      });
    }
  }

  // The source skin draws a default-named file where the mix's skin.ini names
  // another image: clearing those keys makes the mix use this one, but also
  // changes what the other columns/keys show.
  if (!naming.length) {
    const clear: KeyRef[] = [];
    if (ref.kind === "font") {
      for (const f of FONT_KEYS) {
        if (f.fallback !== ref.name) continue;
        const ours = getValue(ini, "Fonts", f.prefix);
        if (ours === undefined || imageValue(ours) === ref.name) continue;
        if (getValue(source.ini, "Fonts", f.prefix) === undefined)
          clear.push({ section: "Fonts", key: f.prefix, value: ours });
      }
    } else {
      const family = ref.kind === "image" ? maniaFamily(ref.name) : undefined;
      if (family) {
        const theirs = maniaBlocks(source.ini);
        for (const [keys, block] of maniaBlocks(ini))
          for (const line of block.lines) {
            const key = keyOf(line);
            if (!key || !family(key) || imageValue(valueOf(line)) === ref.name)
              continue;
            const other = theirs.get(keys);
            if (other && entries([other], "Mania", key).length) continue;
            clear.push({ section: "Mania", keys, key, value: valueOf(line) });
          }
      }
    }
    if (clear.length) {
      const applied = accepted.has("clear");
      if (applied)
        for (const k of clear) {
          const section = sectionOf(ini, k);
          if (section) removeInSection(section, k.key);
        }
      offers.push({
        id: "clear",
        label:
          clear.length === 1 ? "Clear 1 key" : `Clear ${clear.length} keys`,
        changes: clear.map((k) => `-${label(k)}`),
        applied,
      });
    }
  }

  return {
    ref,
    group: groupOf(ref, source.ini),
    files: files.length,
    carried,
    offers,
    unreferenced: !naming.length && !defaultNamed(ref),
  };
}
