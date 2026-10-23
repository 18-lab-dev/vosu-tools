import { expect, test } from "bun:test";
import { LAZER_MAX_TEXTURE_SIZE, loadSkin } from "../src";

// Bun has no createImageBitmap: blobs carry their "pixel size" as text.
globalThis.createImageBitmap = (async (blob: Blob) => {
  const [width, height] = (await blob.text()).split("x").map(Number);
  return { width, height, close() {} };
}) as unknown as typeof createImageBitmap;

const files: Record<string, string> = {
  "skin.ini":
    "[General]\nVersion: 2.7\n[Mania]\nKeys: 4\nNoteImage0L: body/huge\nNoteImage1L: body/tall\n",
  "body/huge.png": `138x${LAZER_MAX_TEXTURE_SIZE + 1}`,
  "body/tall.png": `50x${LAZER_MAX_TEXTURE_SIZE}`,
  "hitcircle@2x.png": `40000x40000`,
  "hitcircle.png": `128x128`,
};
const resolve = async (name: string) =>
  name in files ? new Blob([files[name]]) : null;

test("images beyond lazer's GPU limit are kept but drawn black", async () => {
  const skin = await loadSkin(resolve, "limit");
  // osu!framework only size-checks partial uploads: lazer keeps the texture,
  // its GL upload fails and it samples opaque black.
  expect(skin.assets.has("body/huge")).toBe(true);
  expect(skin.blank!.size).toBe(2);
  expect(skin.blank!.has("body/huge")).toBe(true);
  expect(skin.blank!.has("body/tall")).toBe(false);
  // No fallback from an oversized @2x to the 1x image either.
  expect(skin.assets.get("hitcircle")?.width).toBe(40000);
  expect(skin.pixelScale?.get("hitcircle")).toBe(2);
  expect(skin.blank!.has("hitcircle")).toBe(true);
});

test("the limit follows the client's GPU when given", async () => {
  const skin = await loadSkin(resolve, "limit", { maxTextureSize: 4096 });
  expect(skin.blank!.has("body/tall")).toBe(true);
  expect(skin.blank!.size).toBe(3);
});
