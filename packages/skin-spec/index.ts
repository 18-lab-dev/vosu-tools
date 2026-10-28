import data from "./spec.json";
import { hasAsset, imageLookupKind } from "./image-paths";
export { hasAsset, pathCandidates, imageLookupKind, legacyImageName, legacyTexturePaths, type ImageLookupKind } from "./image-paths";
export const revision = data.revision;
export interface Spec {
  section: string;
  key: string;
  type: string;
  default?: string;
  enum?: string[];
  min?: number;
  max?: number;
  since?: number;
  columns?: number;
  indexBase?: number;
}
export const spec: Spec[] = data.entries;
export const sections = [
  "General",
  "Colours",
  "Fonts",
  "CatchTheBeat",
  "Mania",
];
export interface Line {
  raw: string;
  eol: string;
  line: number;
  section: string;
  block: number;
  key?: string;
  value?: string;
  valueColumn?: number;
}
export interface Document {
  lines: Line[];
}
export function parse(text: string): Document {
  let section = "",
    block = 0,
    keyed = false;
  const lines: Line[] = [];
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const raw = match[1],
      trimmed = raw.replace(/^\uFEFF/, "").trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      block++;
      keyed = false;
    }
    const entry = !/^(\/\/|;|\[)/.test(trimmed)
      ? raw.match(/^\s*([^:]+?)\s*:\s*(.*)$/)
      : null;
    // A second `Keys` in one [Mania] section starts the next configuration,
    // as osu!lazer's LegacyManiaSkinDecoder reads it (a new
    // LegacyManiaSkinConfiguration per `Keys`, later lines flushed into it).
    if (section === "Mania" && entry?.[1].trim() === "Keys") {
      if (keyed) block++;
      keyed = true;
    }
    lines.push({
      raw,
      eol: match[2],
      line: lines.length + 1,
      section,
      block,
      ...(entry
        ? {
            key: entry[1].trim().replace(/^\uFEFF/, ""),
            value: entry[2].trim(),
            valueColumn:
              raw.indexOf(":") +
              2 +
              (raw.slice(raw.indexOf(":") + 1).match(/^\s*/)?.[0].length ?? 0),
          }
        : {}),
    });
  }
  return { lines };
}
export function serialize(doc: Document): string {
  return doc.lines.map((l) => l.raw + l.eol).join("");
}
export function setValue(
  doc: Document,
  lineNumber: number,
  value: string,
): Document {
  return parse(
    doc.lines
      .map((l) =>
        l.line === lineNumber
          ? l.raw.slice(0, (l.valueColumn ?? 1) - 1) + value + l.eol
          : l.raw + l.eol,
      )
      .join(""),
  );
}
export function resolve(section: string, key: string): Spec | undefined {
  return spec.find(
    (s) =>
      s.section === section &&
      (s.key === key ||
        (s.key.includes("#") &&
          new RegExp("^" + s.key.replace("#", "\\d+") + "$").test(key))),
  );
}
export function keys(section: string, count = 4): Spec[] {
  return spec
    .filter((s) => s.section === section)
    .flatMap((s) =>
      s.key.includes("#")
        ? Array.from({ length: count }, (_, i) => ({
            ...s,
            key: s.key.replace("#", String(i + (s.indexBase ?? 0))),
          }))
        : [s],
    );
}

/** A `#` command of `[Mania]` for one column: `key` is the concrete name. */
export interface ColumnKey extends Spec {
  /** The column (0 = leftmost); `key` adds the command's `indexBase`. */
  column: number;
  /** The wiki's pattern, e.g. `NoteImage#H`. */
  pattern: string;
}
/**
 * The per-column `[Mania]` commands of column `column`, in the wiki's order:
 * key and note images (`KeyImage0`, `KeyImage0D`, `NoteImage0`, `NoteImage0H`,
 * `NoteImage0L`, `NoteImage0T`: numbered from 0), colours (`Colour1`,
 * `ColourLight1`: numbered from 1) and the flip and body style settings.
 * Commands holding one value per column in a list (`ColumnWidth`, …) are
 * {@link maniaLists}.
 */
export function columnKeys(column: number): ColumnKey[] {
  return spec
    .filter((s) => s.section === "Mania" && s.key.includes("#"))
    .map((s) => ({
      ...s,
      pattern: s.key,
      column,
      key: s.key.replace("#", String(column + (s.indexBase ?? 0))),
    }));
}
/**
 * `[Mania]` commands whose value is a comma-separated list sized by the key
 * count, with that size: `ColumnWidth` (one per column), `ColumnLineWidth`
 * (one more: the lines left of each column and right of the last),
 * `ColumnSpacing` (one less: the gaps between columns), `LightingNWidth`,
 * `LightingLWidth`.
 */
export function maniaLists(keys: number): (Spec & { length: number })[] {
  return spec
    .filter((s) => s.section === "Mania" && s.columns !== undefined)
    .map((s) => ({ ...s, length: Math.max(0, keys + s.columns!) }));
}

/** `Keys: N` as osu! reads it (`int.Parse` of the value before any `//`). */
const keyCount = (value: string | undefined) => {
  const text = (value ?? "").split("//")[0].trim();
  return /^[+-]?\d+$/.test(text) ? Number(text) : undefined;
};
/**
 * The block number (`Line.block`) of the `[Mania]` section osu! uses for
 * `keys` columns: the first one declaring `Keys: keys` (lazer's
 * LegacyManiaSkinDecoder ignores later duplicates).
 */
export function maniaBlockOf(doc: Document, keys: number): number | undefined {
  return doc.lines.find(
    (l) =>
      l.section === "Mania" && l.key === "Keys" && keyCount(l.value) === keys,
  )?.block;
}
/** Key counts with a `[Mania]` block, in file order, each once. */
export function maniaKeyCounts(doc: Document): number[] {
  const out: number[] = [];
  for (const l of doc.lines) {
    const keys =
      l.section === "Mania" && l.key === "Keys" ? keyCount(l.value) : undefined;
    if (keys !== undefined && keys > 0 && !out.includes(keys)) out.push(keys);
  }
  return out;
}
/**
 * The value of `key` in the `[Mania]` block for `keys` columns, as osu!
 * reads it: the last occurrence in that block wins, a `//` comment is not
 * part of it. Undefined when the block or the key is missing.
 */
export function maniaValue(
  text: string,
  keys: number,
  key: string,
): string | undefined {
  const doc = parse(text),
    block = maniaBlockOf(doc, keys);
  if (block === undefined) return undefined;
  const line = doc.lines.findLast((l) => l.block === block && l.key === key);
  if (line?.value === undefined) return undefined;
  const comment = line.value.indexOf("//");
  return (comment < 0 ? line.value : line.value.slice(0, comment)).trim();
}
/**
 * `text` with a `[Mania]` block for `keys` columns: unchanged when it has
 * one, else with `[Mania]` and `Keys: N` appended in the file's line endings.
 */
export function addManiaBlock(text: string, keys: number): string {
  const doc = parse(text);
  if (maniaBlockOf(doc, keys) !== undefined) return text;
  const eol = doc.lines.find((l) => l.eol)?.eol ?? "\r\n";
  const last = doc.lines.at(-1);
  const head = last && !last.eol ? text + eol : text;
  const gap = last && last.raw.trim() ? eol : "";
  return `${head}${gap}[Mania]${eol}Keys: ${keys}${eol}`;
}
/**
 * `text` with `key` set to `value` in the `[Mania]` block for `keys` columns
 * (removed when `value` is undefined). Every other line, comment, line ending
 * and the BOM stay as they are. A key set twice is set where it first
 * appears and its other lines dropped; a new key goes after the block's
 * last entry with that entry's indentation; a missing block is appended
 * ({@link addManiaBlock}).
 */
export function setManiaValue(
  text: string,
  keys: number,
  key: string,
  value: string | undefined,
): string {
  if (key === "Keys") throw new Error("Keys names the block; it is not set.");
  if (value !== undefined && /[\r\n]/.test(value))
    throw new Error("skin.ini values are one line.");
  const doc = parse(text),
    block = maniaBlockOf(doc, keys),
    eol = doc.lines.find((l) => l.eol)?.eol ?? "\r\n";
  if (block === undefined)
    return value === undefined
      ? text
      : setManiaValue(addManiaBlock(text, keys), keys, key, value);
  const lines: { raw: string; eol: string; key?: string; block?: number }[] =
    doc.lines.map((l) => ({ ...l }));
  const join = (list: typeof lines) =>
    list.map((l) => l.raw + l.eol).join("");
  const matching = lines.filter((l) => l.block === block && l.key === key);
  if (matching.length) {
    const [first] = matching;
    const kept = lines.filter((l) => !matching.includes(l) || l === first);
    if (value === undefined) {
      // The dropped line's ending moves up when it ended the file's last line.
      const at = kept.indexOf(first);
      if (!first.eol && at > 0) kept[at - 1].eol = "";
      return join(kept.filter((l) => l !== first));
    }
    const colon = first.raw.indexOf(":");
    first.raw = `${first.raw.slice(0, colon + 1)} ${value}`;
    return join(kept);
  }
  if (value === undefined) return text;
  const inBlock = lines.filter((l) => l.block === block);
  const anchor = inBlock.findLast((l) => l.key !== undefined) ?? inBlock[0];
  const indent = anchor.key !== undefined ? /^\s*/.exec(anchor.raw)![0] : "";
  const added = { raw: `${indent}${key}: ${value}`, eol: anchor.eol };
  if (!anchor.eol) anchor.eol = eol;
  const at = lines.indexOf(anchor) + 1;
  return join([...lines.slice(0, at), added, ...lines.slice(at)]);
}
/**
 * The skin.ini value naming an image file: the skin-relative path with
 * forward slashes and without its extension or `@2x`, as osu! looks image
 * keys up (it appends `@2x` and the extension itself). Undefined for paths
 * that leave the skin folder (absolute, a drive, `..`) or are no image.
 */
export function imagePathValue(path: string): string | undefined {
  const slashed = path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (
    !slashed ||
    /^\/|^[A-Za-z]:/.test(slashed) ||
    slashed.split("/").some((part) => part === ".." || part === "." || !part)
  )
    return undefined;
  const ext = /\.([^./]+)$/.exec(slashed)?.[1];
  if (ext && !/^(png|jpe?g)$/i.test(ext)) return undefined;
  const value = slashed.replace(/\.(png|jpe?g)$/i, "").replace(/@2x$/i, "");
  return value || undefined;
}
export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
  replacement?: string;
}
export function validate(text: string, files?: string[]): Diagnostic[] {
  // LegacyDecoder.StripComments: validation observes the value osu! reads;
  // the parsed raw line remains intact for round-tripping.
  const valueOf = (value: string | undefined) => (value ?? "").split("//", 1)[0].trim();
  const doc = parse(text),
    out: Diagnostic[] = [];
  const versionLine = doc.lines.find(
    (l) => l.section === "General" && l.key === "Version",
  );
  const version =
    valueOf(versionLine?.value) === "latest"
      ? Infinity
      : Number(versionLine ? valueOf(versionLine.value) : 1);
  const blocks = new Map<number, number>();
  for (const l of doc.lines)
    if (l.section === "Mania" && l.key === "Keys")
      blocks.set(l.block, Number(valueOf(l.value)));
  const seen = new Set<string>();
  for (const l of doc.lines) {
    const emit = (
      message: string,
      severity: "error" | "warning" = "error",
      replacement?: string,
    ) =>
      out.push({
        line: l.line,
        column: l.valueColumn ?? 1,
        message,
        severity,
        replacement,
      });
    if (!sections.includes(l.section) && l.raw.trim().startsWith("[")) {
      const fix =
        sections.find((s) => s.toLowerCase() === l.section.toLowerCase()) ??
        (l.section === "Colors" ? "Colours" : undefined);
      emit(
        "Unknown section; commands are case-sensitive.",
        "warning",
        fix ? `[${fix}]` : undefined,
      );
    }
    if (
      l.section === "Mania" &&
      l.raw.trim() === "[Mania]" &&
      !blocks.has(l.block)
    )
      emit("Each Mania section requires Keys.");
    if (!l.key) {
      if (l.raw.trim() && !/^(\uFEFF?\s*\[|\s*\/\/|\s*;)/.test(l.raw))
        emit("Expected Key: value.");
      continue;
    }
    const s = resolve(l.section, l.key);
    if (!s) {
      const fix = keys(l.section, blocks.get(l.block)).find(
        (s) => s.key.toLowerCase() === l.key!.toLowerCase(),
      );
      emit("Unknown key; retained unchanged.", "warning", fix?.key);
      continue;
    }
    const id = `${l.block}:${l.key}`;
    if (seen.has(id)) emit("Duplicate key in this section.", "warning");
    seen.add(id);
    const v = valueOf(l.value),
      nums = v.split(",").map((x) => Number(x.trim()));
    const numeric = (integer = false) =>
      nums.every(
        (n, i) =>
          v.split(",")[i].trim() !== "" &&
          Number.isFinite(n) &&
          (!integer || Number.isInteger(n)) &&
          (s.min === undefined || n >= s.min),
      );
    if (s.type === "enum" && !s.enum?.includes(v))
      emit(`Expected ${s.enum?.join(" / ")}.`);
    if (
      ["integer", "number", "integers", "numbers"].includes(s.type) &&
      (!numeric(s.type.includes("integer")) ||
        (!s.type.endsWith("s") && nums.length !== 1)) &&
      !(s.key === "AnimationFramerate" && v === "-1")
    )
      emit(`Expected ${s.type}${s.min !== undefined ? ` ≥ ${s.min}` : ""}.`);
    if (
      ["rgb", "rgba"].includes(s.type) &&
      (!(s.type === "rgba" ? [3, 4] : [3]).includes(nums.length) ||
        !numeric(true) ||
        nums.some((n) => n < 0 || n > 255))
    )
      emit(
        "Expected RGB channels 0–255" +
          (s.type === "rgba" ? " with optional alpha 0–255." : "."),
      );
    if (s.since && version < s.since)
      emit(`Requires Version ${s.since} or higher.`, "warning");
    const count = blocks.get(l.block);
    if (count && s.columns !== undefined && nums.length !== count + s.columns)
      emit(
        `Expected ${count + s.columns} values for Keys: ${count}; missing values use defaults, extras are ignored.`,
        "warning",
      );
    if (count && s.indexBase !== undefined) {
      const index = Number(l.key.match(/\d+/)?.[0]);
      if (index < s.indexBase || index >= count + s.indexBase)
        emit(`Column index outside this ${count}-key layout.`);
    }
    if (
      files &&
      (s.type === "image" || s.type === "prefix") &&
      v &&
      !hasAsset(v, files, imageLookupKind(l.section, l.key))
    )
      emit(
        s.type === "prefix"
          ? "Missing digit image(s): prefix requires -0 through -9 (normal or @2x)."
          : imageLookupKind(l.section, l.key) === "animation"
            ? "Missing image (PNG, including @2x / first animation frame)."
            : "Missing image (PNG texture, including @2x).",
        "warning",
      );
  }
  return out;
}
export function documentation(s: Spec): string {
  return `**${s.key}** · [${s.section}]\n\n${s.type}${s.enum ? ": " + s.enum.join(" / ") : ""}${s.min !== undefined ? " · minimum " + s.min : ""}${s.default !== undefined ? "\n\nDefault: `" + s.default + "`" : ""}${s.since ? "\n\nRequires Version " + s.since : ""}${s.columns !== undefined ? "\n\nList length: Keys " + (s.columns >= 0 ? "+" : "") + s.columns : ""}${s.type === "image" ? "\n\nSkin-relative image name, without extension. @2x and animation frame 0 are resolved." : ""}\n\n[osu! wiki reference](https://osu.ppy.sh/wiki/en/Skinning/skin.ini)`;
}
