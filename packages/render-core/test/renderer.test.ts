import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import type { DrawCall, Gpu, RenderTarget } from "../src/gpu";
import { rendererOn } from "../src/renderer";
import type { Skin } from "../src/skin";

/**
 * The renderer on a recording backend: what reaches the GPU, whichever
 * backend that is. (Pixels are compared across WebGPU and WebGL2 in
 * tools/map-preview/tests/backend_parity.py.)
 */
const saved = { canvas: globalThis.OffscreenCanvas };
beforeAll(() => {
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
  globalThis.OffscreenCanvas = saved.canvas;
});

function recordingGpu() {
  const log = {
    instances: new Float32Array(0),
    pages: [] as number[],
    draws: [] as DrawCall[],
  };
  const gpu: Gpu = {
    backend: "webgl2",
    device: null,
    format: "rgba8unorm",
    limits: { maxTextureDimension2D: 2048, maxTextureArrayLayers: 256 },
    lost: new Promise(() => {}),
    textureBytes: 0,
    setAtlas(build) {
      log.pages = [];
      build({
        limits: gpu.limits,
        allocate() {},
        upload: (page) => void log.pages.push(page),
      });
    },
    setInstances(data) {
      log.instances = data;
    },
    resize() {},
    draw(call) {
      // The renderer reuses its arrays from frame to frame.
      log.draws.push({
        ...call,
        uniforms: call.uniforms.slice(),
        chunks: [...call.chunks],
      });
    },
    createTarget: (width, height): RenderTarget => ({
      width,
      height,
      read: async () => new Uint8Array(width * height * 4),
      destroy() {},
    }),
    finished: async () => {},
    destroy() {},
  };
  return { gpu, log };
}

const image = (width: number, height: number) =>
  ({ width, height, close() {} }) as unknown as ImageBitmap;
const skin: Skin = {
  name: "test",
  assets: new Map([
    ["hitcircle", image(128, 128)],
    ["hitcircleoverlay", image(128, 128)],
  ]),
  sections: new Map(),
};
const map = parseOsu(
  "osu file format v14\n[General]\nMode: 0\n[Difficulty]\nCircleSize:4\nApproachRate:9\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,1,0,0:0:0:0:\n",
);

test("a skin's images reach the scene the backend draws", () => {
  const { gpu, log } = recordingGpu();
  const renderer = rendererOn(gpu, "no adapter", { skin }, 1280, 720);
  expect(renderer.backend).toBe("webgl2");
  expect(renderer.fallbackReason).toBe("no adapter");
  const textured = () => {
    let count = 0;
    for (let i = 0; i < log.instances.length / 24; i++)
      if (log.instances[i * 24 + 20] === 10) count++;
    return count;
  };
  renderer.setBeatmap(map);
  const withSkin = textured();
  // Without the skin only the default combo digits are images: the hit
  // circle and its overlay were the skin's.
  renderer.setSkin(undefined);
  expect(withSkin).toBe(textured() + 2);
  expect(log.pages.length).toBeGreaterThan(0);
});

test("frames go to the canvas or to an offscreen target, visible chunks only", () => {
  const { gpu, log } = recordingGpu();
  const renderer = rendererOn(gpu, null, { skin }, 1280, 720);
  renderer.setBeatmap(map);
  const target = renderer.createTarget(640, 360);
  expect([target.width, target.height]).toEqual([640, 360]);
  renderer.renderAt(1000, { target });
  renderer.renderAt(-1e9, { target });
  const [onTarget, early] = log.draws;
  expect(onTarget.target).toBe(target);
  expect(onTarget.chunks.length).toBeGreaterThan(0);
  expect(onTarget.uniforms[0]).toBe(1000);
  expect([onTarget.uniforms[1], onTarget.uniforms[2]]).toEqual([1280, 720]);
  // Long before the map, its objects' chunks are skipped.
  expect(early.chunks.length).toBeLessThan(onTarget.chunks.length);
});
