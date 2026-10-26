/**
 * What the renderer asks of a graphics backend. The renderer (index.ts)
 * compiles scenes, computes per-frame uniforms and writes overlay instances
 * once; a backend only owns GPU objects: the skin atlas, the frame table, the
 * instance buffers, presentation and offscreen targets. WebGPU (webgpu.ts) is
 * preferred; WebGL2 (webgl2.ts) draws the same instances with GLSL that naga
 * generates from the same WGSL (shader-glsl.ts).
 */
import type { AtlasLimits } from "./atlas";
import type { AtlasSink } from "./skin";

export type Backend = "webgpu" | "webgl2";

/** Floats per instance (six vec4 attributes). */
export const INSTANCE_FLOATS = 24;
/** Overlay instances (cursors, trails, cursor sprites) drawn per frame at
 *  most: 512 per cursor for up to eight overlapping players. */
export const MAX_OVERLAYS = 4096;
/** Overlay instances one cursor and its trail may use. */
export const CURSOR_OVERLAYS = 512;
/**
 * A textured instance's tint asking the shader to recolour the image: its
 * brightest channel per pixel times `tint` (RGB, 0-1), so a red miss or a
 * colourful cursor reads as one player's colour. Encoded as a negative red.
 */
export function recoloured(tint: readonly number[]): [number, number, number] {
  return [-Math.max(tint[0], 1 / 1024), -tint[1], -tint[2]];
}
/** Floats in the `Globals` uniform block. */
export const UNIFORM_FLOATS = 24;

/** An offscreen render target the caller reads back (Replay renderer). */
export interface RenderTarget {
  readonly width: number;
  readonly height: number;
  /**
   * The last frame rendered into the target: RGBA8, rows top to bottom,
   * premultiplied alpha (the renderer's blending), written into `into` when
   * given (width × height × 4 bytes). Start reads for several targets before
   * awaiting them: WebGPU maps them in parallel.
   */
  read(into?: Uint8Array): Promise<Uint8Array>;
  destroy(): void;
}

export interface DrawCall {
  /** `Globals`, `UNIFORM_FLOATS` floats. */
  uniforms: Float32Array<ArrayBuffer>;
  /** Scene instance ranges to draw, in order. */
  chunks: readonly { first: number; count: number }[];
  overlays: Float32Array<ArrayBuffer>;
  overlayCount: number;
  /** An offscreen target; the canvas otherwise. */
  target?: RenderTarget;
  /** WebGPU only: the render pass's timestamp writes. */
  timestampWrites?: GPURenderPassTimestampWrites;
}

export interface Gpu {
  readonly backend: Backend;
  /** The WebGPU device; null on WebGL2. */
  readonly device: GPUDevice | null;
  readonly format: GPUTextureFormat;
  readonly limits: AtlasLimits;
  /**
   * Rebuilds the atlas: `build` fills the sink and returns the frame table.
   * The previous atlas is released once the new one exists.
   */
  setAtlas(build: (sink: AtlasSink) => Float32Array<ArrayBuffer>): void;
  setInstances(data: Float32Array<ArrayBuffer>): void;
  /** Bytes of GPU textures the skin atlas and frame table hold. */
  readonly textureBytes: number;
  resize(width: number, height: number): void;
  draw(call: DrawCall): void;
  createTarget(width: number, height: number): RenderTarget;
  /** Resolves when every frame drawn so far has finished on the GPU. */
  finished(): Promise<void>;
  /** Resolves with a reason if the device or context is lost. */
  readonly lost: Promise<string>;
  destroy(): void;
}

/** What createRenderer passes a backend. */
export interface GpuOptions {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  presentation?: "direct" | "bitmap";
  width: number;
  height: number;
  clear: GPUColor;
}

/** The frame table's texture rows for `entries` table entries (two texels each). */
export function frameTableRows(texels: number, width: number): number {
  return Math.max(1, Math.ceil(texels / width));
}

/**
 * The visible canvas's bitmap context for `presentation: "bitmap"`: frames are
 * drawn on an OffscreenCanvas and transferred, so headless captures see them.
 */
export function bitmapPresentation(
  options: GpuOptions,
): { offscreen: OffscreenCanvas; bitmap: ImageBitmapRenderingContext } | null {
  if (!options.canvas || options.presentation !== "bitmap") return null;
  const bitmap = options.canvas.getContext(
    "bitmaprenderer",
  ) as ImageBitmapRenderingContext | null;
  if (!bitmap) throw new Error("Bitmap presentation is unavailable");
  return {
    offscreen: new OffscreenCanvas(options.width, options.height),
    bitmap,
  };
}
