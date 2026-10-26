// Where Skin studio puts the images it writes for a key count, and which of
// a skin's files are its own.
//
// Every image made or copied for one key count goes to `mania/<N>k/`
// (lowercase: lazer and Windows look files up case-insensitively, Linux
// stable does not, so skin.ini names them exactly as written). A skin's own
// `mania/` folder often holds its files too, so each `mania/<N>k/` folder
// Skin studio writes into gets an ownership manifest, `.skin-studio.json`,
// listing the files it generated there. Only those are ever replaced or
// removed; a name a foreign file has is never taken. Earlier versions wrote
// `skin-studio/<N>k/`: those copies are Skin studio's by that folder's name,
// and composing moves the ones still in use to `mania/<N>k/` and drops the rest.

import { type Ini, entries, maniaBlocks, setInSection } from "./ini";
import { imageExt } from "./groups";

export const stageFolder = (keys: number) => `mania/${keys}k`;
export const MANIFEST = ".skin-studio.json";
const LEGACY = /^skin-studio\/(\d+)k\//i;
const MANIFEST_PATH = /^mania\/\d+k\/\.skin-studio\.json$/i;
const FOLDER = /^(mania\/\d+k)\/[^/]+$/i;

export type OutEntry =
  | { skin: string; from: string; to?: string }
  | { blank: "png" | "wav"; to: string };
/** A composed skin's files by lower-cased output path. */
export type Out = Map<string, OutEntry>;

const outPath = (entry: OutEntry) => ("blank" in entry ? entry.to : (entry.to ?? entry.from));

/** Lower-cased image names (no extension, `@2x`, frame) taken in a folder. */
export function occupied(paths: Iterable<string>, folder: string): Set<string> {
  const out = new Set<string>();
  const prefix = `${folder}/`.toLowerCase();
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!lower.startsWith(prefix) || !imageExt.test(lower)) continue;
    const name = lower.replace(/\.[^./]+$/, "").replace(/@2x$/, "");
    out.add(name);
    out.add(name.replace(/-\d+$/, ""));
  }
  return out;
}

/** `name`, else `name (2)`, `name (3)`, … whichever no file in `folder` has. */
export function freeName(taken: Set<string>, folder: string, name: string) {
  let free = name;
  for (let n = 2; taken.has(`${folder}/${free}`.toLowerCase()); n++) free = `${name} (${n})`;
  taken.add(`${folder}/${free}`.toLowerCase());
  return free;
}

/** skin.ini image values, normalised the way lookups compare them. */
function referenced(ini: Ini): Set<string> {
  const values = new Set<string>();
  for (const section of ini)
    for (const e of entries([section], section.name, /.*/))
      values.add(
        e.value
          .trim()
          .replace(/\\/g, "/")
          .replace(/\.(png|jpe?g)$/i, "")
          .replace(/@2x$/i, "")
          .toLowerCase(),
      );
  return values;
}
const stems = (path: string) => {
  const stem = path.toLowerCase().replace(/\.[^./]+$/, "").replace(/@2x$/, "");
  return [stem, stem.replace(/-\d+$/, "")];
};

/**
 * Finishes the key-count folders of a composed skin: moves `skin-studio/<N>k/`
 * copies still named in a `[Mania]` block to `mania/<N>k/` (dropping the
 * rest), drops Skin studio's own files no key names any more, and returns
 * the ownership manifests to write. `owned` lists (lower-cased) the base's
 * files Skin studio made; `base` is the base skin's key.
 */
export function finishStageFolders(
  ini: Ini,
  out: Out,
  base: string | undefined,
  owned: ReadonlySet<string>,
): { to: string; text: string }[] {
  // Copies under the earlier folder that a block still names move over.
  const moved = new Map<string, string>();
  for (const [keys, block] of maniaBlocks(ini)) {
    const folder = stageFolder(keys);
    for (const e of entries([block], "Mania", /.*/)) {
      const value = e.value.trim().replace(/\\/g, "/").replace(/\.(png|jpe?g)$/i, "");
      if (!LEGACY.test(value)) continue;
      const lower = value.toLowerCase();
      let target = moved.get(`${keys}\n${lower}`);
      if (!target) {
        const files = [...out.entries()].filter(([path]) => stems(path).includes(lower.replace(/@2x$/, "")));
        if (!files.length) continue;
        const name = freeName(occupied(out.keys(), folder), folder, value.split("/").pop()!);
        target = `${folder}/${name}`;
        moved.set(`${keys}\n${lower}`, target);
        for (const [path, entry] of files) {
          if ("blank" in entry) continue;
          const original = outPath(entry);
          const suffix = original.slice(original.lastIndexOf("/") + 1 + value.split("/").pop()!.length);
          out.delete(path);
          const to = `${target}${suffix}`;
          out.set(to.toLowerCase(), { ...entry, to });
        }
      }
      setInSection(block, e.key, target);
    }
  }
  const values = referenced(ini);
  const isOurs = (path: string, entry: OutEntry) =>
    // A copy made now (from another skin, renamed, or blank) or one the base's
    // manifest lists.
    "blank" in entry || entry.skin !== base || (entry.to !== undefined && entry.to !== entry.from) || owned.has(path);
  const folders = new Map<string, string[]>();
  for (const [path, entry] of [...out]) {
    // Earlier versions' folder and old manifests: rewritten below.
    if (LEGACY.test(path) || MANIFEST_PATH.test(path)) {
      out.delete(path);
      continue;
    }
    const folder = FOLDER.exec(outPath(entry))?.[1];
    if (!folder || !isOurs(path, entry)) continue;
    // Our file no key names any more: gone.
    if (!stems(path).some((s) => values.has(s))) {
      out.delete(path);
      continue;
    }
    const lower = folder.toLowerCase();
    folders.set(lower, [...(folders.get(lower) ?? []), outPath(entry).slice(folder.length + 1)]);
  }
  return [...folders].map(([folder, files]) => ({
    to: `${folder}/${MANIFEST}`,
    text: `${JSON.stringify(
      {
        about: "Files Skin studio (vosu tools) generated in this folder; it replaces or removes only these.",
        files: files.sort(),
      },
      null,
      2,
    )}\n`,
  }));
}
