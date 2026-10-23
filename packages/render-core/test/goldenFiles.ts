/**
 * Files for the golden layout runs: solid PNG stand-ins of given sizes for
 * synthetic skins, and the PNG sizes and skin.ini of real skin folders.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import type { GoldenSkin } from "./maniaCompare";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A solid translucent RGBA PNG of the given size. */
export function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length),
      view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rows.set([200, 120, 60, 160], y * (width * 4 + 1) + 1 + x * 4);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** PNG sizes and skin.ini of a real skin folder. */
export function readSkinFolder(folder: string, name: string): GoldenSkin {
  const files: Record<string, [number, number]> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.png$/i.test(entry)) {
        const bytes = readFileSync(path);
        if (bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR")
          files[relative(folder, path)] = [
            bytes.readUInt32BE(16),
            bytes.readUInt32BE(20),
          ];
      }
    }
  };
  walk(folder);
  const ini = readdirSync(folder).find((f) => f.toLowerCase() === "skin.ini");
  return {
    name,
    ini: ini
      ? readFileSync(join(folder, ini), "utf8").replace(/^\uFEFF/, "")
      : undefined,
    files,
  };
}
