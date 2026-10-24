import { afterAll, beforeAll, expect, test } from "bun:test";
import fixture from "./fixtures/sylvia-skin.json";
import {
  buildAtlas,
  frameOwner,
  loadScope,
  loadSkin,
  type AtlasSink,
  type Skin,
} from "../src/skin";

/**
 * The user's lazer skin 「シルビア」 v1 (fixed) as file names and PNG sizes
 * (test/fixtures/sylvia-skin.json, no image data). Skin studio's preview
 * switches mania key counts with loadScope; frames of the osu!taiko
 * mascot (pippidonidle0, ... without a dash) were taken for mania images and
 * dropped, so buildAtlas met an animation whose frames were gone and threw
 * ("Cannot destructure property 'u' of 's' as it is undefined").
 */
const skinFiles = new Map(
  Object.entries(
    fixture.files as unknown as Record<string, [number, number]>,
  ).map(([path, size]) => [path.toLowerCase(), size] as const),
);
const resolve = async (file: string): Promise<Blob | null> => {
  const key = file.replace(/\\/g, "/").toLowerCase();
  if (key === "skin.ini") return new Blob([fixture.ini]);
  const size = skinFiles.get(key);
  return size ? new Blob([JSON.stringify(size)]) : null;
};

const saved = {
  bitmap: globalThis.createImageBitmap,
  canvas: globalThis.OffscreenCanvas,
};
beforeAll(() => {
  // Blobs carry their PNG size; bitmaps are stand-ins with that size.
  globalThis.createImageBitmap = (async (blob: Blob) => {
    const [width, height] = JSON.parse(await blob.text());
    return { width, height, close() {} };
  }) as unknown as typeof createImageBitmap;
  // buildAtlas draws into canvases; every call is a no-op here.
  const context = new Proxy({}, { get: () => () => undefined });
  globalThis.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return context;
    }
  } as unknown as typeof OffscreenCanvas;
});
afterAll(() => {
  globalThis.createImageBitmap = saved.bitmap;
  globalThis.OffscreenCanvas = saved.canvas;
});

/** An atlas sink that keeps nothing: enough for buildAtlas's plumbing. */
const sink: AtlasSink = {
  limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
  allocate() {},
  upload() {},
};

const missingFrames = (skin: Skin) =>
  [...(skin.animations ?? [])].flatMap(([name, frames]) =>
    frames.filter((f) => !skin.assets.has(f)).map((f) => `${name} <- ${f}`),
  );

test("frames without a dash belong to their element", () => {
  expect(
    [
      "sliderb3",
      "pippidonidle0",
      "pippidonclear12",
      "lightingN-4",
      "hit300",
    ].map(frameOwner),
  ).toEqual([
    "sliderb",
    "pippidonidle",
    "pippidonclear",
    "lightingN",
    "hit300",
  ]);
});

test("switching mania key counts keeps every animation's frames (1K-10K)", async () => {
  let skin = await loadSkin(resolve, fixture.name, { maniaKeys: [] });
  expect(missingFrames(skin)).toEqual([]);
  expect(skin.animations?.get("pippidonidle")?.length).toBeGreaterThan(1);
  // Every key count, then back to 7K from each (the user's failing switch).
  for (let keys = 1; keys <= 10; keys++)
    for (const k of [keys, 7]) {
      skin = await loadScope(skin, { maniaKeys: [k] });
      expect(missingFrames(skin)).toEqual([]);
      expect(() => buildAtlas(sink, skin)).not.toThrow();
    }
  // The 7K stage's own images are there after the switches.
  const seven = await loadSkin(resolve, fixture.name, { maniaKeys: [7] });
  expect([...skin.assets.keys()].sort()).toEqual(
    [...seven.assets.keys()].sort(),
  );
});

test("an animation missing frames draws what is left, as GetAnimation does", async () => {
  const skin = await loadSkin(resolve, fixture.name, { maniaKeys: [] });
  const frames = skin.animations!.get("pippidonclear")!;
  // Drop a middle frame: lazer stops at the first frame it cannot find.
  skin.assets.delete(frames[2]);
  const { regions } = buildAtlas(sink, skin);
  expect(regions.get("pippidonclear")?.count).toBe(2);
  // No frame left: the plain image (here the first frame's alias) is drawn.
  for (const f of skin.animations!.get("pippidonidle")!) skin.assets.delete(f);
  const again = buildAtlas(sink, skin);
  expect(again.regions.get("pippidonidle")?.count ?? 1).toBe(1);
});
