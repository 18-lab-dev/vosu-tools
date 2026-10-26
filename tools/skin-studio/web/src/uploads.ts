// Image files dropped from the desktop: checked before they are sent to the
// service (which checks them again) and grouped into images the way skins
// name them: `name@2x` is the same image, `name-0`, `name-1`, … its frames.

import type { Keymodes } from "./keymodes";

/**
 * The largest file accepted: vosu forwards at most 1 MiB of request body to
 * a tool (`MAX_POST_BODY` in vosu's src/server/routes.rs); the service's
 * `uploads::MAX_BYTES` is the same.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024;

export interface Dropped {
  name: string;
  size: number;
  /** The file's first bytes (at least 8). */
  head: Uint8Array;
}
/** A dropped image: its files with what each adds to `name`. */
export interface DroppedImage {
  name: string;
  files: { index: number; name: string; suffix: string }[];
}

const RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const starts = (head: Uint8Array, magic: number[]) =>
  magic.every((byte, i) => head[i] === byte);

/**
 * The name a dropped file is stored under, or an error: names with a path
 * (`/`, `\`, `..`) are refused, characters Windows does not allow become
 * `_`, and a reserved device name gets a `_`.
 */
export function droppedName(name: string): { name: string } | { error: string } {
  if (/[/\\]/.test(name) || name.includes(".."))
    return { error: `${name}: a file name, not a path` };
  if (/[\u0000-\u001f\u007f]/.test(name))
    return { error: `${name}: control characters in the name` };
  const ext = /\.(png|jpe?g)$/i.exec(name)?.[0];
  if (!ext) return { error: `${name}: only PNG and JPEG images` };
  let stem = name
    .slice(0, -ext.length)
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!stem) return { error: `${name}: no name before the extension` };
  if (RESERVED.test(stem)) stem += "_";
  const out = `${stem}${ext}`;
  return out.length > 120 ? { error: `${name}: name over 120 characters` } : { name: out };
}

/**
 * Checks dropped files and groups them into images. Every file must be a
 * PNG or JPEG whose content matches its extension, non-empty and at most
 * {@link MAX_UPLOAD_BYTES}; frames of one image run `-0`, `-1`, … without
 * gaps. Files that fail are reported, the rest grouped.
 */
export function checkDrop(files: readonly Dropped[]): {
  images: DroppedImage[];
  errors: string[];
} {
  const errors: string[] = [];
  const named: { index: number; name: string; stem: string }[] = [];
  files.forEach((file, index) => {
    const checked = droppedName(file.name);
    if ("error" in checked) return errors.push(checked.error);
    const jpeg = /\.jpe?g$/i.test(checked.name);
    if (!starts(file.head, jpeg ? JPEG : PNG))
      return errors.push(`${file.name} is not a ${jpeg ? "JPEG" : "PNG"} image`);
    if (file.size === 0) return errors.push(`${file.name} is empty`);
    if (file.size > MAX_UPLOAD_BYTES)
      return errors.push(
        `${file.name} is ${(file.size / 1048576).toFixed(1)} MiB; at most 1 MiB`,
      );
    const twin = named.find((f) => f.name.toLowerCase() === checked.name.toLowerCase());
    if (twin)
      return errors.push(`${file.name}: same name as ${twin.name} apart from case`);
    named.push({
      index,
      name: checked.name,
      stem: checked.name.replace(/\.[^.]+$/, "").replace(/@2x$/i, ""),
    });
  });
  const stems = new Set(named.map((f) => f.stem.toLowerCase()));
  const images = new Map<string, DroppedImage>();
  for (const file of named) {
    const frame = /^(.*)-(\d+)$/.exec(file.stem);
    // A frame only when its sequence starts here (`name-0` was dropped too).
    const name =
      frame && stems.has(`${frame[1]}-0`.toLowerCase()) ? frame[1] : file.stem;
    const key = name.toLowerCase();
    const image = images.get(key) ?? { name, files: [] };
    image.files.push({
      index: file.index,
      name: file.name,
      suffix: file.name.slice(name.length),
    });
    images.set(key, image);
  }
  for (const image of images.values()) {
    const frames = new Set(
      image.files.flatMap((f) => /^-(\d+)/.exec(f.suffix)?.[1] ?? []).map(Number),
    );
    for (let i = 0; i < frames.size; i++)
      if (!frames.has(i)) {
        errors.push(`${image.name}: frames must run -0, -1, … without gaps (no -${i})`);
        images.delete(image.name.toLowerCase());
        break;
      }
  }
  return { images: [...images.values()], errors };
}

/** The library key of dropped files (the service's `uploads::KEY`). */
export const UPLOADS = "uploads:";

export interface UploadFile {
  /** `<drop>/<name>` under {@link UPLOADS}. */
  name: string;
  size: number;
}
/**
 * Dropped files split by whether the draft uses them: a Keymodes slot
 * copies the file (frames and `@2x` included). Only images are listed.
 */
export function uploadUsage(
  files: readonly UploadFile[],
  keymodes: Keymodes,
): { used: UploadFile[]; unused: UploadFile[] } {
  const referenced = new Set<string>();
  for (const draft of Object.values(keymodes))
    for (const slot of Object.values(draft.images))
      if (slot && "files" in slot && slot.skin === UPLOADS)
        for (const file of slot.files) referenced.add(file.from.toLowerCase());
  const images = files.filter((f) => /\.(png|jpe?g)$/i.test(f.name));
  return {
    used: images.filter((f) => referenced.has(f.name.toLowerCase())),
    unused: images.filter((f) => !referenced.has(f.name.toLowerCase())),
  };
}

/** `1.2 MB`, `34 KB`, `512 B`. */
export const formatBytes = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

/** The question asked before unused dropped files are deleted. */
export function removeQuestion(unused: readonly UploadFile[]): string {
  const size = formatBytes(unused.reduce((sum, f) => sum + f.size, 0));
  return `Delete ${unused.length} dropped ${unused.length === 1 ? "file" : "files"} (${size}) that this draft does not use?\n\nOther open Skin studio tabs or saved drafts in other browsers may still use these. Deleted files cannot be restored.`;
}
