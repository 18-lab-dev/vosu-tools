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
}

/** A renderer drawing with the shared quality, options and canvas sizing. */
export interface Playfield extends Renderer {
  /**
   * Sizes the canvas for a display of `cssWidth` × `cssHeight` CSS pixels
   * (`playfieldSize`). Offscreen targets are sized with `resize`.
   */
  fit(cssWidth: number, cssHeight: number, pixelRatio?: number): void;
}

/**
 * Creates the renderer every tool draws with. On a canvas it presents
 * directly, unless the page URL has `?presentation=bitmap` (frames copied
 * into a bitmap canvas, which headless captures can see). `setBeatmap`
 * applies `PLAYFIELD_DEFAULTS` under the caller's options.
 */
export async function createPlayfield(
  options: PlayfieldOptions,
): Promise<Playfield> {
  const query =
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get("presentation");
  const renderer = await createRenderer({
    ...options,
    presentation:
      options.presentation ??
      (options.canvas && query === "bitmap" ? "bitmap" : "direct"),
    ...(options.transparent
      ? { transparentBackground: true }
      : { clearColour: PLAYFIELD_BACKGROUND }),
  });
  const canvas = options.canvas;
  return {
    get device() {
      return renderer.device;
    },
    get format() {
      return renderer.format;
    },
    setBeatmap(map: Beatmap, beatmapOptions?: RenderOptions) {
      renderer.setBeatmap(map, playfieldOptions(beatmapOptions));
    },
    setSkin: (skin?: Skin) => renderer.setSkin(skin),
    renderAt: (timeMs: number, frame?: FrameState) =>
      renderer.renderAt(timeMs, frame),
    resize: (width: number, height: number) => renderer.resize(width, height),
    destroy: () => renderer.destroy(),
    fit(cssWidth, cssHeight, pixelRatio) {
      const { width, height } = playfieldSize(cssWidth, cssHeight, pixelRatio);
      if (canvas && canvas.width === width && canvas.height === height) return;
      renderer.resize(width, height);
    },
  };
}
