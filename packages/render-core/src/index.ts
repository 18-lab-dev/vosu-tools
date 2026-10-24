import { init } from "vgpu";
import {
  applyMods,
  scrollPosition,
  type Beatmap,
  type Mod,
} from "@vosu-tools/osu-parse";
import { legacyBool } from "./osu";
import { buildAtlas, regionInstances, type Skin } from "./skin";
import { CursorModel, PLAYFIELD_SHIFT, pressIntervals } from "./gameplay";
import { compileScene, type RenderOptions, type Scene } from "./scene";
import { shader } from "./shader";
export {
  loadSkin,
  loadManiaKeys,
  maniaImageNames,
  assetNames,
  legacySliderStyle,
} from "./skin";
export { maniaKeysFor } from "./scene";
export type { Skin, SkinStyle, LoadSkinOptions } from "./skin";
export { builtinSkin, builtinSkinNames, withFallback } from "./builtin";
export type { BuiltinSkinName } from "./builtin";
export type { RenderOptions, Scene, InputFrame } from "./scene";
export type { JudgementEvent } from "./judgements";
export interface FrameState {
  target?: GPUTextureView;
  timestampWrites?: GPURenderPassTimestampWrites;
  captureTarget?: GPUTexture;
  cursor?: { x: number; y: number; pressed?: boolean; scale?: number };
  cursorTrail?: readonly {
    x: number;
    y: number;
    opacity: number;
    scale?: number;
  }[];
  keys?: readonly boolean[];
  failed?: boolean;
}
export interface RendererOptions {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  device?: GPUDevice;
  format?: GPUTextureFormat;
  width?: number;
  height?: number;
  skin?: Skin;
  presentation?: "direct" | "bitmap";
  clearColour?: GPUColor;
  transparentBackground?: boolean;
}
/** renderAt receives absolute beatmap milliseconds, never wall-clock time. */
export interface Renderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  setBeatmap(map: Beatmap, options?: RenderOptions): void;
  setSkin(skin?: Skin): void;
  renderAt(timeMs: number, frame?: FrameState): void;
  resize(width: number, height: number): void;
  destroy(): void;
}
export async function createRenderer(
  options: RendererOptions,
): Promise<Renderer> {
  const gpu = options.device ? null : await init(),
    device = options.device ?? gpu!.device.gpu,
    format =
      options.format ??
      (options.canvas
        ? navigator.gpu.getPreferredCanvasFormat()
        : "rgba8unorm");
  const presentation =
    options.canvas && options.presentation === "bitmap"
      ? new OffscreenCanvas(
          options.width ?? options.canvas.width,
          options.height ?? options.canvas.height,
        )
      : undefined;
  const bitmap = presentation
    ? (options.canvas!.getContext(
        "bitmaprenderer",
      ) as ImageBitmapRenderingContext)
    : null;
  if (presentation && !bitmap)
    throw new Error("Bitmap presentation is unavailable");
  const context = (presentation ?? options.canvas)?.getContext(
    "webgpu",
  ) as GPUCanvasContext | null;
  context?.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  let width = options.width ?? options.canvas?.width ?? 1920,
    height = options.height ?? options.canvas?.height ?? 1080,
    skin = options.skin,
    atlas = buildAtlas(device, skin),
    scene: Scene | undefined,
    map: Beatmap | undefined,
    original: Beatmap | undefined,
    settings: RenderOptions = {},
    aspect = width / height;
  let keyIntervals: { start: number; end: number }[][] = [];
  let holdIntervals: { start: number; end: number }[][] = [];
  /** Key images (LegacyKeyArea) stay pressed 80 ms after a release. */
  let keyImageIntervals: { start: number; end: number }[][] = [];
  function activeMask(
    columns: readonly (readonly { start: number; end: number }[])[],
    time: number,
  ): number {
    let result = 0;
    for (let lane = 0; lane < columns.length; lane++) {
      const intervals = columns[lane];
      let lo = 0,
        hi = intervals.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (intervals[mid].start <= time) lo = mid + 1;
        else hi = mid;
      }
      if (lo && intervals[lo - 1].end >= time) result |= 1 << lane;
    }
    return result;
  }
  /** The catcher's hyper-dash tint: 180 ms fades in and out (lazer's OutQuint, approximated linearly). */
  function hyperAmount(
    intervals: readonly { start: number; end: number }[],
    time: number,
  ): number {
    let lo = 0,
      hi = intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (intervals[mid].start <= time) lo = mid + 1;
      else hi = mid;
    }
    const last = intervals[lo - 1];
    if (!last) return 0;
    // Catcher.runHyperDashStateTransition: FadeColour over 180 ms, out quint.
    const ease = (t: number) =>
      1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 5);
    return time <= last.end
      ? ease((time - last.start) / 180)
      : ease((last.end - last.start) / 180) *
          (1 - ease((time - last.end) / 180));
  }
  /** The catcher's state from the last result at or before `time` (idle before any). */
  function stateAt(
    states: readonly { time: number; state: number }[],
    time: number,
  ): number {
    let lo = 0,
      hi = states.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (states[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    return states[lo - 1]?.state ?? 0;
  }
  const uniforms = new Float32Array(24),
    uniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    }),
    module = device.createShaderModule({ code: shader });
  const compilation = await module.getCompilationInfo();
  const shaderErrors = compilation.messages.filter((m) => m.type === "error");
  if (shaderErrors.length) {
    atlas.texture.destroy();
    uniformBuffer.destroy();
    context?.unconfigure();
    gpu?.dispose();
    throw new Error(
      shaderErrors
        .map((m) => `WGSL ${m.lineNum}:${m.linePos}: ${m.message}`)
        .join("\n"),
    );
  }
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: "2d-array" },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      {
        binding: 3,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  const pipeline = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 96,
          stepMode: "instance",
          attributes: Array.from({ length: 6 }, (_, i) => ({
            shaderLocation: i,
            offset: i * 16,
            format: "float32x4" as GPUVertexFormat,
          })),
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  function makeRegions(): GPUBuffer {
    const buffer = device.createBuffer({
      size: Math.max(16, atlas.frames.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, atlas.frames);
    return buffer;
  }
  let regionBuffer = makeRegions();
  function makeBindings(): GPUBindGroup {
    return device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        {
          binding: 1,
          resource: atlas.texture.createView({ dimension: "2d-array" }),
        },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: regionBuffer } },
      ],
    });
  }
  let bindings = makeBindings(),
    instances: GPUBuffer | undefined;
  const overlays = new Float32Array(24 * 512),
    overlayBuffer = device.createBuffer({
      size: overlays.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  const attachment: GPURenderPassColorAttachment = {
      view: undefined as unknown as GPUTextureView,
      loadOp: "clear",
      storeOp: "store",
      clearValue:
        options.clearColour ??
        (options.transparentBackground
          ? { r: 0, g: 0, b: 0, a: 0 }
          : { r: 0.012, g: 0.014, b: 0.02, a: 1 }),
    },
    passDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [attachment],
    },
    commands: GPUCommandBuffer[] = [];
  function writeCursor(
    index: number,
    x: number,
    y: number,
    size: number,
    alpha: number,
    time: number,
  ): void {
    const b = index * 24;
    overlays.fill(0, b, b + 24);
    overlays[b] = x;
    overlays[b + 1] = y;
    overlays[b + 2] = size;
    overlays[b + 3] = size;
    overlays[b + 4] = time;
    overlays[b + 5] = time;
    overlays[b + 6] = -1e9;
    overlays[b + 7] = 1e9;
    overlays[b + 8] = 1;
    overlays[b + 9] = 0.8;
    overlays[b + 10] = 0.2;
    overlays[b + 11] = alpha;
  }
  /** A textured per-frame sprite (kind 35, Profile.sprite); returns the next index. */
  function writeSprite(
    index: number,
    asset: string,
    x: number,
    y: number,
    w: number,
    h: number,
    angle: number,
    alpha: number,
    additive: boolean,
    time: number,
  ): number {
    const region = atlas.regions.get(asset);
    if (!region) return index;
    for (const { entry, uv } of regionInstances(region, true)) {
      if (index >= 512) break;
      overlays.set(
        [x, y, w, h, time, time, -1e9, 1e9, 1, 1, 1, alpha, 35, 27, angle, 0,
          uv.u, uv.v, uv.w, uv.h, additive ? 13 : 10, entry, 0, 0],
        index++ * 24,
      );
    }
    return index;
  }
  /** osu!: the replay's cursor with the skin's images (setBeatmap's `input`). */
  let cursorModel: CursorModel | undefined;
  let disposed = false;
  const renderer: Renderer = {
    device,
    format,
    setBeatmap(source, opts = {}) {
      if (disposed) throw new Error("Renderer was destroyed");
      original = source;
      settings = opts;
      map = applyMods(source, opts.mods ?? [], { ar: opts.ar, cs: opts.cs });
      aspect = width / height;
      scene = compileScene(map, opts, atlas.regions, skin, aspect);
      keyIntervals =
        map.mode === 3
          ? Array.from({ length: Math.round(map.difficulty.cs) }, () => [])
          : [];
      holdIntervals = keyIntervals.map(() => []);
      if (map.mode === 3 && opts.input)
        keyIntervals = pressIntervals(opts.input, keyIntervals.length);
      else if (map.mode === 3)
        for (const object of map.objects) {
          const lane = Math.min(
              keyIntervals.length - 1,
              Math.floor((object.x * keyIntervals.length) / 512),
            ),
            intervals = keyIntervals[lane],
            last = intervals[intervals.length - 1];
          if (last && last.end >= object.time)
            last.end = Math.max(last.end, object.endTime + 45);
          else intervals.push({ start: object.time, end: object.endTime + 45 });
          if (object.endTime > object.time) {
            const holds = holdIntervals[lane],
              previous = holds[holds.length - 1];
            if (previous && previous.end >= object.time)
              previous.end = Math.max(previous.end, object.endTime);
            else holds.push({ start: object.time, end: object.endTime });
          }
        }
      if (map.mode === 3 && opts.input)
        for (const object of map.objects) {
          if (object.endTime <= object.time) continue;
          const lane = Math.min(
              holdIntervals.length - 1,
              Math.floor((object.x * holdIntervals.length) / 512),
            ),
            holds = holdIntervals[lane],
            previous = holds[holds.length - 1];
          if (previous && previous.end >= object.time)
            previous.end = Math.max(previous.end, object.endTime);
          else holds.push({ start: object.time, end: object.endTime });
        }
      const general = skin?.sections.get("General")?.[0] ?? {},
        flag = (key: string) => legacyBool(general[key]) ?? true;
      cursorModel =
        map.mode === 0 && opts.input && atlas.regions.has("cursor")
          ? new CursorModel(opts.input, {
              size: (asset) => {
                const r = atlas.regions.get(asset);
                return r ? [r.width ?? 0, r.height ?? 0] : undefined;
              },
              centre: flag("CursorCentre"),
              rotate: flag("CursorRotate"),
              expand: flag("CursorExpand"),
              trailRotate: flag("CursorTrailRotate"),
            })
          : undefined;
      keyImageIntervals = opts.input
        ? keyIntervals.map((column) =>
            column.map(({ start, end }) => ({ start, end: end + 80 })),
          )
        : keyIntervals;
      instances?.destroy();
      instances = device.createBuffer({
        size: Math.max(96, scene.data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      if (scene.data.length) device.queue.writeBuffer(instances, 0, scene.data);
    },
    setSkin(next) {
      const previous = atlas;
      skin = next;
      atlas = buildAtlas(device, next);
      const previousRegions = regionBuffer;
      regionBuffer = makeRegions();
      bindings = makeBindings();
      if (original) renderer.setBeatmap(original, settings);
      previous.texture.destroy();
      previousRegions.destroy();
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      // osu!taiko's playfield follows the window's aspect ratio, as in lazer.
      if (
        original &&
        map?.mode === 1 &&
        Math.abs(width / height - aspect) > 1e-6
      )
        renderer.setBeatmap(original, settings);
      if (options.canvas) {
        options.canvas.width = width;
        options.canvas.height = height;
        if (presentation) {
          presentation.width = width;
          presentation.height = height;
        }
      }
    },
    renderAt(time, frame) {
      if (disposed) throw new Error("Renderer was destroyed");
      if (!scene || !map || !instances)
        throw new Error("Set a beatmap before rendering");
      if (!Number.isFinite(time)) throw new Error("Frame time must be finite");
      let direction = 1,
        cursorX = frame?.cursor?.x ?? 256,
        cursorY = frame?.cursor?.y ?? 192;
      if (!frame?.cursor && scene.catcher.length) {
        const a = scene.catcher;
        let lo = 0,
          hi = a.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (a[mid].time < time) lo = mid + 1;
          else hi = mid;
        }
        const p = a[Math.max(0, lo - 1)],
          q = a[Math.min(a.length - 1, lo)],
          f =
            q.time === p.time
              ? 1
              : Math.max(0, Math.min(1, (time - p.time) / (q.time - p.time)));
        cursorX = p.x + (q.x - p.x) * f;
        // The catcher faces the way it last moved (lazer's VisualDirection).
        for (let i = Math.min(a.length - 1, lo); i > 0; i--)
          if (a[i].x !== a[i - 1].x && a[i - 1].time < time) {
            direction = a[i].x > a[i - 1].x ? 1 : -1;
            break;
          }
        cursorY = (p.y ?? 350) + ((q.y ?? 350) - (p.y ?? 350)) * f;
      }
      // A replay's input (setBeatmap) wins over per-frame keys.
      const fromInput = !!settings.input;
      let mask = frame?.keys && !fromInput ? 0 : activeMask(keyIntervals, time);
      if (frame?.keys && !fromInput)
        for (let lane = 0; lane < Math.min(31, frame.keys.length); lane++)
          if (frame.keys[lane]) mask |= 1 << lane;
      uniforms[13] = activeMask(holdIntervals, time) & mask;
      uniforms[20] =
        map.mode === 0 && settings.playfieldShift ? PLAYFIELD_SHIFT : 0;
      uniforms[21] = fromInput ? activeMask(keyImageIntervals, time) : mask;
      uniforms[14] = hyperAmount(scene.hyper, time);
      uniforms[0] = time;
      uniforms[1] = width;
      uniforms[2] = height;
      uniforms[3] = map.mode;
      uniforms[4] = scene.speed;
      uniforms[5] = scrollPosition(map.timing, time, "mania", scene.scrollBase);
      uniforms[6] = scene.preempt;
      uniforms[7] = scene.clipX;
      uniforms[8] = cursorX;
      uniforms[9] = cursorY;
      uniforms[10] = map.visualMods.includes("FL") ? 1 : 0;
      uniforms[11] = direction;
      uniforms[12] = mask;
      uniforms[16] = map.visualMods.includes("HD") ? 1 : 0;
      uniforms[17] = map.visualMods.includes("FI") ? 1 : 0;
      uniforms[18] =
        Number(map.visualMods.includes("UD")) ^
        Number(settings.maniaScrollUp === true);
      let timingIndex = 0;
      while (
        timingIndex + 1 < map.timing.length &&
        map.timing[timingIndex + 1].time <= time
      )
        timingIndex++;
      uniforms[19] = frame?.failed
        ? 2
        : scene.catcherStates
          ? stateAt(scene.catcherStates, time)
          : (map.timing[timingIndex]?.effects ?? 0) & 1
            ? 1
            : 0;
      device.queue.writeBuffer(uniformBuffer, 0, uniforms);
      const swapchain = frame?.target
        ? undefined
        : context?.getCurrentTexture();
      attachment.view = frame?.target ?? swapchain?.createView()!;
      if (!attachment.view)
        throw new Error("Offscreen rendering requires frame.target");
      passDescriptor.timestampWrites = frame?.timestampWrites;
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginRenderPass(passDescriptor);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.setVertexBuffer(0, instances);
      for (let i = 0; i < scene.chunks.length; i++) {
        const chunk = scene.chunks[i];
        if (time >= chunk.from && time <= chunk.until)
          pass.draw(6, chunk.count, 0, chunk.first);
      }
      let count = 0;
      const skinned = cursorModel?.sprites(
        time,
        Math.max(0, frame?.cursor?.scale ?? 1),
        511,
      );
      // Skins without a cursor trail keep the caller's look-back trail.
      if (
        map.mode === 0 &&
        frame?.cursorTrail &&
        !(skinned && atlas.regions.has("cursortrail"))
      )
        for (let i = 0; i < frame.cursorTrail.length && count < 511; i++) {
          const sample = frame.cursorTrail[i];
          if (sample.opacity > 0)
            writeCursor(
              count++,
              sample.x,
              sample.y,
              15 * Math.max(0, sample.scale ?? 1),
              Math.min(1, sample.opacity),
              time,
            );
        }
      if (skinned)
        for (const sprite of skinned)
          count = writeSprite(
            count,
            sprite.asset,
            sprite.x,
            sprite.y,
            sprite.w,
            sprite.h,
            sprite.angle,
            sprite.alpha,
            sprite.additive,
            time,
          );
      else if (frame?.cursor && map.mode === 0)
        writeCursor(
          count++,
          cursorX,
          cursorY,
          (frame.cursor.pressed ? 20 : 15) *
            Math.max(0, frame.cursor.scale ?? 1),
          1,
          time,
        );
      if (count) {
        device.queue.writeBuffer(
          overlayBuffer,
          0,
          overlays.buffer,
          0,
          count * 96,
        );
        pass.setVertexBuffer(0, overlayBuffer);
        pass.draw(6, count);
      }
      pass.end();
      if (frame?.captureTarget && swapchain)
        encoder.copyTextureToTexture(
          { texture: swapchain },
          { texture: frame.captureTarget },
          [width, height],
        );
      commands[0] = encoder.finish();
      device.queue.submit(commands);
      if (!frame?.target && presentation && bitmap)
        bitmap.transferFromImageBitmap(presentation.transferToImageBitmap());
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      instances?.destroy();
      uniformBuffer.destroy();
      overlayBuffer.destroy();
      regionBuffer.destroy();
      atlas.texture.destroy();
      context?.unconfigure();
      gpu?.dispose();
    },
  };
  renderer.resize(width, height);
  return renderer;
}
