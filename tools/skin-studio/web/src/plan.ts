// Composes a mix recipe into the service's build plan: which files to copy
// from which skin, which elements to blank, and the merged skin.ini.

import { parse, resolve } from "@vosu-tools/skin-spec";
import {
  maniaConfig,
  maniaImageKeys,
  resolveManiaImages,
} from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import {
  type Group,
  audioExt,
  elementFiles,
  groups,
  imageExt,
  stem,
} from "./groups";
import {
  type AssetRef,
  type Override,
  type OverrideNote,
  applyOverride,
  imageValue,
  parseAssetId,
} from "./assets";
import {
  type Ini,
  type Section,
  entries,
  getValue,
  maniaBlock,
  maniaBlocks,
  parseIni,
  removeKeys,
  replaceMania,
  serializeIni,
  setInSection,
  setValue,
  appendLines,
} from "./ini";
import {
  hasImage,
  imageIndex,
  lookupFiles,
  lookupName,
} from "./mania";
import { type Keymodes, applyKeymodes } from "./keymodes";
import { finishStageFolders, freeName, occupied, stageFolder } from "./layout";

export interface SkinData {
  key: string;
  name: string;
  text: string;
  files: string[];
  /** Files Skin studio generated in this skin (its ownership manifests). */
  owned?: string[];
}
export type Pick =
  { kind: "skin"; key: string } | { kind: "default" } | { kind: "blank" };
export interface Recipe {
  name: string;
  base: string | null;
  picks: Record<string, Pick>;
  /** Names/fingerprints captured for every referenced skin, including base and group picks. */
  sourceInfo?: Record<string, { name: string; contentHash?: string }>;
  /** Single assets by asset id (`image:hitcircle`, `font:default`, …); they win over picks. */
  overrides?: Record<string, Override>;
  /** The Keymodes screen's slots and values per key count; they win over both. */
  keymodes?: Keymodes;
  /**
   * The draft skin.ini text when edited by hand (kept across reloads until
   * applied or discarded).
   */
  ini?: string;
  /** The user chose the base (or none), so it does not follow osu!'s skin. */
  pinned?: boolean;
  /**
   * Composed for its base itself (Apply to base skin): the base keeps its
   * [General]. Also marks an edit-in-place draft from before the single
   * draft, kept aside until the user opens or discards it.
   */
  inPlace?: boolean;
}
export type FileMap = string | [string, string];
export interface Plan {
  name: string;
  overwrite: boolean;
  ini: string;
  sources: { skin: string; files: FileMap[] }[];
  blanks: { to: string; kind: "png" | "wav" }[];
  /** Ownership manifests (layout.ts). */
  texts: { to: string; text: string }[];
}

const MANIA_PREFIX = "mania-keys-";
export const maniaGroup = (keys: number): Group => ({
  id: `${MANIA_PREFIX}${keys}`,
  label: `${keys}K stage`,
  category: "mania",
  elements: [],
  maniaKeys: keys,
});
export function groupById(id: string): Group | undefined {
  if (id.startsWith(MANIA_PREFIX)) {
    const keys = Number(id.slice(MANIA_PREFIX.length));
    return Number.isInteger(keys) && keys > 0 ? maniaGroup(keys) : undefined;
  }
  return groups.find((g) => g.id === id);
}

/** A different stage pick cannot inherit geometry captures from its predecessor. */
export function assignGroupPick(recipe: Recipe, id: string, pick: Pick | null) {
  if (JSON.stringify(recipe.picks[id] ?? null) === JSON.stringify(pick)) return;
  if (pick) recipe.picks[id] = pick;
  else delete recipe.picks[id];
  const keys = groupById(id)?.maniaKeys;
  const draft = keys === undefined ? undefined : recipe.keymodes?.[String(keys)];
  if (draft) delete draft.hit;
}

/** Key counts with a `[Mania]` block in this skin. */
export const maniaKeyCounts = (skin: SkinData) =>
  [...maniaBlocks(parseIni(skin.text)).keys()].sort((a, b) => a - b);

/** Skin files referenced by skin.ini values of image/prefix keys. */
function referenced(
  files: string[],
  pairs: { section: string; key: string; value: string }[],
): string[] {
  const out = new Set<string>();
  for (const { section, key, value } of pairs) {
    const type = resolve(section, key)?.type;
    if (type !== "image" && type !== "prefix") continue;
    const target = value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    if (!target || target.includes("..")) continue;
    for (const file of files) {
      if (!imageExt.test(file)) continue;
      const s = stem(file);
      if (
        type === "prefix"
          ? s.startsWith(`${target}-`)
          : s === target || new RegExp(`^${escape(target)}-?\\d+$`).test(s)
      )
        out.add(file);
    }
  }
  return [...out];
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The images a stage of `keys` columns finds under their default names
 * because its `[Mania]` block names none for the key (`KeyImage0` →
 * `mania-key1`, …): each lookup with the files of `files` it reads.
 */
function stageDefaults(files: string[], block: Section, keys: number) {
  const named = new Set(entries([block], "Mania", /.*/).map((e) => e.key));
  const index = imageIndex(files);
  return maniaImageKeys(keys)
    .filter((lookup) => !named.has(lookup.key))
    .map((lookup) => ({
      ...lookup,
      files: lookupFiles(index, lookup.fallback, lookup.animated),
    }))
    .filter((lookup) => lookup.files.length);
}
/** Receptors and notes: what a stage visibly lacks when they fall back. */
const STAGE_PIECE = /^(KeyImage\d+D?|NoteImage\d+)$/;

const iniPairs = (ini: Ini, group: Group) =>
  (group.ini ?? []).flatMap((k) =>
    entries(ini, k.section, k.pattern ? new RegExp(k.key) : k.key).map((e) => ({
      section: k.section,
      ...e,
    })),
  );

/**
 * Every file of `skin` that the group owns (elements + skin.ini references).
 * A key-count group also owns the images its block leaves to default names
 * (receptors, notes, stage, lighting, judgements); `exclusive` leaves those
 * out, since every key count without its own key shares them.
 */
export function groupFiles(
  group: Group,
  skin: SkinData,
  exclusive = false,
): string[] {
  const ini = parseIni(skin.text);
  if (group.maniaKeys !== undefined) {
    const block = maniaBlocks(ini).get(group.maniaKeys);
    if (!block) return [];
    const named = referenced(
      skin.files,
      entries([block], "Mania", /.*/).map((e) => ({ section: "Mania", ...e })),
    );
    if (exclusive) return named;
    return [
      ...new Set([
        ...named,
        ...stageDefaults(skin.files, block, group.maniaKeys).flatMap(
          (lookup) => lookup.files,
        ),
      ]),
    ];
  }
  return [
    ...new Set([
      ...elementFiles(group, skin.files),
      ...referenced(skin.files, iniPairs(ini, group)),
    ]),
  ];
}

/** Files never copied from a base: its own ini, backups, previous credits. */
const ignored = (name: string) =>
  /^skin\.ini$/i.test(name) ||
  /\.bak$/i.test(name) ||
  /^skin-studio-credits\.txt$/i.test(name);

/**
 * Files an in-place apply removes: the edited skin's own files the composed
 * plan no longer has (a group set to the built-in look or blanked). Files the
 * plan never copies from a base (backups, credits) are not the draft's to
 * remove.
 */
export function inPlaceRemovals(plan: Plan, base: SkinData): string[] {
  const kept = new Set<string>();
  for (const source of plan.sources)
    for (const file of source.files)
      kept.add((typeof file === "string" ? file : file[1]).toLowerCase());
  for (const blank of plan.blanks) kept.add(blank.to.toLowerCase());
  for (const text of plan.texts) kept.add(text.to.toLowerCase());
  return base.files.filter((f) => !ignored(f) && !kept.has(f.toLowerCase()));
}

/** Whether a recipe holds edits (an in-place draft with nothing to apply is empty). */
export const hasEdits = (recipe: Recipe) =>
  !!Object.keys(recipe.picks).length ||
  !!Object.keys(recipe.overrides ?? {}).length ||
  Object.values(recipe.keymodes ?? {}).some((d) => !!d) ||
  recipe.ini !== undefined;

/**
 * A hand-edited draft skin.ini applied to its base in place: the lines the
 * composer wrote to name a new skin (`[General]` Name set to the draft's
 * name, Version added as `latest`) take the base's own values again, or are
 * left out where the base has none. Lines edited to anything else stay.
 */
export function keepGeneral(text: string, baseText: string, name: string): string {
  const own = new Map<string, string>();
  for (const line of parse(baseText).lines)
    if (line.section === "General" && line.key && !own.has(line.key.toLowerCase()))
      own.set(line.key.toLowerCase(), line.value ?? "");
  const composed: Record<string, string> = { name: name.trim(), version: "latest" };
  return parse(text)
    .lines.flatMap((line) => {
      const key = line.section === "General" ? line.key?.toLowerCase() : undefined;
      if (!key || !(key in composed) || line.value !== composed[key]) return [line.raw + line.eol];
      const value = own.get(key);
      return value === undefined ? [] : [line.raw.slice(0, (line.valueColumn ?? 1) - 1) + value + line.eol];
    })
    .join("");
}

export interface Composed {
  plan: Plan;
  /** Files per contributing skin, for the summary. */
  counts: Map<string, number>;
  /** Per override (by asset id): what it carried and what it offers. */
  notes: Map<string, OverrideNote>;
  /**
   * Per picked group: elements the base had that the mix no longer has, so
   * the client draws its built-in look for them.
   */
  fallbacks: Map<string, string[]>;
}

/** Element name of a file: its stem without an animation frame number. */
const unitName = (file: string) => stem(file).replace(/-\d+$/, "");

/** Lower-cased stems and frame bases present in the output. */
function present(out: Map<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const path of out.keys()) {
    if (!imageExt.test(path)) continue;
    const s = stem(path);
    names.add(s);
    names.add(s.replace(/-?\d+$/, ""));
  }
  return names;
}

export function compose(
  recipe: Recipe,
  skins: Map<string, SkinData>,
): Composed {
  const base = recipe.base ? skins.get(recipe.base) : undefined;
  // Output path (lower-cased) → source; `to` renames the copy.
  const out = new Map<
    string,
    | { skin: string; from: string; to?: string }
    | { blank: "png" | "wav"; to: string }
  >();
  const ini: Ini = base
    ? parseIni(base.text)
    : parseIni("[General]\r\nName: \r\nAuthor: \r\nVersion: latest\r\n");
  if (base)
    for (const file of base.files)
      if (!ignored(file))
        out.set(file.toLowerCase(), { skin: base.key, from: file });

  const removed = new Map<string, string[]>();
  for (const [id, pick] of Object.entries(recipe.picks)) {
    const group = groupById(id);
    if (!group) continue;
    if (base) {
      // A stage's default-named images stay: other key counts use them too.
      const owned = groupFiles(group, base, true);
      for (const file of owned) out.delete(file.toLowerCase());
      if (pick.kind !== "blank") removed.set(id, owned);
    }
    const source = pick.kind === "skin" ? skins.get(pick.key) : undefined;
    if (group.maniaKeys !== undefined) {
      const keys = group.maniaKeys;
      const block = source && maniaBlocks(parseIni(source.text)).get(keys);
      replaceMania(ini, keys, block);
      // The source's stage also draws images found under default names. The
      // mix's own default-named files may differ (and serve its other key
      // counts), so these are copied into this stage's folder and named in
      // its block, the way lazer would find them in the source.
      if (source && block) {
        const target = maniaBlock(ini, keys);
        const folder = stageFolder(keys);
        const taken = occupied(out.keys(), folder);
        // Columns sharing a default image share its copy.
        const named = new Map<string, string>();
        for (const lookup of stageDefaults(source.files, block, keys)) {
          // A file the skin already has there is never replaced.
          const name = lookupName(lookup.files, lookup.fallback);
          const free = named.get(name.toLowerCase()) ?? freeName(taken, folder, name);
          named.set(name.toLowerCase(), free);
          for (const from of lookup.files) {
            const to = `${folder}/${free}${from.slice(from.lastIndexOf("/") + 1 + name.length)}`;
            out.set(to.toLowerCase(), { skin: source.key, from, to });
          }
          setInSection(target, lookup.key, `${folder}/${free}`);
        }
      }
    } else {
      for (const k of group.ini ?? []) {
        const key = k.pattern ? new RegExp(k.key) : k.key;
        removeKeys(ini, k.section, key);
        if (source)
          appendLines(
            ini,
            k.section,
            entries(parseIni(source.text), k.section, key).map((e) =>
              e.line.trim(),
            ),
          );
      }
    }
    if (source) {
      for (const file of groupFiles(group, source, true))
        out.set(file.toLowerCase(), { skin: source.key, from: file });
    } else if (pick.kind === "blank") {
      for (const element of group.elements) {
        if (element.name.endsWith("*")) continue;
        const to = `${element.name}.${element.audio ? "wav" : "png"}`;
        out.set(to.toLowerCase(), { blank: element.audio ? "wav" : "png", to });
      }
      // Wildcard elements (`mania-*`, …) have no fixed names: every file the
      // base had in the group becomes blank under its own name, so the client
      // finds an invisible file instead of falling back to its default skin.
      if (base && group.maniaKeys === undefined)
        for (const to of groupFiles(group, base))
          out.set(to.toLowerCase(), {
            blank: audioExt.test(to) ? "wav" : "png",
            to,
          });
    }
  }

  const notes = new Map<string, OverrideNote>();
  for (const [id, override] of Object.entries(recipe.overrides ?? {})) {
    const ref: AssetRef | undefined = parseAssetId(id);
    const source = skins.get(override.skin);
    if (!ref || !source) continue;
    notes.set(
      id,
      applyOverride(
        ref,
        override,
        { files: source.files, ini: parseIni(source.text) },
        ini,
        out,
        (from) => ({ skin: source.key, from }),
      ),
    );
  }
  applyKeymodes(recipe.keymodes ?? {}, ini, out);

  // A skin.ini key the mix keeps (say another key count's `StageHint`) still
  // names a base file a pick removed: keep that file, so the client finds it
  // instead of drawing its built-in look.
  if (base) {
    const have = present(out);
    for (const section of ini)
      for (const e of entries([section], section.name, /.*/)) {
        if (resolve(section.name, e.key)?.type !== "image") continue;
        const target = imageValue(e.value);
        if (!target || target.includes("..") || have.has(target)) continue;
        const files = referenced(base.files, [{ section: section.name, ...e }]);
        for (const from of files)
          out.set(from.toLowerCase(), { skin: base.key, from });
        if (files.length) have.add(target);
      }
  }
  const texts = finishStageFolders(
    ini,
    out,
    base?.key,
    new Set((base?.owned ?? []).map((f) => f.toLowerCase())),
  );
  const fallbacks = new Map<string, string[]>();
  const have = present(out);
  for (const [id, files] of removed) {
    // A stage taken from a skin draws the images its new block looks up, not
    // the base's old ones: whether those fall back is resolved below.
    if (groupById(id)?.maniaKeys !== undefined && recipe.picks[id]?.kind === "skin")
      continue;
    const lost = new Set(
      files.filter((f) => imageExt.test(f) && !have.has(stem(f))).map(unitName),
    );
    for (const f of files)
      if (audioExt.test(f) && !out.has(f.toLowerCase())) lost.add(unitName(f));
    if (lost.size) fallbacks.set(id, [...lost].sort());
  }
  // A stage taken from a skin draws osu!'s built-in receptors or notes where
  // the mix has no image for them (the source may have lacked them too).
  const mixIni = readSkinIni(serializeIni(ini)),
    outIndex = imageIndex([...out.keys()]);
  for (const [id, pick] of Object.entries(recipe.picks)) {
    const keys = groupById(id)?.maniaKeys;
    if (keys === undefined || pick.kind !== "skin") continue;
    const lost = new Set(fallbacks.get(id));
    for (const image of resolveManiaImages(
      maniaConfig(mixIni, keys),
      hasImage(outIndex),
    ))
      if (STAGE_PIECE.test(image.key) && image.source === "built-in")
        lost.add(image.key);
    if (lost.size) fallbacks.set(id, [...lost].sort());
  }

  // A skin edited in place keeps its own [General]; a new skin is named.
  if (!recipe.inPlace) {
    setValue(ini, "General", "Name", recipe.name.trim());
    if (!getValue(ini, "General", "Version"))
      setValue(ini, "General", "Version", "latest");
  }

  const sources = new Map<string, FileMap[]>();
  const blanks: Plan["blanks"] = [];
  const counts = new Map<string, number>();
  for (const entry of out.values()) {
    if ("blank" in entry) {
      blanks.push({ to: entry.to, kind: entry.blank });
      continue;
    }
    const list = sources.get(entry.skin) ?? [];
    list.push(entry.to ? [entry.from, entry.to] : entry.from);
    sources.set(entry.skin, list);
    counts.set(entry.skin, (counts.get(entry.skin) ?? 0) + 1);
  }
  return {
    plan: {
      name: recipe.name.trim(),
      overwrite: false,
      ini: serializeIni(ini),
      sources: [...sources].map(([skin, files]) => ({ skin, files })),
      blanks,
      texts,
    },
    counts,
    notes,
    fallbacks,
  };
}

/** Skin keys a recipe needs loaded before composing. */
export const recipeSkins = (recipe: Recipe) => [
  ...new Set([
    ...(recipe.base ? [recipe.base] : []),
    ...Object.values(recipe.picks).flatMap((p) =>
      p.kind === "skin" ? [p.key] : [],
    ),
    ...Object.values(recipe.overrides ?? {}).map((o) => o.skin),
  ]),
];
