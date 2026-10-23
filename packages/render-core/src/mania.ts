/**
 * Legacy mania skinning, ported from osu!lazer (ppy/osu 2026.1005.0-lazer, MIT):
 * `LegacyManiaSkinDecoder`, `LegacyManiaSkinConfiguration`, the mania lookups
 * of `LegacySkin`, and the layout of `Stage`, `ColumnFlow`, `Column` and the
 * `osu.Game.Rulesets.Mania/Skinning/Legacy` pieces (stage background, column
 * lines, hit target, column light, key area, note / hold pieces, hit
 * explosion, hold lighting, stage foreground, bar lines).
 *
 * Everything here is in lazer stage units: the stage is 768 tall (480 legacy
 * units × 1.6), x runs from the stage's left edge, y from its top, and the
 * layout is the downscroll one. Upscroll mirrors it about the stage centre;
 * `flip` says how each texture behaves under that mirror. Image sizes are
 * display sizes (pixels, halved for @2x), as lazer's `Texture.DisplayWidth`.
 *
 * Differences from osu!stable that lazer's source documents, kept here: the
 * stage is always centred (ColumnStart, ColumnRight, SplitStages,
 * StageSeparation, SpecialStyle and SeparateScore are decoded but unused, "TODO:
 * likely needs POSITION_SCALE_FACTOR"), UpsideDown and the
 * KeyFlipWhenUpsideDown / NoteFlipWhenUpsideDown settings are unused, and the
 * repeating NoteBodyStyles stretch the body image to 32800 units from the
 * tail instead of repeating it ("i dunno this looks about right??").
 */
import type { AtlasRegion, Skin } from "./skin";

/** lazer's `LegacySkin.STABLE_MAGIC_SCALE_FACTOR`. */
export const MANIA_SCALE = 1.6;
/** Stage height in lazer units. */
export const STAGE_HEIGHT = 480 * MANIA_SCALE;
/** `LegacyManiaSkinConfiguration.DEFAULT_COLUMN_SIZE`. */
const DEFAULT_COLUMN_SIZE = 30 * MANIA_SCALE;
/**
 * Legacy units from the default hit position (402) to the stage top: the
 * distance notes travel in one `DrawableManiaRuleset` time range.
 */
export const DEFAULT_SCROLL_LENGTH = 402;

export type Rgba = readonly [number, number, number, number];

/** One `[Mania]` configuration, decoded and defaulted as lazer does. */
export interface ManiaConfig {
  keys: number;
  /** Skin format version (`Infinity` for "latest" / no skin.ini). */
  version: number;
  columnWidth: number[];
  /** Gap after each column but the last. */
  columnSpacing: number[];
  /** Line widths left of each column and right of the last, unscaled. */
  columnLineWidth: number[];
  /** Distance of the hit position from the stage's bottom edge. */
  hitPosition: number;
  /** Distance of the column light's bottom edge from the stage's bottom edge. */
  lightPosition: number;
  /** Note height reference width (`WidthForNoteHeightScale`, else the narrowest column). */
  noteHeightWidth: number;
  showJudgementLine: boolean;
  keysUnderNotes: boolean;
  lightFramePerSecond: number;
  /** 0 = Stretch; anything else repeats (drawn as a 32800-unit stretch). */
  noteBodyStyle: number;
  barLineHeight: number;
  explosionScale: number[];
  holdLightScale: number[];
  /** Custom element paths (`NoteImage0H`, `KeyImage1D`, `StageHint`, ...), normalised. */
  images: Map<string, string>;
  /** `Colour*` entries, 0-1 RGBA. */
  colours: Map<string, Rgba>;
}

const float = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
/** `LegacyManiaSkinDecoder.parseArrayValue`: unparsable entries read as zero. */
function parseArray(value: string, output: number[], applyScale = true): void {
  const values = value.split(",");
  for (let i = 0; i < values.length && i < output.length; i++) {
    const trimmed = values[i].trim();
    let parsed = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)
      ? Number(trimmed)
      : 0;
    if (applyScale) parsed *= MANIA_SCALE;
    output[i] = parsed;
  }
}
/** `LegacyDecoder.HandleColours`: three or four byte components. */
function parseColour(value: string): Rgba | undefined {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255))
    return undefined;
  return [
    bytes[0] / 255,
    bytes[1] / 255,
    bytes[2] / 255,
    (bytes[3] ?? 255) / 255,
  ];
}
/** Element paths as the skin loader keys them: forward slashes, no extension, no @2x. */
export function normaliseManiaImage(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.png$/i, "")
    .replace(/@2x/gi, "");
}
/** `LegacyDecoder.StripComments`. */
const stripComment = (value: string) => {
  const index = value.indexOf("//");
  return (index > 0 ? value.slice(0, index) : value).trim();
};

/**
 * The configuration lazer uses for `keys` columns: the first `[Mania]` block
 * declaring that key count, or lazer's defaults when the skin has none.
 */
export function maniaConfig(skin: Skin | undefined, keys: number): ManiaConfig {
  const version = skin?.version ?? Infinity;
  const config: ManiaConfig = {
    keys,
    version,
    columnWidth: Array.from({ length: keys }, () => DEFAULT_COLUMN_SIZE),
    columnSpacing: Array.from({ length: Math.max(0, keys - 1) }, () => 0),
    columnLineWidth: Array.from({ length: keys + 1 }, () => 2),
    hitPosition: (480 - 402) * MANIA_SCALE,
    lightPosition: (480 - 413) * MANIA_SCALE,
    noteHeightWidth: 0,
    showJudgementLine: true,
    keysUnderNotes: false,
    lightFramePerSecond: 60,
    noteBodyStyle: version < 2.5 ? 0 : 3,
    barLineHeight: 1.2,
    explosionScale: [],
    holdLightScale: [],
    images: new Map(),
    colours: new Map(),
  };
  const explosionWidth = Array.from({ length: keys }, () => 0),
    holdLightWidth = Array.from({ length: keys }, () => 0);
  let widthForNoteHeightScale = 0;
  const block = skin?.sections
    .get("Mania")
    ?.find((section) => Number.parseInt(section.Keys ?? "", 10) === keys);
  for (const [key, raw] of Object.entries(block ?? {})) {
    if (key === "__block" || key === "Keys") continue;
    const value = stripComment(raw);
    switch (key) {
      case "ColumnLineWidth":
        parseArray(value, config.columnLineWidth, false);
        break;
      case "ColumnSpacing":
        parseArray(value, config.columnSpacing);
        break;
      case "ColumnWidth":
        parseArray(value, config.columnWidth);
        break;
      case "BarlineHeight":
        if (Number.isFinite(float(value))) config.barLineHeight = float(value);
        break;
      case "HitPosition":
        if (Number.isFinite(float(value)))
          config.hitPosition =
            (480 - Math.min(480, Math.max(240, float(value)))) * MANIA_SCALE;
        break;
      case "LightPosition":
        if (Number.isFinite(float(value)))
          config.lightPosition = (480 - float(value)) * MANIA_SCALE;
        break;
      case "JudgementLine":
        config.showJudgementLine = value === "1";
        break;
      case "KeysUnderNotes":
        config.keysUnderNotes = value === "1";
        break;
      case "LightingNWidth":
        parseArray(value, explosionWidth);
        break;
      case "LightingLWidth":
        parseArray(value, holdLightWidth);
        break;
      case "NoteBodyStyle": {
        // Enum.TryParse: names or any integer.
        const named = [
          "Stretch",
          "",
          "RepeatTop",
          "RepeatBottom",
          "RepeatTopAndBottom",
        ];
        const index = named.indexOf(value);
        if (/^[+-]?\d+$/.test(value)) config.noteBodyStyle = Number(value);
        else if (index >= 0 && value) config.noteBodyStyle = index;
        break;
      }
      case "WidthForNoteHeightScale":
        if (Number.isFinite(float(value)))
          widthForNoteHeightScale = float(value) * MANIA_SCALE;
        break;
      case "LightFramePerSecond": {
        const fps = Number.parseInt(value, 10);
        if (Number.isFinite(fps))
          config.lightFramePerSecond = fps > 0 ? fps : 24;
        break;
      }
      default:
        if (key.startsWith("Colour")) {
          const colour = parseColour(value);
          if (colour) config.colours.set(key, colour);
        } else if (
          /^(NoteImage|KeyImage|Hit|Stage|Lighting)/.test(key) ||
          key === "WarningArrow"
        )
          config.images.set(key, normaliseManiaImage(value));
    }
  }
  const minimum = Math.min(...config.columnWidth);
  config.noteHeightWidth =
    widthForNoteHeightScale > 0 ? widthForNoteHeightScale : minimum;
  for (let i = 0; i < keys; i++) {
    config.explosionScale[i] =
      version < 2.5
        ? 1
        : (explosionWidth[i] || config.columnWidth[i]) / DEFAULT_COLUMN_SIZE;
    config.holdLightScale[i] =
      version < 2.5
        ? 1
        : (holdLightWidth[i] || config.columnWidth[i]) / DEFAULT_COLUMN_SIZE;
  }
  return config;
}

/**
 * Image display size, or nothing when no skin layer provides the element.
 * `animated` lookups (lazer's `GetAnimation`) take an animation's first frame
 * (`name-0`) over a plain `name` image; texture lookups (`GetTexture`: keys,
 * hit target, stage sides) only take `name`.
 */
export type ImageSize = (
  name: string,
  animated: boolean,
) => { width: number; height: number } | undefined;

/**
 * Display sizes from an atlas built by `buildAtlas`: the skin loader keys
 * animation frames `name-0`, `name-1`, … and, without a plain `name` image,
 * aliases `name` to the first frame (the same atlas spot).
 */
export function atlasImageSize(regions: Map<string, AtlasRegion>): ImageSize {
  return (name, animated) => {
    const frame = regions.get(`${name}-0`),
      plain = regions.get(name),
      uv = animated
        ? (frame ?? plain)
        : plain && !(frame && frame.u === plain.u && frame.v === plain.v)
          ? plain
          : undefined;
    return uv ? { width: uv.width ?? 1, height: uv.height ?? 1 } : undefined;
  };
}

/**
 * How a texture behaves when upscroll mirrors the stage: `mirror` flips with
 * it, `inverted` is flipped in downscroll only (hold tails), `none` never
 * flips (stage sides, stage bottom, lighting).
 */
export type ManiaFlip = "none" | "mirror" | "inverted";

export interface ManiaSprite {
  asset: string;
  x: number;
  y: number;
  width: number;
  height: number;
  flip: ManiaFlip;
  /** Drawn with the element's animation frames (`GetAnimation`) rather than one texture. */
  animated: boolean;
}
export interface ManiaBox {
  x: number;
  y: number;
  width: number;
  height: number;
  colour: Rgba;
}
export interface ManiaPiece {
  asset: string;
  /** Drawn height; the width is the column's. */
  height: number;
}
export interface ManiaColumn {
  x: number;
  width: number;
  /** `LegacyManiaColumnElement.FallbackColumnIndex`. */
  fallback: "1" | "2" | "S";
  background: ManiaBox;
  lines: ManiaBox[];
  light?: ManiaSprite & { colour: Rgba };
  key?: ManiaSprite;
  keyDown?: ManiaSprite;
  note?: ManiaPiece;
  head?: ManiaPiece;
  tail?: ManiaPiece;
  body?: string;
  /** Hit explosion (LightingN) and hold lighting (LightingL), centred on the hit position. */
  explosion?: ManiaSprite;
  holdLight?: ManiaSprite;
}
export interface ManiaLayout {
  config: ManiaConfig;
  width: number;
  /** y of the hit position (where notes' bottom edges are hit). */
  hitY: number;
  columns: ManiaColumn[];
  stageLeft?: ManiaSprite;
  stageRight?: ManiaSprite;
  hint?: ManiaSprite;
  judgementLine?: ManiaBox;
  stageBottom?: ManiaSprite;
  barLine: { height: number; colour: Rgba };
}

const WHITE: Rgba = [1, 1, 1, 1];
const BLACK: Rgba = [0, 0, 0, 1];
/** `LegacyColourCompatibility.DisallowZeroAlpha`. */
const disallowZeroAlpha = (c: Rgba): Rgba =>
  c[3] === 0 ? [c[0], c[1], c[2], 1] : c;
/** `LegacyColourCompatibility.ApplyWithDoubledAlpha`. */
const doubledAlpha = (c: Rgba): Rgba => [c[0], c[1], c[2], c[3] * c[3]];

/** `StageDefinition.IsSpecialColumn` and `LegacyManiaColumnElement.FallbackColumnIndex`. */
export function fallbackColumnIndex(
  keys: number,
  column: number,
): "1" | "2" | "S" {
  if (keys % 2 === 1 && column === Math.floor(keys / 2)) return "S";
  const distance = Math.min(column, keys - 1 - column);
  return distance % 2 === 0 ? "1" : "2";
}

/** The legacy stage for `config`, with element sizes from `size`. */
export function maniaLayout(config: ManiaConfig, size: ImageSize): ManiaLayout {
  const { keys, images, colours } = config;
  const hitY = STAGE_HEIGHT - config.hitPosition;
  const image = (key: string, fallback: string) => images.get(key) ?? fallback;
  const sprite = (
    asset: string,
    place: (w: number, h: number) => [number, number, number, number],
    flip: ManiaFlip,
    animated: boolean,
  ): ManiaSprite | undefined => {
    const s = size(asset, animated);
    if (!s) return undefined;
    const [x, y, width, height] = place(s.width, s.height);
    return { asset, x, y, width, height, flip, animated };
  };
  // ColumnFlow: each column carries half of the spacing on either side.
  const columns: ManiaColumn[] = [];
  let x = 0;
  for (let i = 0; i < keys; i++) {
    const left = i === 0 ? 0 : config.columnSpacing[i - 1] / 2,
      right = i === keys - 1 ? 0 : config.columnSpacing[i] / 2,
      width = config.columnWidth[i];
    x += left;
    columns.push({
      x,
      width,
      fallback: fallbackColumnIndex(keys, i),
      background: { x, y: 0, width, height: STAGE_HEIGHT, colour: BLACK },
      lines: [],
    });
    x += width + right;
  }
  const width = x;
  for (const [i, column] of columns.entries()) {
    const F = column.fallback,
      last = i === keys - 1;
    // LegacyStageBackground.ColumnBackground
    column.background.colour = doubledAlpha(
      colours.get(`Colour${i + 1}`) ?? BLACK,
    );
    const lineColour = doubledAlpha(colours.get("ColourColumnLine") ?? WHITE),
      leftLine = config.columnLineWidth[i],
      rightLine = config.columnLineWidth[i + 1];
    if (leftLine > 0)
      column.lines.push({
        x: column.x,
        y: 0,
        width: leftLine * 0.74,
        height: hitY,
        colour: lineColour,
      });
    if ((rightLine > 0 && config.version >= 2.4) || last)
      column.lines.push({
        x: column.x + column.width + (last ? -0.16 : 0),
        y: 0,
        width: rightLine * 0.74,
        height: hitY,
        colour: lineColour,
      });
    // LegacyColumnBackground: the light sits on LightPosition, column wide.
    const light = sprite(
      image("StageLight", "mania-stage-light"),
      (_, h) => [
        column.x,
        STAGE_HEIGHT - config.lightPosition - h,
        column.width,
        h,
      ],
      "mirror",
      true,
    );
    if (light)
      column.light = {
        ...light,
        colour: disallowZeroAlpha(colours.get(`ColourLight${i + 1}`) ?? WHITE),
      };
    // LegacyKeyArea: column wide, the image's own height, on the stage's bottom edge.
    const key = (name: string) =>
      sprite(
        name,
        (_, h) => [column.x, STAGE_HEIGHT - h, column.width, h],
        "mirror",
        false,
      );
    column.key = key(image(`KeyImage${i}`, `mania-key${F}`));
    column.keyDown = key(image(`KeyImage${i}D`, `mania-key${F}D`));
    // LegacyNotePiece: column wide; height from the texture's aspect at the note height width.
    const piece = (...candidates: string[]): ManiaPiece | undefined => {
      for (const asset of candidates) {
        const s = size(asset, true);
        if (s && s.width > 0)
          return {
            asset,
            height: (s.height * config.noteHeightWidth) / s.width,
          };
      }
      return undefined;
    };
    const note = image(`NoteImage${i}`, `mania-note${F}`),
      head = image(`NoteImage${i}H`, `mania-note${F}H`),
      tail = image(`NoteImage${i}T`, `mania-note${F}T`);
    column.note = piece(note);
    column.head = piece(head, note);
    column.tail = piece(tail, head, note);
    const body = image(`NoteImage${i}L`, `mania-note${F}L`);
    if (size(body, true)) column.body = body;
    // LegacyHitExplosion / LegacyBodyPiece light: centred on the hit position, scaled.
    const lighting = (name: string, scale: number) =>
      sprite(
        name,
        (w, h) => [
          column.x + column.width / 2 - (w * scale) / 2,
          hitY - (h * scale) / 2,
          w * scale,
          h * scale,
        ],
        "none",
        true,
      );
    column.explosion = lighting(
      image("LightingN", "lightingN"),
      config.explosionScale[i],
    );
    column.holdLight = lighting(
      image("LightingL", "lightingL"),
      config.holdLightScale[i],
    );
  }
  // LegacyStageBackground side images: their own width, stretched to the stage height.
  const stageLeft = sprite(
    image("StageLeft", "mania-stage-left"),
    (w) => [0.05 - w, 0, w, STAGE_HEIGHT],
    "none",
    false,
  );
  const stageRight = sprite(
    image("StageRight", "mania-stage-right"),
    (w) => [width - 0.05, 0, w, STAGE_HEIGHT],
    "none",
    false,
  );
  // LegacyHitTarget: hint image scaled (1, 0.9 × 1.6025) and the judgement line,
  // in an auto-sized container centred on the hit position.
  const hintAsset = image("StageHint", "mania-stage-hint"),
    hintSize = size(hintAsset, false),
    hintHeight = (hintSize?.height ?? 0) * 0.9 * 1.6025,
    containerHeight = Math.max(hintHeight, config.showJudgementLine ? 2 : 0),
    top = hitY - containerHeight / 2;
  const hint = hintSize
    ? {
        asset: hintAsset,
        x: 0,
        y: top,
        width,
        height: hintHeight,
        flip: "mirror" as const,
        animated: false,
      }
    : undefined;
  const lineColour = disallowZeroAlpha(
    colours.get("ColourJudgementLine") ?? WHITE,
  );
  const judgementLine = config.showJudgementLine
    ? {
        x: 0,
        y: top + containerHeight / 2,
        width,
        height: 1,
        colour: [
          lineColour[0],
          lineColour[1],
          lineColour[2],
          lineColour[3] * 0.9,
        ] as Rgba,
      }
    : undefined;
  // LegacyStageForeground: the bottom image at 1.6×, centred on the bottom edge.
  const stageBottom = sprite(
    image("StageBottom", "mania-stage-bottom"),
    (w, h) => [
      width / 2 - (w * MANIA_SCALE) / 2,
      STAGE_HEIGHT - h * MANIA_SCALE,
      w * MANIA_SCALE,
      h * MANIA_SCALE,
    ],
    "none",
    true,
  );
  return {
    config,
    width,
    hitY,
    columns,
    stageLeft,
    stageRight,
    hint,
    judgementLine,
    stageBottom,
    barLine: {
      height: config.barLineHeight,
      colour: colours.get("ColourBarline") ?? WHITE,
    },
  };
}
