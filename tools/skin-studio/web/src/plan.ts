// Composes a mix recipe into the service's build plan: which files to copy
// from which skin, which elements to blank, and the merged skin.ini.

import { resolve } from "@vosu-tools/skin-spec";
import { type Group, elementFiles, groups, imageExt, stem } from "./groups";
import {
  type Ini,
  entries,
  getValue,
  maniaBlocks,
  parseIni,
  removeKeys,
  replaceMania,
  serializeIni,
  setValue,
  appendLines,
} from "./ini";

export interface SkinData {
  key: string;
  name: string;
  text: string;
  files: string[];
}
export type Pick =
  { kind: "skin"; key: string } | { kind: "default" } | { kind: "blank" };
export interface Recipe {
  name: string;
  base: string | null;
  picks: Record<string, Pick>;
}
export type FileMap = string | [string, string];
export interface Plan {
  name: string;
  target: "stable" | "osk";
  overwrite: boolean;
  ini: string;
  sources: { skin: string; files: FileMap[] }[];
  blanks: { to: string; kind: "png" | "wav" }[];
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

const iniPairs = (ini: Ini, group: Group) =>
  (group.ini ?? []).flatMap((k) =>
    entries(ini, k.section, k.pattern ? new RegExp(k.key) : k.key).map((e) => ({
      section: k.section,
      ...e,
    })),
  );

/** Every file of `skin` that the group owns (elements + skin.ini references). */
export function groupFiles(group: Group, skin: SkinData): string[] {
  const ini = parseIni(skin.text);
  if (group.maniaKeys !== undefined) {
    const block = maniaBlocks(ini).get(group.maniaKeys);
    if (!block) return [];
    return referenced(
      skin.files,
      entries([block], "Mania", /.*/).map((e) => ({ section: "Mania", ...e })),
    );
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

export interface Composed {
  plan: Plan;
  /** Files per contributing skin, for the summary. */
  counts: Map<string, number>;
}

export function compose(
  recipe: Recipe,
  skins: Map<string, SkinData>,
  target: Plan["target"],
): Composed {
  const base = recipe.base ? skins.get(recipe.base) : undefined;
  // Output path (lower-cased) → source.
  const out = new Map<
    string,
    { skin: string; from: string } | { blank: "png" | "wav"; to: string }
  >();
  const ini: Ini = base
    ? parseIni(base.text)
    : parseIni("[General]\r\nName: \r\nAuthor: \r\nVersion: latest\r\n");
  if (base)
    for (const file of base.files)
      if (!ignored(file))
        out.set(file.toLowerCase(), { skin: base.key, from: file });

  for (const [id, pick] of Object.entries(recipe.picks)) {
    const group = groupById(id);
    if (!group) continue;
    if (base)
      for (const file of groupFiles(group, base))
        out.delete(file.toLowerCase());
    const source = pick.kind === "skin" ? skins.get(pick.key) : undefined;
    if (group.maniaKeys !== undefined) {
      const block =
        source && maniaBlocks(parseIni(source.text)).get(group.maniaKeys);
      replaceMania(ini, group.maniaKeys, block);
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
      for (const file of groupFiles(group, source))
        out.set(file.toLowerCase(), { skin: source.key, from: file });
    } else if (pick.kind === "blank") {
      for (const element of group.elements) {
        if (element.name.endsWith("*")) continue;
        const to = `${element.name}.${element.audio ? "wav" : "png"}`;
        out.set(to.toLowerCase(), { blank: element.audio ? "wav" : "png", to });
      }
    }
  }

  setValue(ini, "General", "Name", recipe.name.trim());
  if (!getValue(ini, "General", "Version"))
    setValue(ini, "General", "Version", "latest");

  const sources = new Map<string, FileMap[]>();
  const blanks: Plan["blanks"] = [];
  const counts = new Map<string, number>();
  for (const entry of out.values()) {
    if ("blank" in entry) {
      blanks.push({ to: entry.to, kind: entry.blank });
      continue;
    }
    const list = sources.get(entry.skin) ?? [];
    list.push(entry.from);
    sources.set(entry.skin, list);
    counts.set(entry.skin, (counts.get(entry.skin) ?? 0) + 1);
  }
  return {
    plan: {
      name: recipe.name.trim(),
      target,
      overwrite: false,
      ini: serializeIni(ini),
      sources: [...sources].map(([skin, files]) => ({ skin, files })),
      blanks,
    },
    counts,
  };
}

/** Skin keys a recipe needs loaded before composing. */
export const recipeSkins = (recipe: Recipe) => [
  ...new Set([
    ...(recipe.base ? [recipe.base] : []),
    ...Object.values(recipe.picks).flatMap((p) =>
      p.kind === "skin" ? [p.key] : [],
    ),
  ]),
];
