/**
 * Render benchmark for Map preview's playfield: one map, one skin, 1920×1080
 * direct WebGPU presentation, 600 frames advancing 1/60 s through the map.
 *
 * Query: ?map=<url>&start=<ms>&skin=builtin:<name>|files:<base url>
 * Result: window.__perf = { skinMs, compileMs, cpu, gpuPass | null, drawCalls,
 *   textureMB } (draw calls per frame; GPU textures the renderer created).
 */
import { parseOsu } from "@vosu-tools/osu-parse";
import {
  builtinSkin,
  createRenderer,
  loadSkin,
  withFallback,
  type BuiltinSkinName,
  type Skin,
} from "@vosu-tools/render-core";

declare global {
  interface Window {
    __perf?: unknown;
  }
}
const params = new URLSearchParams(location.search);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
  };
};

async function run() {
  const adapter =
    (await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    })) ??
    (await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    }));
  if (!adapter) throw new Error("No WebGPU adapter");
  const timing = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: timing ? ["timestamp-query"] : [],
  });
  const map = parseOsu(await (await fetch(params.get("map")!)).text());
  const skinParam = params.get("skin") ?? "builtin:legacy";
  let skinStart = performance.now(),
    skin: Skin;
  if (skinParam.startsWith("builtin:"))
    skin = builtinSkin(skinParam.slice(8) as BuiltinSkinName);
  else {
    const base = skinParam.slice(6);
    const loaded = await loadSkin(async (name) => {
      const response = await fetch(
        base + name.split("/").map(encodeURIComponent).join("/"),
      );
      return response.ok ? response.blob() : null;
    });
    skin = withFallback(loaded, builtinSkin("legacy"));
  }
  const skinMs = performance.now() - skinStart;
  const canvas = document.querySelector("canvas")!;
  // Texture memory the renderer allocates (atlas pages included).
  let textureBytes = 0;
  const createTexture = device.createTexture.bind(device);
  device.createTexture = (descriptor) => {
    const [w, h = 1, layers = 1] = [...(descriptor.size as Iterable<number>)];
    textureBytes += w * h * layers * 4;
    return createTexture(descriptor);
  };
  const renderer = await createRenderer({ canvas, device, skin });
  // Draw calls per frame.
  let draws = 0;
  const draw = GPURenderPassEncoder.prototype.draw;
  GPURenderPassEncoder.prototype.draw = function (...args) {
    draws++;
    return draw.apply(this, args);
  };
  const compileStart = performance.now();
  renderer.setBeatmap(map, { scrollSpeed: 24 });
  const compileMs = performance.now() - compileStart;
  const querySet = timing
    ? device.createQuerySet({ type: "timestamp", count: 2 })
    : undefined;
  const resolve = timing
    ? device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      })
    : undefined;
  const read = timing
    ? device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
    : undefined;
  const cpu: number[] = [],
    gpu: number[] = [],
    done: number[] = [],
    drawCalls: number[] = [];
  let time = Number(params.get("start") ?? 0);
  for (let frame = 0; frame < 660; frame++, time += 1000 / 60) {
    const start = performance.now();
    draws = 0;
    renderer.renderAt(time, {
      timestampWrites: querySet
        ? { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
        : undefined,
    });
    const submitted = performance.now();
    if (querySet && resolve && read) {
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
      device.queue.submit([encoder.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    const finished = performance.now();
    if (read) {
      await read.mapAsync(GPUMapMode.READ);
      const [begin, end] = new BigUint64Array(read.getMappedRange());
      if (frame >= 60) gpu.push(Number(end - begin) / 1e6);
      read.unmap();
    }
    // The first 60 frames warm pipelines and caches.
    if (frame >= 60) {
      cpu.push(submitted - start);
      drawCalls.push(draws);
      done.push(finished - start);
    }
    const frameDone = Promise.withResolvers<number>();
    requestAnimationFrame(frameDone.resolve);
    await frameDone.promise;
  }
  return {
    skinMs,
    compileMs,
    objects: map.objects.length,
    assets: skin.assets.size,
    adapter: adapter.info?.description || adapter.info?.vendor || "unknown",
    cpu: stats(cpu),
    submitToGpuDone: stats(done),
    gpuPass: gpu.length ? stats(gpu) : null,
    drawCalls: stats(drawCalls),
    textureMB: textureBytes / 2 ** 20,
  };
}
run().then(
  (result) => (window.__perf = result),
  (error) => (window.__perf = { error: String(error) }),
);
