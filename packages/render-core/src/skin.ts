import { parseSkinIni } from "@vosu-tools/osu-parse";
import { resolve as resolveCommand } from "@vosu-tools/skin-spec";
import {
  ATLAS_PADDING,
  planAtlas,
  type AtlasLimits,
  type AtlasStrip,
} from "./atlas";
import {
  maniaConfig,
  maniaJudgementImages,
  maniaLayout,
  maniaWrappedImages,
  normaliseManiaImage,
} from "./mania";
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
  /**
   * Images a skin lacked and took from the built-in skin behind it
   * (`withFallback`): the clients look those up in the next skin of the chain,
   * which changes what some rulesets show (taiko judgements).
   */
  fallback?: ReadonlySet<string>;
  /**
   * How the skin draws judgements: "legacy" for skins loaded from files and
   * the classic look (LegacyJudgementPiece), "default" for lazer's own looks
   * (DefaultJudgementPiece).
   */
  judgements?: "legacy" | "default";
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

/** Whether a region has animation frames (`first` then leads into them). */
export function hasFrames(region: AtlasRegion): boolean {
  return (
    (region.count ?? 1) > 1 ||
    (region.still !== undefined && region.first !== region.still)
  );
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
    // An animation lookup uses the frames whenever there are any: a single
    // frame (`name-0`) wins over the plain image, as in lazer's GetAnimation.
    framed = !still && hasFrames(region),
    count = framed ? (region.stride ?? strips.length) : strips.length,
    base = (framed ? region.first : (region.still ?? region.first)) ?? 0,
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
  "cursormiddle",
  "cursortrail",
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
  // osu!taiko's swell note (LegacySwell).
  "spinner-warning",
  "taikohitcircle",
  "taikohitcircleoverlay",
  "taikobigcircle",
  "taikobigcircleoverlay",
  "taiko-drum-inner",
  "taiko-drum-outer",
  "taiko-glow",
  // DrawableTaikoMascot: pippidon{state}0, 1, ... (frames without a dash).
  "pippidonidle",
  "pippidonkiai",
  "pippidonfail",
  "pippidonclear",
  "taiko-slider",
  "taiko-bar-left",
  "taiko-bar-right",
  "taiko-bar-right-glow",
  "taiko-barline",
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
  // LegacyCatcherOld (skins before version 2.3 without fruit-catcher-*).
  "fruit-ryuuta",
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
  // Judgements (LegacySkin.getJudgementAnimation and the rulesets' lookups).
  ...judgementNames(),
];
/** Judgement images every ruleset but mania looks up (mania's come from its configuration). */
function judgementNames(): string[] {
  return [
    "hit0",
    "hit50",
    "hit100",
    "hit300",
    "slidertickmiss",
    "sliderendmiss",
    "sliderpoint10",
    "sliderpoint30",
    "particle50",
    "particle100",
    "particle300",
    "lighting",
    "taiko-hit0",
    "taiko-hit100",
    "taiko-hit300",
    "taiko-hit100k",
    "taiko-hit300k",
    ...["0", "50", "100", "200", "300", "300g"].map((r) => `mania-hit${r}`),
  ];
}
/** Elements lazer looks up as animations (`GetAnimation`, animatable). */
export const animatedAssets: ReadonlySet<string> = new Set([
  "sliderb",
  "sliderfollowcircle",
  "pippidonidle",
  "pippidonkiai",
  "pippidonfail",
  "pippidonclear",
  "hitcircleoverlay",
  "taikohitcircleoverlay",
  "taikobigcircleoverlay",
  "fruit-catcher-idle",
  "fruit-catcher-kiai",
  "fruit-catcher-fail",
  "fruit-ryuuta",
  "mania-stage-light",
  "lightingN",
  "lightingL",
  "hit0",
  "hit50",
  "hit100",
  "hit300",
  "slidertickmiss",
  "sliderendmiss",
  "taiko-hit0",
  "taiko-hit100",
  "taiko-hit300",
  "taiko-hit100k",
  "taiko-hit300k",
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
  /**
   * The mania key counts to decode images for (each key count has its own
   * [Mania] images, and hold bodies can be tens of megabytes each). Every key
   * count when omitted; `loadManiaKeys` switches the set later.
   */
  maniaKeys?: readonly number[];
}

/** How a loaded skin decodes more images later (`loadManiaKeys`). */
interface SkinSource {
  resolve: (file: string) => Promise<Blob | null>;
  maxTextureSize: number;
  /** Every image name a scene in some ruleset may look up, mania aside. */
  general: ReadonlySet<string>;
  /** Asset keys (frames included) that belong to mania only. */
  mania: ReadonlySet<string>;
}
const sources = new WeakMap<Skin, SkinSource>();

/** Default mania element names (shared by every key count without overrides). */
const maniaDefaults = new Set(
  assetNames.filter((n) => n.startsWith("mania-") || /^lighting[NL]$/.test(n)),
);

/** The mania images a stage of `keys` columns looks up (custom paths and the defaults they fall back to). */
export function maniaImageNames(skin: Skin, keys: number): Set<string> {
  const names = new Set<string>();
  // Report every lookup as missing, so every fallback candidate is recorded too.
  const config = maniaConfig(skin, keys);
  maniaLayout(config, (name) => {
    names.add(name);
    return undefined;
  });
  for (const name of Object.values(maniaJudgementImages(config))) names.add(name);
  return names;
}

export async function loadSkin(
  resolve: (file: string) => Promise<Blob | null>,
  name = "Client skin",
  options: LoadSkinOptions = {},
): Promise<Skin> {
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
  const maniaNames = new Set(maniaDefaults);
  for (const section of skin.sections.get("Mania") ?? [])
    for (const [key, value] of Object.entries(section))
      if (
        /^(NoteImage|KeyImage|Stage|Lighting|Hit(0|50|100|200|300|300g)$)/.test(key) &&
        value &&
        !["null", "none"].includes(value.toLowerCase())
      ) {
        const asset = normaliseManiaImage(value);
        section[key] = asset;
        maniaNames.add(asset);
      }
  const generalNames = new Set(assetNames.filter((n) => !maniaDefaults.has(n)));
  const fonts = skin.sections.get("Fonts")?.[0];
  for (const prefix of [
    fonts?.HitCirclePrefix ?? "default",
    // osu!catch's combo counter (LegacyFont.Combo).
    fonts?.ComboPrefix ?? "score",
  ])
    for (let i = 0; i < 10; i++)
      generalNames.add(`${prefix}-${i}`);
  // A custom mania path can name a general element; it is general then.
  for (const name of generalNames) maniaNames.delete(name);
  const source: SkinSource = {
    resolve,
    maxTextureSize: options.maxTextureSize ?? Infinity,
    general: generalNames,
    mania: new Set(),
  };
  sources.set(skin, source);
  const wanted = options.maniaKeys
    ? new Set(options.maniaKeys.flatMap((k) => [...maniaImageNames(skin, k)]))
    : maniaNames;
  const loadedMania = await decode(skin, source, [
    ...generalNames,
    ...[...wanted].filter((n) => !generalNames.has(n)),
  ]);
  source.mania = new Set(
    [...loadedMania].filter((key) => !isGeneral(key, generalNames)),
  );
  return skin;
}

/** Whether an asset key (or animation frame key) belongs to a general element. */
/**
 * The element an asset key belongs to: itself, or the animation it is a
 * frame of (`name-3`, or `sliderb3` / `pippidonidle3` for the elements whose
 * frames have no dash).
 */
export function frameOwner(key: string): string {
  const undashed = /^(sliderb|pippidon(?:idle|kiai|fail|clear))\d+$/.exec(key);
  return undashed ? undashed[1] : key.replace(/-\d+$/, "");
}
const isGeneral = (key: string, general: ReadonlySet<string>) =>
  general.has(key) || general.has(frameOwner(key));

/**
 * The skin with mania images for exactly these key counts: images already
 * decoded are shared, new ones are decoded, and mania images of other key
 * counts are left out (the caller closes them once nothing draws the old
 * skin). Skins not made by `loadSkin` are returned unchanged.
 */
export async function loadManiaKeys(
  skin: Skin,
  keys: readonly number[],
): Promise<Skin> {
  const source = sources.get(skin);
  if (!source) return skin;
  const wanted = new Set(keys.flatMap((k) => [...maniaImageNames(skin, k)]));
  for (const name of source.general) wanted.delete(name);
  const next: Skin = {
    ...skin,
    assets: new Map(),
    pixelScale: new Map(),
    animations: new Map(),
    blank: new Set(),
  };
  // Keep every general asset and the wanted mania ones (with their frames).
  const keep = (key: string) =>
    !source.mania.has(key) ||
    wanted.has(key) ||
    wanted.has(frameOwner(key));
  for (const [key, bitmap] of skin.assets)
    if (keep(key)) {
      next.assets.set(key, bitmap);
      next.pixelScale!.set(key, skin.pixelScale?.get(key) ?? 1);
      if (skin.blank?.has(key)) next.blank!.add(key);
    }
  for (const [key, frames] of skin.animations ?? [])
    if (keep(key)) next.animations!.set(key, frames);
  const nextSource: SkinSource = { ...source, mania: new Set() };
  sources.set(next, nextSource);
  const missing = [...wanted].filter(
    (name) => !next.assets.has(name) && !next.animations!.has(name),
  );
  await decode(next, nextSource, missing);
  nextSource.mania = new Set(
    [...next.assets.keys()].filter((key) => !isGeneral(key, source.general)),
  );
  return next;
}

/** Decodes the named images (and their animation frames) into the skin; returns the keys it added. */
async function decode(
  skin: Skin,
  source: SkinSource,
  names: readonly string[],
): Promise<Set<string>> {
  const added = new Set<string>();
  const { resolve, maxTextureSize } = source;
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
          added.add(key);
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
          !animatedAssets.has(name) &&
          !name.startsWith("mania-") &&
          !name.startsWith("mania/") &&
          !/lighting/i.test(name) &&
          source.general.has(name)
        )
          continue;
        const frames: string[] = [];
        const undashed = name === "sliderb" || name.startsWith("pippidon");
        const prefix = undashed ? name : `${name}-`;
        for (let frame = 0; frame < 512; frame++) {
          const key = `${prefix}${frame}`;
          const pathName =
            name.replace(/@2x$/i, "") +
            (undashed ? "" : "-") +
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
            added.add(name);
          }
        }
      }
    }),
  );
  return added;
}
/**
 * Images lazer loads with ClampToEdge or Repeat wrapping, per axis (S, T):
 * `LegacyDrumRoll`'s body and end, and the mania notes, keys and bodies of
 * every key count. Everything else is WrapMode.None.
 */
export function wrappedImages(
  skin?: Skin,
): Map<string, readonly [boolean, boolean]> {
  const out = new Map<string, readonly [boolean, boolean]>([
    ["taiko-roll-middle", [true, true]],
    ["taiko-roll-end", [true, true]],
  ]);
  for (let keys = 1; keys <= 18; keys++)
    for (const [name, [s, t]] of maniaWrappedImages(maniaConfig(skin, keys))) {
      const [s0, t0] = out.get(name) ?? [false, false];
      out.set(name, [s0 || s, t0 || t]);
    }
  return out;
}
/** Where `buildAtlas` puts its pages: a backend's 2D array texture. */
export interface AtlasSink {
  readonly limits: AtlasLimits;
  /** Creates the array texture: `pages` layers of `width` × `height`, RGBA8. */
  allocate(width: number, height: number, pages: number): void;
  /** Copies a drawn page (unpremultiplied RGBA) into layer `page`. */
  upload(page: number, source: OffscreenCanvas): void;
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
  sink: AtlasSink,
  skin?: Skin,
): {
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
    sink.limits,
  );
  if (plan.downscaled.length)
    console.warn(
      `Skin images wider than this GPU allows (${sink.limits.maxTextureDimension2D} px) are scaled down: ${plan.downscaled.join(", ")}`,
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
  for (const [name, owner] of aliases) {
    const region = regions.get(owner);
    if (region) regions.set(name, { ...region });
  }
  // Pixels: one canvas reused for every page.
  sink.allocate(pageWidth, pageHeight, pages);
  const canvas = new OffscreenCanvas(pageWidth, pageHeight),
    ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const wrapped = wrappedImages(skin);
  // osu!framework's atlas pads every image with its edge pixels: at full
  // opacity on axes the texture clamps or repeats, transparent otherwise
  // (WrapMode.None). Filtering at a stretched image's edges then blends with
  // the same colour or with nothing, like lazer.
  const extendEdges = (
    x: number,
    y: number,
    w: number,
    h: number,
    sides: boolean,
    top: boolean,
    bottom: boolean,
  ) => {
    const P = ATLAS_PADDING;
    ctx.imageSmoothingEnabled = false;
    if (top) ctx.drawImage(canvas, x, y, w, 1, x, y - P, w, P);
    if (bottom) ctx.drawImage(canvas, x, y + h - 1, w, 1, x, y + h, w, P);
    if (sides) {
      // Corners are opaque only when both axes are.
      const y0 = top ? y - P : y,
        h0 = h + (top ? P : 0) + (bottom ? P : 0);
      ctx.drawImage(canvas, x, y0, 1, h0, x - P, y0, P, h0);
      ctx.drawImage(canvas, x + w - 1, y0, 1, h0, x + w, y0, P, h0);
    }
    ctx.imageSmoothingEnabled = true;
  };
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
          continue;
        }
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
        const [s, t] =
          wrapped.get(name) ?? wrapped.get(name.replace(/-\d+$/, "")) ?? [];
        if (s || t)
          extendEdges(
            piece.x,
            y,
            piece.width,
            height,
            !!s,
            !!t && piece.top === 0,
            !!t && piece.bottom === placement.height,
          );
      }
    }
    sink.upload(page, canvas);
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
    // GetAnimation stops at the first frame the skin cannot provide; a lone
    // plain image is drawn when no frame is left.
    const listed = skin?.animations?.get(name) ?? [],
      missing = listed.findIndex((frame) => !regions.has(frame)),
      animation = missing < 0 ? listed : listed.slice(0, missing);
    region.fps = frameRate > 0 ? frameRate : animation.length || 1;
    for (const strip of own) push(strip, own.length);
    if (animation.length) {
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
  return { regions, frames: new Float32Array(values) };
}
