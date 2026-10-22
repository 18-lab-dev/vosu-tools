/**
 * Reads osu! skin archives (.osk, a ZIP file) entirely in the browser.
 * Entries are indexed from the central directory and inflated on demand, so
 * only the elements the renderer asks for are decompressed.
 */
export interface SkinArchive {
  /** Number of file entries (directories excluded). */
  readonly size: number;
  /** Looks up a skin-relative path case-insensitively, inflating on demand. */
  resolve(path: string): Promise<Blob | null>;
}

interface Entry {
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

const EOCD = 0x06054b50,
  CENTRAL = 0x02014b50,
  LOCAL = 0x04034b50,
  ZIP64 = 0xffffffff;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export async function openOsk(file: Blob): Promise<SkinArchive> {
  const bytes = new Uint8Array(await file.arrayBuffer()),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  if (end < 0)
    throw new Error(
      "This file is not an .osk skin archive (no ZIP directory found).",
    );
  const count = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === ZIP64 || directoryOffset === ZIP64)
    throw new Error(
      "ZIP64 .osk archives are not supported; re-export the skin from osu!.",
    );
  if (directoryOffset + directorySize > end)
    throw new Error("This .osk archive is truncated or damaged.");
  const decoder = new TextDecoder(),
    entries = new Map<string, Entry>();
  let cursor = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== CENTRAL)
      throw new Error("This .osk archive is truncated or damaged.");
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      compressedSize = view.getUint32(cursor + 20, true),
      nameLength = view.getUint16(cursor + 28, true),
      extraLength = view.getUint16(cursor + 30, true),
      commentLength = view.getUint16(cursor + 32, true),
      localOffset = view.getUint32(cursor + 42, true),
      name = decoder.decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      );
    cursor += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === ZIP64 || localOffset === ZIP64)
      throw new Error(
        "ZIP64 .osk archives are not supported; re-export the skin from osu!.",
      );
    if (name.endsWith("/") || name.endsWith("\\")) continue;
    entries.set(normalize(name), {
      method,
      flags,
      compressedSize,
      localOffset,
    });
  }
  // Archives zipped from a parent directory wrap every file in one folder.
  const paths = [...entries.keys()],
    root = paths[0]?.split("/")[0];
  if (
    paths.length &&
    !entries.has("skin.ini") &&
    paths.every((path) => path.includes("/") && path.split("/")[0] === root)
  ) {
    const unwrapped = new Map<string, Entry>();
    for (const [path, entry] of entries)
      unwrapped.set(path.slice(root!.length + 1), entry);
    entries.clear();
    for (const [path, entry] of unwrapped) entries.set(path, entry);
  }
  if (!entries.size) throw new Error("This .osk archive contains no files.");

  async function inflate(entry: Entry): Promise<Blob | null> {
    const at = entry.localOffset;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL)
      throw new Error("This .osk archive is truncated or damaged.");
    const start =
        at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true),
      data = bytes.subarray(start, start + entry.compressedSize);
    // Encrypted entries and exotic compression methods are not part of skins
    // exported by osu!; treat them like missing elements.
    if (entry.flags & 1) return null;
    if (entry.method === 0) return new Blob([data]);
    if (entry.method !== 8) return null;
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).blob();
  }

  return {
    size: entries.size,
    async resolve(path) {
      const entry = entries.get(normalize(path));
      return entry ? inflate(entry) : null;
    },
  };
}
