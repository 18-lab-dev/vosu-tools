import type { Beatmap } from "@vosu-tools/osu-parse";
import type { Skin } from "./skin";
import type { RenderOptions } from "./scene";
import type { Backend, Gpu, RenderTarget } from "./gpu";
import { rendererOn } from "./renderer";
import { createWebGpu } from "./webgpu";
import { createWebGl2 } from "./webgl2";
export type { Backend, RenderTarget } from "./gpu";
export {
  loadSkin,
  loadScope,
  maniaImageNames,
  assetNames,
  legacySliderStyle,
} from "./skin";
export { maniaKeysFor, sceneScope } from "./scene";
export type { Skin, SkinStyle, SkinScope, LoadSkinOptions } from "./skin";
export { builtinSkin, builtinSkinNames, withFallback } from "./builtin";
export type { BuiltinSkinName } from "./builtin";
export type { RenderOptions, Scene, InputFrame } from "./scene";
export type { JudgementEvent } from "./judgements";
export {
  PLAYFIELD_BACKGROUND,
  PLAYFIELD_DEFAULTS,
  PLAYFIELD_QUALITY,
  builtinLook,
  createPlayfield,
  describeBackend,
  loadPlayfieldSkin,
  overLook,
  playfieldOptions,
  playfieldSize,
} from "./playfield";
export type { Playfield, PlayfieldOptions } from "./playfield";
export interface FrameState {
  /** An offscreen target from `createTarget`; the canvas otherwise. */
  target?: RenderTarget;
  /** WebGPU only (WebGL2 ignores it): the render pass's timestamp writes. */
  timestampWrites?: GPURenderPassTimestampWrites;
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
  /**
   * `auto` (the default) draws with WebGPU and falls back to WebGL2 when
   * WebGPU is unavailable (no `navigator.gpu`, no adapter or device, a
   * lost device or a failing shader). A given `device` means WebGPU.
   */
  backend?: Backend | "auto";
}
/** renderAt receives absolute beatmap milliseconds, never wall-clock time. */
export interface Renderer {
  /** The backend drawing: tools show it in their status lines. */
  readonly backend: Backend;
  /** Why `auto` fell back to WebGL2; null when it did not. */
  readonly fallbackReason: string | null;
  /** The WebGPU device; null on WebGL2. */
  readonly device: GPUDevice | null;
  readonly format: GPUTextureFormat;
  /** Bytes of GPU textures the skin atlas and its frame table hold. */
  readonly textureBytes: number;
  /** Resolves with a reason if the GPU device or context is lost. */
  readonly lost: Promise<string>;
  /** An offscreen RGBA8 target for `renderAt(t, { target })` and readback. */
  createTarget(width: number, height: number): RenderTarget;
  /** Resolves when every frame rendered so far has finished on the GPU. */
  finished(): Promise<void>;
  setBeatmap(map: Beatmap, options?: RenderOptions): void;
  setSkin(skin?: Skin): void;
  renderAt(timeMs: number, frame?: FrameState): void;
  resize(width: number, height: number): void;
  destroy(): void;
}
export async function createRenderer(
  options: RendererOptions,
): Promise<Renderer> {
  const width = options.width ?? options.canvas?.width ?? 1920,
    height = options.height ?? options.canvas?.height ?? 1080;
  const base = {
    canvas: options.canvas,
    presentation: options.presentation,
    width,
    height,
    clear:
      options.clearColour ??
      (options.transparentBackground
        ? { r: 0, g: 0, b: 0, a: 0 }
        : { r: 0.012, g: 0.014, b: 0.02, a: 1 }),
  };
  const wanted = options.device ? "webgpu" : (options.backend ?? "auto");
  let gpu: Gpu,
    fallbackReason: string | null = null;
  if (wanted === "webgl2") gpu = createWebGl2(base);
  else
    try {
      gpu = await createWebGpu({
        ...base,
        device: options.device,
        format: options.format,
      });
    } catch (error) {
      if (wanted === "webgpu") throw error;
      fallbackReason = error instanceof Error ? error.message : String(error);
      try {
        gpu = createWebGl2(base);
      } catch (fallback) {
        throw new Error(
          `Neither WebGPU (${fallbackReason}) nor WebGL2 (${fallback instanceof Error ? fallback.message : String(fallback)}) can draw here`,
        );
      }
    }
  return rendererOn(gpu, fallbackReason, options, width, height);
}
