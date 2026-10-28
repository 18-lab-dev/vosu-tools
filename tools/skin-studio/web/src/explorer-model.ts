// Explorer rows: a skin's files as a folder tree and a list that is either
// one row per file or one row per mix unit (an image with its @2x variant and
// animation frames, a sound, a font's glyphs).

import { type AssetRef, assetId, unitOf } from "./assets";
import { audioExt, imageExt, stem } from "./groups";

export interface FileInfo {
  name: string;
  size: number;
}
export type FileKind = "image" | "sound" | "text" | "other";
export interface Row {
  /** Unique within a listing: `file:<name>` or the unit's asset id. */
  id: string;
  /** Member files, the representative (thumbnail) one first. */
  files: string[];
  /** Name shown in the list (without the folder). */
  label: string;
  /** Folder of the row's files, "" for the skin root. */
  folder: string;
  kind: FileKind;
  size: number;
  unit?: AssetRef;
  /** `@2x`, `12 frames`, `10 glyphs`, `frame 3`… */
  detail: string;
}
export interface Folder {
  /** Folder path ("" is the skin root). */
  path: string;
  name: string;
  depth: number;
  /** Files directly inside. */
  count: number;
  /** Files inside, its subfolders included (what the tree shows). */
  total: number;
}

const textExt = /\.(ini|txt|json|cfg|md)$/i;
export const kindOf = (name: string): FileKind =>
  imageExt.test(name)
    ? "image"
    : audioExt.test(name)
      ? "sound"
      : textExt.test(name)
        ? "text"
        : "other";
export const folderOf = (name: string) => {
  const at = name.lastIndexOf("/");
  return at < 0 ? "" : name.slice(0, at);
};
const baseOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);
const hd = (name: string) => /@2x\.[^./]+$/i.test(name);
const frameOf = (name: string, unit: AssetRef) => {
  const rest = stem(name).slice(unit.name.length).replace(/^-/, "");
  return /^\d+$/.test(rest) ? Number(rest) : undefined;
};

/** Every folder that holds files (or holds folders that do), in tree order. */
export function folders(files: readonly FileInfo[]): Folder[] {
  const counts = new Map<string, number>([["", 0]]);
  for (const { name } of files) {
    const folder = folderOf(name);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
    for (
      let at = folder.lastIndexOf("/");
      at > 0;
      at = folder.lastIndexOf("/", at - 1)
    ) {
      const parent = folder.slice(0, at);
      if (!counts.has(parent)) counts.set(parent, 0);
    }
  }
  const paths = [...counts.keys()].sort((a, b) =>
    a
      .split("/")
      .join("\u0000")
      .localeCompare(b.split("/").join("\u0000"), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
  return paths.map((path) => ({
    path,
    name: path ? baseOf(path) : "",
    depth: path ? path.split("/").length : 0,
    count: counts.get(path) ?? 0,
    total: path
      ? [...counts].reduce((sum, [p, n]) => (p === path || p.startsWith(`${path}/`) ? sum + n : sum), 0)
      : files.length,
  }));
}

export interface RowOptions {
  /** Only files directly in this folder; null lists every file. */
  folder: string | null;
  /** Case-insensitive substring of the path or the unit's name. */
  query: string;
  /** One row per mix unit instead of one per file. */
  grouped: boolean;
}

const compare = (a: Row, b: Row) =>
  a.folder.localeCompare(b.folder, undefined, {
    numeric: true,
    sensitivity: "base",
  }) ||
  a.label.localeCompare(b.label, undefined, {
    numeric: true,
    sensitivity: "base",
  });

/** The list rows for a skin's files. */
export function rows(
  files: readonly FileInfo[],
  fonts: ReadonlySet<string>,
  options: RowOptions,
): Row[] {
  const query = options.query.trim().toLowerCase();
  const shown = files.filter((f) => {
    if (options.folder !== null && folderOf(f.name) !== options.folder)
      return false;
    if (!query) return true;
    if (f.name.toLowerCase().includes(query)) return true;
    const unit = unitOf(f.name, fonts);
    return !!unit && unit.name.includes(query);
  });
  if (!options.grouped)
    return shown
      .map((f): Row => {
        const unit = unitOf(f.name, fonts);
        const frame =
          unit?.kind === "image" ? frameOf(f.name, unit) : undefined;
        return {
          id: `file:${f.name}`,
          files: [f.name],
          label: baseOf(f.name),
          folder: folderOf(f.name),
          kind: kindOf(f.name),
          size: f.size,
          unit,
          detail: [
            unit?.kind === "font" ? "glyph" : "",
            frame !== undefined ? `frame ${frame}` : "",
            hd(f.name) ? "@2x" : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      })
      .sort(compare);

  const units = new Map<string, { unit: AssetRef; files: FileInfo[] }>();
  const out: Row[] = [];
  for (const f of shown) {
    const unit = unitOf(f.name, fonts);
    if (!unit) {
      out.push({
        id: `file:${f.name}`,
        files: [f.name],
        label: baseOf(f.name),
        folder: folderOf(f.name),
        kind: kindOf(f.name),
        size: f.size,
        detail: "",
      });
      continue;
    }
    const id = assetId(unit);
    const entry = units.get(id) ?? { unit, files: [] };
    entry.files.push(f);
    units.set(id, entry);
  }
  for (const [id, { unit, files: members }] of units) {
    const names = members
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const frameCount = new Set(
      names.filter((n) => frameOf(n, unit) !== undefined).map(stem),
    ).size;
    const glyphs = new Set(names.map(stem)).size;
    // The thumbnail: the plain image (@2x first), else the first frame.
    const plain = names.filter((n) => stem(n) === unit.name);
    const first = [...(plain.length ? plain : names)].sort(
      (a, b) => Number(hd(b)) - Number(hd(a)),
    )[0];
    out.push({
      id,
      files: [first, ...names.filter((n) => n !== first)],
      // Unit names are lower-cased; show the file's own spelling.
      label: `${baseOf(stem(first)) === baseOf(unit.name) ? baseOf(first).replace(/(@2x)?\.[^.]+$/i, "") : baseOf(unit.name)}${unit.kind === "font" ? "-*" : ""}`,
      folder: folderOf(first),
      kind: unit.kind === "sound" ? "sound" : "image",
      size: members.reduce((sum, f) => sum + f.size, 0),
      unit,
      detail: [
        unit.kind === "font" ? `${glyphs} glyphs` : "",
        unit.kind === "image" && frameCount >= 2 ? `${frameCount} frames` : "",
        unit.kind !== "sound" && names.some(hd) ? "@2x" : "",
        unit.kind === "sound" && names.length > 1
          ? names.map((n) => n.split(".").pop()).join(" + ")
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return out.sort(compare);
}

/** Units of the given rows, once each, in row order. */
export function rowUnits(selected: readonly Row[]): AssetRef[] {
  const seen = new Map<string, AssetRef>();
  for (const row of selected)
    if (row.unit && !seen.has(assetId(row.unit)))
      seen.set(assetId(row.unit), row.unit);
  return [...seen.values()];
}

/** Every file the units copy from a skin (an image's @2x and frames, a font's glyphs), in file order. */
export function unitFileNames(units: readonly AssetRef[], files: readonly FileInfo[], fonts: ReadonlySet<string>): string[] {
  const ids = new Set(units.map(assetId));
  return files
    .filter((f) => {
      const unit = unitOf(f.name, fonts);
      return !!unit && ids.has(assetId(unit));
    })
    .map((f) => f.name);
}

/** Bytes as B, KB or MB. */
export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
