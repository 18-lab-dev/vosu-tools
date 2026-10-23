import { expect, test } from "bun:test";
import { loadSkin } from "../src";

const LIMIT = 32768;

// Bun has no createImageBitmap: blobs carry their "pixel size" as text.
globalThis.createImageBitmap = (async (blob: Blob) => {
  const [width, height] = (await blob.text()).split("x").map(Number);
  return { width, height, close() {} };
}) as unknown as typeof createImageBitmap;

const files: Record<string, string> = {
  "skin.ini":
    "[General]\nVersion: 2.7\n[Mania]\nKeys: 4\nNoteImage0L: body/huge\nNoteImage1L: body/tall\n",
  "body/huge.png": `138x${LIMIT + 1}`,
  "body/tall.png": `50x${LIMIT}`,
  "hitcircle@2x.png": `40000x40000`,
  "hitcircle.png": `128x128`,
};
const resolve = async (name: string) =>
  name in files ? new Blob([files[name]]) : null;

test("oversized images draw normally unless a limit is given", async () => {
  const skin = await loadSkin(resolve, "limit");
  expect(skin.assets.has("body/huge")).toBe(true);
  expect(skin.blank!.size).toBe(0);
});

test("a given limit marks larger images blank, with no @2x fallback", async () => {
  const skin = await loadSkin(resolve, "limit", { maxTextureSize: LIMIT });
  expect(skin.blank!.has("body/huge")).toBe(true);
  expect(skin.blank!.has("body/tall")).toBe(false);
  expect(skin.assets.get("hitcircle")?.width).toBe(40000);
  expect(skin.pixelScale?.get("hitcircle")).toBe(2);
  expect(skin.blank!.has("hitcircle")).toBe(true);
  expect(skin.blank!.size).toBe(2);
});
