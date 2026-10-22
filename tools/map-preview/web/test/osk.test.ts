import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { openOsk } from "../src/osk";

/** Minimal ZIP writer: stored or deflated entries, central directory, EOCD. */
function zip(
  entries: { name: string; data: string; deflate?: boolean }[],
): Blob {
  const encoder = new TextEncoder(),
    locals: Uint8Array[] = [],
    centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name),
      raw = encoder.encode(entry.data),
      data = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw,
      local = new Uint8Array(30 + name.length + data.length),
      lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, entry.deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length),
      cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, entry.deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((sum, c) => sum + c.length, 0),
    end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end]);
}

test("stored and deflated entries resolve case-insensitively, including subfolders", async () => {
  const archive = await openOsk(
    zip([
      { name: "skin.ini", data: "[General]\nName: Test\n", deflate: true },
      { name: "HitCircle@2x.png", data: "circle" },
      { name: "Mania/Key1.png", data: "key".repeat(200), deflate: true },
      { name: "Mania/", data: "" },
    ]),
  );
  expect(archive.size).toBe(3);
  expect(await (await archive.resolve("skin.ini"))!.text()).toContain(
    "Name: Test",
  );
  expect(await (await archive.resolve("hitcircle@2x.png"))!.text()).toBe(
    "circle",
  );
  expect(await (await archive.resolve("mania\\key1.png"))!.text()).toBe(
    "key".repeat(200),
  );
  expect(await archive.resolve("approachcircle.png")).toBeNull();
});

test("a single wrapping folder is unwrapped so skin.ini sits at the root", async () => {
  const archive = await openOsk(
    zip([
      { name: "My Skin/skin.ini", data: "[General]" },
      { name: "My Skin/cursor.png", data: "c" },
    ]),
  );
  expect(await archive.resolve("skin.ini")).not.toBeNull();
  expect(await archive.resolve("cursor.png")).not.toBeNull();
});

test("non-archives and empty archives fail with a clear message", async () => {
  await expect(openOsk(new Blob(["not a zip at all"]))).rejects.toThrow(
    "not an .osk skin archive",
  );
  await expect(openOsk(zip([]))).rejects.toThrow("contains no files");
});

test("ZIP64 archives are rejected explicitly rather than misread", async () => {
  const bytes = new Uint8Array(
    await zip([{ name: "a.png", data: "a" }]).arrayBuffer(),
  );
  new DataView(bytes.buffer).setUint32(bytes.length - 6, 0xffffffff, true);
  await expect(openOsk(new Blob([bytes]))).rejects.toThrow("ZIP64");
});
