import { parseSkinIni } from "@vosu-tools/osu-parse";
import { resolve as resolveCommand } from "@vosu-tools/skin-spec";
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
export async function loadSkin(
  resolve: (file: string) => Promise<Blob | null>,
  name = "Client skin",
): Promise<Skin> {
  const skin: Skin = {
    name,
    assets: new Map(),
    sections: new Map(),
    pixelScale: new Map(),
    animations: new Map(),
    frameRate: 60,
    version: 1,
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
/** One atlas and one immutable region table; animations select UVs entirely in WGSL. */
export function buildAtlas(
  device: GPUDevice,
  skin?: Skin,
): {
  texture: GPUTexture;
  regions: Map<string, AtlasRegion>;
  frames: Float32Array<ArrayBuffer>;
} {
  const size = Math.min(4096, device.limits.maxTextureDimension2D),
    canvas = new OffscreenCanvas(size, size),
    ctx = canvas.getContext("2d")!;
  const regions = new Map<string, AtlasRegion>();
  let x = 2,
    y = 2,
    row = 0;
  const add = (
    name: string,
    image: CanvasImageSource,
    width: number,
    height: number,
    pixelScale = 1,
  ) => {
    const logicalWidth = width / pixelScale,
      logicalHeight = height / pixelScale,
      // Per axis, so very long images (mania hold bodies tens of thousands of
      // pixels tall) keep their full width; regions map the whole image anyway.
      w = Math.max(1, Math.min(1024, Math.ceil(width))),
      h = Math.max(1, Math.min(1024, Math.ceil(height)));
    if (x + w + 2 > size) {
      x = 2;
      y += row + 4;
      row = 0;
    }
    if (y + h + 2 > size)
      throw Error("Skin gameplay atlas exceeds GPU texture capacity");
    ctx.drawImage(image, x, y, w, h);
    regions.set(name, {
      u: x / size,
      v: y / size,
      w: w / size,
      h: h / size,
      width: logicalWidth,
      height: logicalHeight,
    });
    x += w + 4;
    row = Math.max(row, h);
  };
  if (skin) {
    const packed = new Map<ImageBitmap, AtlasRegion>();
    const images = [...skin.assets].sort(
      (a, b) => Math.min(1024, b[1].height) - Math.min(1024, a[1].height),
    );
    for (const [name, image] of images) {
      const existing = packed.get(image);
      if (existing) {
        regions.set(name, { ...existing });
        continue;
      }
      add(
        name,
        image,
        image.width,
        image.height,
        skin.pixelScale?.get(name) ?? 1,
      );
      packed.set(image, regions.get(name)!);
    }
  }
  for (let i = 0; i < 10; i++)
    if (!regions.has(`default-${i}`)) {
      const digit = new OffscreenCanvas(64, 80),
        c = digit.getContext("2d")!;
      c.fillStyle = "#fff";
      c.font = "bold 64px sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(i), 32, 42);
      add(`default-${i}`, digit, 64, 80);
    }
  const frames: number[] = [];
  const frameRate = skin?.frameRate ?? -1;
  for (const [name, region] of regions) {
    region.first = frames.length / 4;
    region.count = 1;
    region.fps =
      frameRate > 0 ? frameRate : (skin?.animations?.get(name)?.length ?? 1);
    frames.push(region.u, region.v, region.w, region.h);
    const animation = skin?.animations?.get(name);
    if (animation?.length) {
      region.first = frames.length / 4;
      region.count = animation.length;
      for (const frame of animation) {
        const uv = regions.get(frame)!;
        frames.push(uv.u, uv.v, uv.w, uv.h);
      }
    }
  }
  const texture = device.createTexture({
    size: [size, size],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture, premultipliedAlpha: false },
    [size, size],
  );
  return { texture, regions, frames: new Float32Array(frames) };
}
