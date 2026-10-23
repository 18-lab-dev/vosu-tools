import { parseSkinIni } from "@vosu-tools/osu-parse";
import { resolve as resolveCommand } from "@vosu-tools/skin-spec";
import { planAtlas, type AtlasStrip } from "./atlas";
import { normaliseManiaImage } from "./mania";
export interface Skin {
  name: string;
  assets: Map<string, ImageBitmap>;
  sections: Map<string, Record<string, string>[]>;
  pixelScale?: Map<string, number>;
  animations?: Map<string, string[]>;
  frameRate?: number;
  version?: number;
  /** Rendering traits that skin.ini cannot express; built-in skins set it. */
  style?: SkinStyle;
  /**
   * Images osu!lazer's GPU cannot hold (larger than its maximum texture size
   * on either axis). lazer still uses them, but the GL upload fails silently
   * and the texture samples opaque black, so they are drawn black.
   */
  blank?: Set<string>;
}
/**
 * Client rendering traits of a skin family. Skins loaded from files are legacy
 * skins: their sliders use the "legacy" profile.
 */
export interface SkinStyle {
  /** The client built-in skin this skin reimplements, if any. */
  builtin?: string;
  slider?: {
    /** Colour profile across the body, from edge to centre. */
    profile: "legacy" | "triangles" | "argon";
    /** Body radius relative to the hit circle radius. */
    radius: number;
    /** Border width as a portion of the body radius (legacy: including its shadow). */
    border: number;
    /** Body opacity, composited over the playfield. */
    alpha: number;
  };
  /** Taiko centre (don) and rim (kat) note colours. */
  taiko?: { centre: readonly number[]; rim: readonly number[] };
}
/** Slider body traits of skins loaded from files (lazer LegacySliderBody / stable). */
export const legacySliderStyle: NonNullable<SkinStyle["slider"]> = {
  profile: "legacy",
  radius: 1,
  border: 0.1875,
  alpha: 0.7,
};
export interface AtlasRegion {
  u: number;
  v: number;
  w: number;
  h: number;
  width?: number;
  height?: number;
  first?: number;
  count?: number;
  fps?: number;
  /** Array texture page (atlas.ts). */
  layer?: number;
  /** Tall images: their strips from top to bottom (atlas.ts). */
  strips?: AtlasStrip[];
  /** Frame-table entries of the plain image (`first` is the animation's, when animated). */
  still?: number;
  /** Frame-table entries per animation frame: the most strips of any frame. */
  stride?: number;
}

/** A region's strips; one covering the whole image when it is not split. */
export function regionStrips(region: AtlasRegion): AtlasStrip[] {
  const { u, v, w, h, layer = 0 } = region;
  return region.strips ?? [{ u, v, w, h, layer, a: 0, b: 1 }];
}

/**
 * The instances that draw a region: one per strip, each with its frame-table
 * entry and (for stills) its UV rectangle. `still` draws the plain image;
 * otherwise the animation, if any. `maxRow` (a fraction of the image height)
 * skips strips that can never show.
 */
export function regionInstances(
  region: AtlasRegion,
  still: boolean,
  maxRow = 1,
): { entry: number; uv: AtlasStrip }[] {
  const strips = regionStrips(region),
    animated = !still && (region.count ?? 0) > 1,
    count = animated ? (region.stride ?? strips.length) : strips.length,
    base = (animated ? region.first : (region.still ?? region.first)) ?? 0,
    out: { entry: number; uv: AtlasStrip }[] = [];
  for (let k = 0; k < count; k++) {
    const uv = strips[k] ?? strips[0];
    if (k > 0 && strips[k] && strips[k].a >= maxRow) break;
    out.push({ entry: base + k, uv });
  }
  return out;
}
export const assetNames = [
  "hitcircle",
  "hitcircleoverlay",
  "approachcircle",
  "sliderb",
  "sliderfollowcircle",
  "reversearrow",
  "sliderscorepoint",
  "sliderendcircle",
  "cursor",
  "spinner-background",
  "spinner-circle",
  "spinner-approachcircle",
  "spinner-bottom",
  "spinner-top",
  "spinner-middle",
  "spinner-middle2",
  "spinner-glow",
  "spinner-metre",
  "spinner-rpm",
  "spinner-spin",
  "spinner-clear",
  "taikohitcircle",
  "taikohitcircleoverlay",
  "taikobigcircle",
  "taikobigcircleoverlay",
  "taiko-drum-inner",
  "taiko-drum-outer",
  "taiko-slider",
  "taiko-bar-left",
  "taiko-bar-right",
  "taiko-roll-middle",
  "taiko-roll-end",
  "fruit-apple",
  "fruit-grapes",
  "fruit-orange",
  "fruit-pear",
  "fruit-drop",
  "fruit-bananas",
  "fruit-apple-overlay",
  "fruit-grapes-overlay",
  "fruit-orange-overlay",
  "fruit-pear-overlay",
  "fruit-drop-overlay",
  "fruit-bananas-overlay",
  "fruit-catcher-idle",
  "fruit-catcher-kiai",
  "fruit-catcher-fail",
  "mania-stage-left",
  "mania-stage-right",
  "mania-stage-bottom",
  "mania-stage-hint",
  "mania-stage-light",
  "lightingN",
  "lightingL",
  ...["1", "2", "S"].flatMap((kind) => [
    `mania-note${kind}`,
    `mania-note${kind}H`,
    `mania-note${kind}L`,
    `mania-note${kind}T`,
    `mania-key${kind}`,
    `mania-key${kind}D`,
  ]),
  ...Array.from({ length: 10 }, (_, i) => `default-${i}`),
];
const animated = new Set([
  "sliderb",
  "hitcircleoverlay",
  "taikohitcircleoverlay",
  "taikobigcircleoverlay",
  "fruit-catcher-idle",
  "fruit-catcher-kiai",
  "fruit-catcher-fail",
  "mania-stage-light",
  "lightingN",
  "lightingL",
  "spinner-circle",
  "spinner-top",
  "spinner-middle",
  "spinner-middle2",
  "spinner-glow",
]);
/** Resolves logical asset names once. SD dimensions survive @2x selection and atlas packing. */
export interface LoadSkinOptions {
  /**
   * Images larger than this on either axis are marked `blank` (drawn black),
   * emulating a client whose GPU upload fails. Off unless given: the limit
   * and the resulting pixels depend on the client's renderer backend and GPU,
   * and no measured value is reported to tools yet.
   */
  maxTextureSize?: number;
}

export async function loadSkin(
  resolve: (file: string) => Promise<Blob | null>,
  name = "Client skin",
  options: LoadSkinOptions = {},
): Promise<Skin> {
  const maxTextureSize = options.maxTextureSize ?? Infinity;
  const skin: Skin = {
    name,
    assets: new Map(),
    sections: new Map(),
    pixelScale: new Map(),
    animations: new Map(),
    frameRate: 60,
    version: 1,
    blank: new Set(),
  };
  const ini = await resolve("skin.ini");
  if (ini) skin.sections = parseSkinIni(await ini.text());
  const general = skin.sections.get("General")?.[0] ?? {};
  skin.version =
    !ini || general.Version?.toLowerCase() === "latest"
      ? Infinity
      : Number(general.Version ?? 1);
  skin.frameRate =
    Number(general.AnimationFramerate) > 0
      ? Number(general.AnimationFramerate)
      : -1;
  for (const [section, blocks] of skin.sections)
    for (const block of blocks)
      for (const key of Object.keys(block)) {
        const rule = resolveCommand(section, key);
        if (rule?.since && skin.version < rule.since) delete block[key];
      }
  const names = new Set(assetNames),
    animationNames = new Set(animated);
  for (const section of skin.sections.get("Mania") ?? [])
    for (const [key, value] of Object.entries(section))
      if (
        /^(NoteImage|KeyImage|Stage|Lighting)/.test(key) &&
        value &&
        !["null", "none"].includes(value.toLowerCase())
      ) {
        const asset = normaliseManiaImage(value);
        section[key] = asset;
        names.add(asset);
        animationNames.add(asset);
      }
  const prefix = skin.sections.get("Fonts")?.[0]?.HitCirclePrefix ?? "default";
  for (let i = 0; i < 10; i++) names.add(`${prefix}-${i}`);
  async function image(key: string, path = key): Promise<boolean> {
    if (skin.assets.has(key)) return true;
    const normalized = path.replace(/\\/g, "/").replace(/\.png$/i, "");
    const variants =
      normalized === "taiko-slider"
        ? ["taiko-slider", "taiko-Slider"]
        : [normalized];
    for (const candidate of variants)
      for (const suffix of /@2x$/i.test(candidate) || (skin.version ?? 1) < 2
        ? [".png"]
        : ["@2x.png", ".png"]) {
        const blob = await resolve(candidate + suffix);
        if (!blob) continue;
        try {
          const bitmap = await createImageBitmap(blob);
          // osu!framework only size-checks partial uploads, so lazer keeps
          // the texture (no fallback, even from @2x) and its GL upload fails.
          if (bitmap.width > maxTextureSize || bitmap.height > maxTextureSize)
            skin.blank!.add(key);
          skin.assets.set(key, bitmap);
          skin.pixelScale!.set(
            key,
            /@2x(?:\.png)?$/i.test(candidate + suffix) ? 2 : 1,
          );
          return true;
        } catch {
          /* Only the unavailable element falls back. */
        }
      }
    return false;
  }
  // Bounded concurrency avoids hundreds of simultaneous host requests for large key layouts.
  const pending = [...names];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < pending.length) {
        const name = pending[cursor++];
        await image(name);
        if (
          !animationNames.has(name) &&
          !name.startsWith("mania-") &&
          !name.startsWith("mania/") &&
          !/lighting/i.test(name)
        )
          continue;
        const frames: string[] = [];
        const prefix = name === "sliderb" ? name : `${name}-`;
        for (let frame = 0; frame < 512; frame++) {
          const key = `${prefix}${frame}`;
          const pathName =
            name.replace(/@2x$/i, "") +
            (name === "sliderb" ? "" : "-") +
            frame +
            (/@2x$/i.test(name) ? "@2x" : "");
          if (!(await image(key, pathName))) break;
          frames.push(key);
        }
        if (frames.length) {
          skin.animations!.set(name, frames);
          if (!skin.assets.has(name)) {
            skin.assets.set(name, skin.assets.get(frames[0])!);
            skin.pixelScale!.set(name, skin.pixelScale!.get(frames[0])!);
          }
        }
      }
    }),
  );
  return skin;
}
/**
 * Skin images on array-texture pages (see atlas.ts) and one immutable frame
 * table; animations and strips select UVs entirely in WGSL.
 *
 * The frame table holds two vec4 per entry: the UV rectangle, then
 * (a, b, layer, stride) where [a, b] are the image rows the entry holds
 * (fractions of the image height) and `stride` the entries per animation
 * frame. A region's entries start at `first`: frame f, strip k is entry
 * `first + f * stride + k`.
 */
export function buildAtlas(
  device: GPUDevice,
  skin?: Skin,
): {
  texture: GPUTexture;
  regions: Map<string, AtlasRegion>;
  frames: Float32Array<ArrayBuffer>;
} {
  const sources = new Map<
    string,
    {
      image: CanvasImageSource;
      width: number;
      height: number;
      scale: number;
      blank: boolean;
    }
  >();
  const owners = new Map<ImageBitmap, string>(),
    aliases = new Map<string, string>();
  if (skin)
    for (const [name, image] of skin.assets) {
      const owner = owners.get(image);
      if (owner) {
        aliases.set(name, owner);
        continue;
      }
      owners.set(image, name);
      sources.set(name, {
        image,
        width: image.width,
        height: image.height,
        scale: skin.pixelScale?.get(name) ?? 1,
        blank: skin.blank?.has(name) ?? false,
      });
    }
  for (let i = 0; i < 10; i++)
    if (!sources.has(`default-${i}`) && !aliases.has(`default-${i}`)) {
      const digit = new OffscreenCanvas(64, 80),
        c = digit.getContext("2d")!;
      c.fillStyle = "#fff";
      c.font = "bold 64px sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(i), 32, 42);
      sources.set(`default-${i}`, {
        image: digit,
        width: 64,
        height: 80,
        scale: 1,
        blank: false,
      });
    }
  const plan = planAtlas(
    [...sources].map(([key, { width, height }]) => ({ key, width, height })),
    device.limits,
  );
  if (plan.downscaled.length)
    console.warn(
      `Skin images wider than this GPU allows (${device.limits.maxTextureDimension2D} px) are scaled down: ${plan.downscaled.join(", ")}`,
    );
  const { pageWidth, pageHeight, pages } = plan;
  const regions = new Map<string, AtlasRegion>();
  for (const [name, source] of sources) {
    const placement = plan.placements.get(name)!;
    const strips: AtlasStrip[] = placement.pieces.map((piece) => ({
      u: piece.x / pageWidth,
      v: piece.y / pageHeight,
      w: piece.width / pageWidth,
      h: piece.height / pageHeight,
      layer: piece.page,
      a: piece.top / placement.height,
      b: piece.bottom / placement.height,
    }));
    const [first] = strips;
    regions.set(name, {
      u: first.u,
      v: first.v,
      w: first.w,
      h: first.h,
      layer: first.layer,
      width: source.width / source.scale,
      height: source.height / source.scale,
      ...(strips.length > 1 ? { strips } : {}),
    });
  }
  for (const [name, owner] of aliases)
    regions.set(name, { ...regions.get(owner)! });
  // Pixels: one canvas reused for every page.
  const texture = device.createTexture({
    size: [pageWidth, pageHeight, pages],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const canvas = new OffscreenCanvas(pageWidth, pageHeight),
    ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  for (let page = 0; page < pages; page++) {
    ctx.clearRect(0, 0, pageWidth, pageHeight);
    for (const [name, source] of sources) {
      const placement = plan.placements.get(name)!,
        rows = source.height / placement.height;
      for (const piece of placement.pieces) {
        if (piece.page !== page) continue;
        const top = piece.top - piece.gutterTop,
          height = piece.bottom + piece.gutterBottom - top,
          y = piece.y - piece.gutterTop;
        if (source.blank) {
          ctx.fillStyle = "#000";
          ctx.fillRect(piece.x, y, piece.width, height);
        } else
          ctx.drawImage(
            source.image,
            0,
            top * rows,
            source.width,
            height * rows,
            piece.x,
            y,
            piece.width,
            height,
          );
      }
    }
    device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture, origin: [0, 0, page], premultipliedAlpha: false },
      [pageWidth, pageHeight],
    );
  }
  const values: number[] = [];
  const frameRate = skin?.frameRate ?? -1;
  const push = (strip: AtlasStrip | undefined, stride: number) =>
    strip
      ? values.push(
          strip.u,
          strip.v,
          strip.w,
          strip.h,
          strip.a,
          strip.b,
          strip.layer,
          stride,
        )
      : // A frame with fewer strips than the animation's widest frame.
        values.push(0, 0, 0, 0, 2, 2, 0, stride);
  for (const [name, region] of regions) {
    const own = regionStrips(region);
    region.still = region.first = values.length / 8;
    region.count = 1;
    region.stride = own.length;
    region.fps =
      frameRate > 0 ? frameRate : (skin?.animations?.get(name)?.length ?? 1);
    for (const strip of own) push(strip, own.length);
    const animation = skin?.animations?.get(name);
    if (animation?.length) {
      const frames = animation.map((frame) =>
          regionStrips(regions.get(frame)!),
        ),
        stride = Math.max(...frames.map((f) => f.length));
      region.first = values.length / 8;
      region.count = animation.length;
      region.stride = stride;
      for (const frame of frames)
        for (let k = 0; k < stride; k++) push(frame[k], stride);
    }
  }
  return { texture, regions, frames: new Float32Array(values) };
}
