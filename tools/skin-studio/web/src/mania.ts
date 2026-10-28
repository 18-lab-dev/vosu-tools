// Mania image lookups over a skin's file list: which files a `[Mania]` image
// lookup reads, the way the clients find them (case-insensitively, `@2x`
// first, an animation's frames `name-0`, `name-1`, … before a plain image).

import type { HasImage } from "@vosu-tools/render-core/mania";
import { imageExt } from "./groups";

/** A skin's image files by lower-cased name without extension and `@2x`. */
export function imageIndex(files: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    if (!imageExt.test(file)) continue;
    const name = file
      .replace(/\\/g, "/")
      .replace(/\.[^./]+$/, "")
      .replace(/@2x$/i, "")
      .toLowerCase();
    index.set(name, [...(index.get(name) ?? []), file]);
  }
  return index;
}

/** {@link HasImage} over a file index. */
export const hasImage =
  (index: ReadonlyMap<string, string[]>): HasImage =>
  (name, animated) => {
    const lower = name.toLowerCase();
    return index.has(lower) || (animated && index.has(`${lower}-0`));
  };

/** The consecutive frames `name-0`, `name-1`, … of an image (lower-cased names). */
export function frameNames(
  index: ReadonlyMap<string, string[]>,
  name: string,
): string[] {
  const out: string[] = [];
  const lower = name.toLowerCase();
  while (index.has(`${lower}-${out.length}`)) out.push(`${lower}-${out.length}`);
  return out;
}

/** Every file of an editable image unit, including a plain animation fallback. */
export function imageUnitFiles(index: ReadonlyMap<string, string[]>, name: string): string[] {
  return [name.toLowerCase(), ...frameNames(index, name)].flatMap((n) => index.get(n) ?? []);
}

/**
 * The files a lookup of `name` reads: an animated lookup's frames when the
 * first exists, else the plain image; each with its `@2x` variant.
 */
export function lookupFiles(
  index: ReadonlyMap<string, string[]>,
  name: string,
  animated: boolean,
): string[] {
  const frames = animated ? frameNames(index, name) : [];
  const names = frames.length ? frames : [name.toLowerCase()];
  return names.flatMap((n) => index.get(n) ?? []);
}

/**
 * `name` in the case of the files a lookup of it found (`lookupFiles`): the
 * clients match case-insensitively, the copy keeps the source's spelling.
 */
export const lookupName = (files: readonly string[], name: string) =>
  files[0].replace(/\\/g, "/").slice(0, name.length);
