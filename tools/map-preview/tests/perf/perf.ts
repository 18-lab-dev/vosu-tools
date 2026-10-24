/**
 * Render benchmark for Map preview's playfield: one map, one skin, 1920×1080
 * direct presentation, 600 frames advancing 1/60 s through the map.
 *
 * Query: ?map=<url>&start=<ms>&skin=builtin:<name>|files:<base url>
 *   [&backend=webgpu|webgl2] (default: auto, WebGPU with a WebGL2 fallback)
 *   [&css=WxH] a stage of that CSS size at pixel ratio 1, sized by the shared
 *   playfield rule (playfieldSize), or [&size=WxH] that exact canvas size.
 * The page uses the pipeline every tool draws with (createPlayfield).
 * Result: window.__perf = { backend, adapter, skinMs (decode), atlasMs (atlas
 *   build and upload, GPU finished), compileMs, cpu (renderAt), frame
 *   (renderAt to GPU finished), gpuPass (WebGPU timestamp queries) | null,
 *   drawCalls, textureMB (the skin atlas and frame table) }.
 */
import { parseOsu } from "@vosu-tools/osu-parse";
import {
  builtinLook,
  createPlayfield,
  loadPlayfieldSkin,
  type Backend,
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
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
  };
};

/** The GPU a WebGL2 context reports (unmasked where the browser allows it). */
function webglAdapter(): string {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  if (!gl) return "unknown";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return String(
    gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
  );
}

async function run() {
  const wanted = params.get("backend") as Backend | null;
  // WebGPU: an explicit device with timestamp queries for the pass timings.
  const adapter =
    wanted === "webgl2"
      ? null
      : ((await navigator.gpu?.requestAdapter({
          powerPreference: "high-performance",
        })) ??
        (await navigator.gpu?.requestAdapter({
          powerPreference: "high-performance",
        })));
  if (wanted === "webgpu" && !adapter) throw new Error("No WebGPU adapter");
  const timing = !!adapter?.features.has("timestamp-query");
  const device = await adapter?.requestDevice({
    requiredFeatures: timing ? ["timestamp-query"] : [],
  });
  const map = parseOsu(await (await fetch(params.get("map")!)).text());
  const skinParam = params.get("skin") ?? "builtin:legacy";
  let skinStart = performance.now(),
    skin: Skin;
  if (skinParam.startsWith("builtin:"))
    skin = builtinLook(skinParam.slice(8) as BuiltinSkinName);
  else {
    const base = skinParam.slice(6);
    ({ skin } = await loadPlayfieldSkin(async (name) => {
      const response = await fetch(
        base + name.split("/").map(encodeURIComponent).join("/"),
      );
      return response.ok ? response.blob() : null;
    }));
  }
  const skinMs = performance.now() - skinStart;
  const canvas = document.querySelector("canvas")!;
  const renderer = await createPlayfield({
    canvas,
    device,
    backend: wanted ?? "auto",
  });
  const atlasStart = performance.now();
  renderer.setSkin(skin);
  await renderer.finished();
  const atlasMs = performance.now() - atlasStart;
  const dims = (key: string) => params.get(key)?.split("x").map(Number);
  const css = dims("css"),
    size = dims("size");
  if (css) renderer.fit(css[0], css[1], 1);
  else if (size) renderer.resize(size[0], size[1]);
  // Draw calls per frame.
  let draws = 0;
  if (renderer.backend === "webgpu") {
    const draw = GPURenderPassEncoder.prototype.draw;
    GPURenderPassEncoder.prototype.draw = function (...args) {
      draws++;
      return draw.apply(this, args);
    };
  } else {
    const draw = WebGL2RenderingContext.prototype.drawArraysInstanced;
    WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args) {
      draws++;
      return draw.apply(this, args);
    };
  }
  const compileStart = performance.now();
  renderer.setBeatmap(map, { scrollSpeed: 24 });
  const compileMs = performance.now() - compileStart;
  const querySet =
    timing && device && renderer.backend === "webgpu"
      ? device.createQuerySet({ type: "timestamp", count: 2 })
      : undefined;
  const resolve = querySet
    ? device!.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      })
    : undefined;
  const read = querySet
    ? device!.createBuffer({
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
      const encoder = device!.createCommandEncoder();
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
      device!.queue.submit([encoder.finish()]);
    }
    await renderer.finished();
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
    backend: renderer.backend,
    fallbackReason: renderer.fallbackReason,
    skinMs,
    atlasMs,
    compileMs,
    objects: map.objects.length,
    assets: skin.assets.size,
    adapter:
      renderer.backend === "webgpu"
        ? adapter?.info?.description || adapter?.info?.vendor || "unknown"
        : webglAdapter(),
    cpu: stats(cpu),
    frame: stats(done),
    gpuPass: gpu.length ? stats(gpu) : null,
    drawCalls: stats(drawCalls),
    textureMB: renderer.textureBytes / 2 ** 20,
    canvas: [canvas.width, canvas.height],
  };
}
run().then(
  (result) => (window.__perf = result),
  (error) => (window.__perf = { error: String(error) }),
);
