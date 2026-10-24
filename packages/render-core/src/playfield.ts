/**
 * The one way the tools draw a playfield. Map preview, Skin studio, Practice
 * and Replay renderer all build their renderer, skin and canvas size here, so
 * the four cannot drift apart again. The quality settings are Replay
 * renderer's, the best-looking of them before this module existed: a sharp,
 * supersampled internal resolution, lazer's gameplay look by default, the
 * classic skin behind every file skin, and a black screen behind the
 * playfield. Per-tool differences are options with a documented reason.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import { builtinSkin, withFallback, type BuiltinSkinName } from "./builtin";
import {
  createRenderer,
  type FrameState,
  type Renderer,
  type RendererOptions,
  type RenderTarget,
} from "./index";
import type { RenderOptions } from "./scene";
import { loadSkin, type LoadSkinOptions, type Skin } from "./skin";

/** Internal resolution: how many pixels a playfield canvas is drawn with. */
export const PLAYFIELD_QUALITY = {
  /**
   * The long side of the internal resolution is at least this: Replay
   * renderer's preview draws its output at 1920 px and lets the browser scale
   * it down, which supersamples skin textures and edges on smaller screens.
   */
  minLongSide: 1920,
  /** At most this many internal pixels per displayed pixel (each axis). */
  maxSupersample: 2,
  /** Device pixel ratios above this are drawn at this ratio. */
  maxPixelRatio: 2,
  /** WebGPU's guaranteed `maxTextureDimension2D`. */
  maxSide: 8192,
} as const;

/**
 * The canvas size (internal pixels) for a playfield shown at `cssWidth` ×
 * `cssHeight` CSS pixels: the screen's pixels (ratio capped at 2),
 * supersampled up to 2× until the long side reaches 1920.
 */
export function playfieldSize(
  cssWidth: number,
  cssHeight: number,
  pixelRatio = globalThis.devicePixelRatio || 1,
): { width: number; height: number } {
  const ratio = Math.min(
      Math.max(pixelRatio, 1),
      PLAYFIELD_QUALITY.maxPixelRatio,
    ),
    width = Math.max(1, cssWidth * ratio),
    height = Math.max(1, cssHeight * ratio),
    long = Math.max(width, height),
    scale = Math.min(
      Math.max(1, PLAYFIELD_QUALITY.minLongSide / long),
      PLAYFIELD_QUALITY.maxSupersample,
      PLAYFIELD_QUALITY.maxSide / long,
    );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * What a tool's render options fall back to: lazer's gameplay. lazer
 * normalises combo colours (0.2 by default; a stable client sets 0) and
 * plays the osu! playfield 8 osu! pixels lower than its editor does.
 * render-core's own defaults stay neutral for its golden tests.
 */
export const PLAYFIELD_DEFAULTS: Readonly<RenderOptions> = {
  comboColourNormalisation: 0.2,
  playfieldShift: true,
};

/** `options` over the defaults; options left `undefined` keep the default. */
export function playfieldOptions(options: RenderOptions = {}): RenderOptions {
  const out: RenderOptions = { ...PLAYFIELD_DEFAULTS };
  for (const [key, value] of Object.entries(options))
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
}

/** The screen behind the playfield: lazer's, without a map background. */
export const PLAYFIELD_BACKGROUND: GPUColor = { r: 0, g: 0, b: 0, a: 1 };

const looks = new Map<BuiltinSkinName, Skin>();
/**
 * A client built-in look, drawn once per page and shared by every caller.
 * Never close its bitmaps.
 */
export function builtinLook(name: BuiltinSkinName): Skin {
  let skin = looks.get(name);
  if (!skin) looks.set(name, (skin = builtinSkin(name)));
  return skin;
}

/**
 * A file skin as the clients draw it: elements it lacks come from a built-in
 * look, the classic one unless the host says otherwise.
 */
export function overLook(files: Skin, look: BuiltinSkinName = "legacy"): Skin {
  return withFallback(files, builtinLook(look));
}

/**
 * Loads a skin from files. `files` is the skin itself (its bitmaps are the
 * caller's to close; pass it to `loadScope`), `skin` is what to draw.
 * Image sizes are not limited (`maxTextureSize` is for emulating a GPU).
 */
export async function loadPlayfieldSkin(
  resolve: (file: string) => Promise<Blob | null>,
  name?: string,
  options: LoadSkinOptions = {},
): Promise<{ files: Skin; skin: Skin }> {
  const files = await loadSkin(resolve, name, options);
  return { files, skin: overLook(files) };
}

export interface PlayfieldOptions extends Omit<
  RendererOptions,
  "clearColour" | "transparentBackground"
> {
  /**
   * Clear to transparent black instead of the black screen, for callers that
   * composite the playfield over their own background (Replay renderer).
   */
  transparent?: boolean;
  /**
   * Called after the playfield replaced a lost GPU device or context: on a
   * page the canvas element is replaced too (`playfield.canvas`), and the
   * backend may have changed.
   */
  onRecover?: (playfield: Playfield, reason: string) => void;
}

/**
 * The backend a renderer draws with, for a tool's status line: a short
 * label, and a sentence saying why WebGL2 is used when WebGPU was wanted.
 */
export function describeBackend(renderer: {
  backend: "webgpu" | "webgl2";
  fallbackReason: string | null;
}): { label: string; detail: string } {
  if (renderer.backend === "webgpu")
    return { label: "WebGPU", detail: "Drawn with WebGPU." };
  return {
    label: "WebGL2",
    detail: renderer.fallbackReason
      ? `Drawn with WebGL2: WebGPU is unavailable (${renderer.fallbackReason}).`
      : "Drawn with WebGL2.",
  };
}

/** A renderer drawing with the shared quality, options and canvas sizing. */
export interface Playfield extends Renderer {
  /**
   * Sizes the canvas for a display of `cssWidth` × `cssHeight` CSS pixels
   * (`playfieldSize`). Offscreen targets are sized with `resize`.
   */
  fit(cssWidth: number, cssHeight: number, pixelRatio?: number): void;
  /** The canvas drawn on; a lost device or context replaces it. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
}

/** An offscreen target that follows the playfield across renderer replacements. */
class PlayfieldTarget implements RenderTarget {
  private inner: RenderTarget | null = null;
  private owner: Renderer | null = null;
  /** Nothing was drawn into the current renderer's target (while replacing it). */
  blank = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  on(renderer: Renderer): RenderTarget {
    if (this.owner !== renderer) {
      this.release();
      this.inner = renderer.createTarget(this.width, this.height);
      this.owner = renderer;
    }
    this.blank = false;
    return this.inner!;
  }
  async read(into?: Uint8Array): Promise<Uint8Array> {
    if (this.blank || !this.inner) {
      const out = into ?? new Uint8Array(this.width * this.height * 4);
      return out.fill(0);
    }
    return this.inner.read(into);
  }
  private release(): void {
    try {
      this.inner?.destroy();
    } catch {
      // Its device is gone already.
    }
    this.inner = null;
  }
  destroy(): void {
    this.release();
    this.owner = null;
  }
}

/**
 * Creates the renderer every tool draws with. On a canvas it presents
 * directly, unless the page URL has `?presentation=bitmap` (frames copied
 * into a bitmap canvas, which headless captures can see). The backend is
 * WebGPU with a WebGL2 fallback; `?backend=webgl2` (or `webgpu`) in the page
 * URL forces one, for tests. `setBeatmap` applies `PLAYFIELD_DEFAULTS` under
 * the caller's options.
 *
 * If the GPU device or WebGL context is lost later (a driver reset, a lost
 * GPU), the playfield builds a new renderer the same way, on a fresh canvas
 * that replaces the old one in the page, with the same skin, map and size;
 * frames asked for meanwhile are skipped (offscreen reads are transparent).
 * `lost` resolves only if no backend can draw any more.
 */
export async function createPlayfield(
  options: PlayfieldOptions,
): Promise<Playfield> {
  const params =
      typeof location === "undefined"
        ? null
        : new URLSearchParams(location.search),
    query = params?.get("presentation"),
    forced = params?.get("backend");
  const build = (
    canvas: PlayfieldOptions["canvas"],
    device: GPUDevice | undefined,
    width?: number,
    height?: number,
  ) =>
    createRenderer({
      ...options,
      canvas,
      device,
      width: width ?? options.width,
      height: height ?? options.height,
      backend:
        options.backend ??
        (forced === "webgpu" || forced === "webgl2" ? forced : "auto"),
      presentation:
        options.presentation ??
        (canvas && query === "bitmap" ? "bitmap" : "direct"),
      ...(options.transparent
        ? { transparentBackground: true }
        : { clearColour: PLAYFIELD_BACKGROUND }),
    });
  let renderer: Renderer | null = await build(options.canvas, options.device),
    canvas = options.canvas,
    skin = options.skin,
    beatmap: [Beatmap, RenderOptions | undefined] | null = null,
    size: [number, number] | null = null,
    destroyed = false;
  let last = renderer;
  let giveUp: (reason: string) => void = () => {};
  const lost = new Promise<string>((resolve) => (giveUp = resolve));
  const watch = (watched: Renderer) =>
    void watched.lost.then((reason) => {
      if (watched === renderer && !destroyed) void recover(reason);
    });
  async function recover(reason: string): Promise<void> {
    const old = renderer!;
    renderer = null;
    try {
      old.destroy();
    } catch {
      // Its device is gone already.
    }
    // A canvas keeps the context type it was first given: draw on a new one.
    if (
      typeof HTMLCanvasElement !== "undefined" &&
      canvas instanceof HTMLCanvasElement
    ) {
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    } else if (canvas)
      canvas = new OffscreenCanvas(canvas.width, canvas.height);
    try {
      // A lost shared device is not reused: the new renderer finds its own.
      const next = await build(canvas, undefined, size?.[0], size?.[1]);
      if (destroyed) return next.destroy();
      next.setSkin(skin);
      if (size) next.resize(size[0], size[1]);
      if (beatmap) next.setBeatmap(beatmap[0], beatmap[1]);
      renderer = last = next;
      watch(next);
      options.onRecover?.(playfield, reason);
    } catch (error) {
      giveUp(
        `${reason}; no backend could draw again: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  watch(renderer);
  const playfield: Playfield = {
    get backend() {
      return last.backend;
    },
    get fallbackReason() {
      return last.fallbackReason;
    },
    get device() {
      return renderer?.device ?? null;
    },
    get format() {
      return last.format;
    },
    get canvas() {
      return canvas;
    },
    lost,
    get textureBytes() {
      return renderer?.textureBytes ?? 0;
    },
    createTarget: (width: number, height: number) =>
      new PlayfieldTarget(
        Math.max(1, Math.round(width)),
        Math.max(1, Math.round(height)),
      ),
    finished: () => renderer?.finished() ?? Promise.resolve(),
    setBeatmap(map: Beatmap, beatmapOptions?: RenderOptions) {
      beatmap = [map, playfieldOptions(beatmapOptions)];
      renderer?.setBeatmap(beatmap[0], beatmap[1]);
    },
    setSkin(next?: Skin) {
      skin = next;
      renderer?.setSkin(next);
    },
    renderAt(timeMs: number, frame?: FrameState) {
      const target =
        frame?.target instanceof PlayfieldTarget ? frame.target : undefined;
      if (!renderer) {
        if (target) target.blank = true;
        return;
      }
      renderer.renderAt(
        timeMs,
        target ? { ...frame, target: target.on(renderer) } : frame,
      );
    },
    resize(width: number, height: number) {
      size = [width, height];
      renderer?.resize(width, height);
    },
    destroy() {
      destroyed = true;
      renderer?.destroy();
      renderer = null;
    },
    fit(cssWidth, cssHeight, pixelRatio) {
      const { width, height } = playfieldSize(cssWidth, cssHeight, pixelRatio);
      if (canvas && canvas.width === width && canvas.height === height) return;
      playfield.resize(width, height);
    },
  };
  return playfield;
}
