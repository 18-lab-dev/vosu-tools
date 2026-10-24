/**
 * Compares render-core's mania scene against osu!lazer's own layout, as
 * dumped by test/reference/VosuManiaLayout.cs (see test/maniaGolden.ts).
 *
 * The scene's instances are evaluated on the CPU with the same arithmetic as
 * the WGSL vertex stage (positions, hold clamping, body spans, upscroll mirror,
 * texture flips) and converted back to lazer stage units, where every visible
 * legacy skin element lazer drew must have a counterpart.
 */
import { parseOsu, parseSkinIni, scrollPosition } from "@vosu-tools/osu-parse";
import {
  atlasImageSize,
  maniaConfig,
  maniaLayout,
  MANIA_SCALE,
} from "../src/mania";
import { compileScene } from "../src/scene";
import type { AtlasRegion, Skin } from "../src/skin";

export interface GoldenSkin {
  name: string;
  /** skin.ini text, or none for a skin without one. */
  ini?: string;
  /** Image files and their pixel sizes. */
  files: Record<string, [number, number]>;
}
export interface GoldenCase {
  name: string;
  skin: string;
  keys: number;
  direction: "down" | "up";
  scrollSpeed: number;
  time: number;
  objects: { column: number; start: number; end?: number }[];
}
export interface GoldenItem {
  kind: string;
  type: string;
  asset: string | null;
  texture: [number, number] | null;
  column: number | null;
  alpha: number;
  colour: [number, number, number];
  /** TL, TR, BL, BR corners in lazer stage units. */
  quad: number[];
  clip: number[] | null;
}
export interface GoldenResult {
  name: string;
  stage: [number, number];
  columns: number[][];
  items: GoldenItem[];
}

/** The skin as render-core's loader would build it, with display-sized regions. */
/** Skin files resolve case-insensitively, as in lazer and vosu's skin route. */
export function caseless<T>(entries: Map<string, T>): Map<string, T> {
  const out = new (class extends Map<string, T> {
    override get(key: string) {
      return super.get(key.toLowerCase());
    }
    override has(key: string) {
      return super.has(key.toLowerCase());
    }
    override set(key: string, value: T) {
      return super.set(key.toLowerCase(), value);
    }
  })();
  for (const [key, value] of entries) out.set(key, value);
  return out;
}

export function goldenSkin(skin: GoldenSkin): {
  skin: Skin;
  regions: Map<string, AtlasRegion>;
} {
  const sections = skin.ini ? parseSkinIni(skin.ini) : new Map();
  const general = sections.get("General")?.[0] ?? {};
  const version = !skin.ini
    ? Infinity
    : general.Version?.toLowerCase() === "latest"
      ? Infinity
      : Number(general.Version ?? 1);
  const regions = caseless(new Map<string, AtlasRegion>());
  // lazer prefers name@2x.png over name.png and halves its size.
  const files = Object.entries(skin.files).sort(
    ([a], [b]) => Number(/@2x\.png$/i.test(b)) - Number(/@2x\.png$/i.test(a)),
  );
  for (const [file, [width, height]] of files) {
    const double = /@2x\.png$/i.test(file),
      name = file.replace(/\.png$/i, "").replace(/@2x$/i, "");
    if (regions.has(name)) continue;
    regions.set(name, {
      // A distinct atlas spot and frame index per image, so instances can be
      // traced back to it and frame aliases recognised.
      u: regions.size,
      v: 0,
      w: 1,
      h: 1,
      width: double ? width / 2 : width,
      height: double ? height / 2 : height,
      first: regions.size,
      count: 1,
      fps: 60,
    });
  }
  // Like the skin loader: an animation without a plain image is known by its first frame.
  for (const [name, region] of [...regions])
    if (name.endsWith("-0") && !regions.has(name.slice(0, -2)))
      regions.set(name.slice(0, -2), region);
  // The slider ball's frames are sliderb0, sliderb1, ... (no dash).
  if (regions.has("sliderb0") && !regions.has("sliderb"))
    regions.set("sliderb", regions.get("sliderb0")!);
  return {
    skin: { name: skin.name, assets: new Map(), sections, version },
    regions,
  };
}

/** A beatmap with the case's objects on a single 120 BPM timing point. */
export function goldenBeatmap(c: GoldenCase): string {
  const objects = c.objects
    .map((o) => {
      const x = Math.floor(((o.column + 0.5) * 512) / c.keys);
      return o.end === undefined
        ? `${x},192,${o.start},1,0,0:0:0:0:`
        : `${x},192,${o.start},128,0,${o.end}:0:0:0:0:`;
    })
    .join("\n");
  return `osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:${c.keys}\nOverallDifficulty:5\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n${objects}\n`;
}

export interface Placed {
  index: number;
  motion: number;
  /** The image drawn, for textured instances. */
  asset?: string;
  rect: { x: number; y: number; width: number; height: number };
  flipped: boolean;
  colour: number[];
  /** Hold bodies: the texture's full extent along y (top, height). */
  span?: { top: number; height: number };
}

/** Every mania instance of the scene at `time`, in lazer stage units (CPU copy of the WGSL vertex stage). */
export function placeScene(
  c: GoldenCase,
  skin: Skin,
  regions: Map<string, AtlasRegion>,
): Placed[] {
  const map = parseOsu(goldenBeatmap(c)),
    scene = compileScene(
      map,
      { scrollSpeed: c.scrollSpeed, maniaScrollUp: c.direction === "up" },
      regions,
      skin,
    ),
    layout = maniaLayout(maniaConfig(skin, c.keys), atlasImageSize(regions)),
    now = scrollPosition(map.timing, c.time, "mania", scene.scrollBase),
    up = c.direction === "up",
    names = new Map([...regions].map(([name, uv]) => [uv.first, name])),
    out: Placed[] = [];
  for (let i = 0; i < scene.count; i++) {
    const d = scene.data.subarray(i * 24, i * 24 + 24);
    const [x, y, w] = d;
    let h = d[3],
      cy = y,
      span: Placed["span"];
    const [start, end, from, until] = [d[4], d[5], d[6], d[7]];
    const motion = d[12],
      a = d[13],
      b = d[14],
      hit = d[15],
      code = d[20];
    if (c.time < from || c.time > until) continue;
    if (motion === 1) {
      cy = hit - (a - now) * scene.speed - h / 2;
      if (end > start) cy = Math.min(cy, hit - h / 2);
      else if (c.time > start) continue;
    } else if (motion === 2 || motion === 14) {
      const tailLine = hit - (b - now) * scene.speed,
        headLine = hit - (a - now) * scene.speed,
        top = tailLine - h,
        bottom = Math.min(headLine, hit) - y,
        full = headLine - y - top;
      h = Math.max(0, bottom - top);
      cy = (top + bottom) / 2;
      const height = motion === 14 ? Math.max(full, 32800 / MANIA_SCALE) : full;
      span = {
        top: (top + 48) * MANIA_SCALE,
        height: height * MANIA_SCALE,
      };
    } else if (motion === 22) cy = hit - (a - now) * scene.speed - y;
    if (up) {
      cy = 384 - cy;
      if (span)
        span = {
          top: STAGE - span.top - span.height,
          height: span.height,
        };
    }
    out.push({
      index: i,
      motion,
      asset: code >= 10 ? names.get(d[21]) : undefined,
      rect: {
        x: (x - w / 2 - 256) * MANIA_SCALE + layout.width / 2,
        y: (cy - h / 2 + 48) * MANIA_SCALE,
        width: w * MANIA_SCALE,
        height: h * MANIA_SCALE,
      },
      flipped: (code === 40 && up) || (code === 41 && !up),
      colour: [d[8], d[9], d[10], d[11]],
      span,
    });
  }
  return out;
}
const STAGE = 768;

type Rect = { x: number; y: number; width: number; height: number };
const clampToStage = (rect: Rect): Rect => {
  const top = Math.max(0, rect.y),
    bottom = Math.min(STAGE, rect.y + rect.height);
  return {
    x: rect.x,
    y: top,
    width: rect.width,
    height: Math.max(0, bottom - top),
  };
};
const bounds = (quad: number[]) => {
  const xs = [quad[0], quad[2], quad[4], quad[6]],
    ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/** Which scene instances may stand for a lazer element. */
function candidates(item: GoldenItem): (p: Placed) => boolean {
  switch (item.kind) {
    case "LegacyKeyArea":
      return (p) => p.motion === 11 || p.motion === 12;
    case "LegacyColumnBackground":
      return (p) => p.motion === 13;
    case "LegacyHitExplosion":
      return (p) => p.motion === 18;
    case "HitTargetInsetContainer":
      // Column lines (boxes) and the hold light (LegacyBodyPiece adds it to the column).
      return item.type === "Box"
        ? (p) => p.motion === 0
        : (p) => p.motion === 19;
    case "LegacyNotePiece":
    case "LegacyHoldNoteHeadPiece":
    case "LegacyHoldNoteTailPiece":
      return (p) => p.motion === 1;
    case "LegacyBodyPiece":
      return (p) => p.motion === 2 || p.motion === 14;
    case "LegacyBarLine":
      return (p) => p.motion === 22;
    default:
      return (p) => p.motion === 0;
  }
}

export interface Mismatch {
  /** The lazer element; none when render-core draws a stage element lazer does not. */
  item?: GoldenItem;
  expected: { x: number; y: number; width: number; height: number };
  nearest?: Placed;
  reason: string;
}

/** lazer's texture lookup key (`path@2x:wrap-…`) as a render-core asset name. */
export const goldenAsset = (key: string) =>
  key.split(":")[0].replace(/\\/g, "/").replace(/@2x$/i, "").toLowerCase();

/**
 * Every visible lazer element on the stage needs an instance with the same
 * rectangle (within `tolerance` lazer units) and texture orientation, and
 * every static stage element render-core draws must exist in lazer. `own`
 * limits textured elements to the skin's own images (lazer fills the rest
 * from its classic skin, whose textures render-core does not have).
 */
export function compareCase(
  c: GoldenCase,
  golden: GoldenResult,
  skin: Skin,
  regions: Map<string, AtlasRegion>,
  own: (asset: string) => boolean = () => true,
  tolerance = 0.05,
): Mismatch[] {
  const placed = placeScene(c, skin, regions),
    mismatches: Mismatch[] = [],
    lazerStatic: Rect[] = [],
    lazerBodies = new Set<string>();
  for (const item of golden.items) {
    if (!item.kind || item.alpha < 0.01) continue;
    if (item.type === "Sprite" && !own(goldenAsset(item.asset ?? ""))) continue;
    // Animated bodies are looked up by their first frame (`name-0`).
    if (item.kind === "LegacyBodyPiece")
      lazerBodies.add(goldenAsset(item.asset ?? "").replace(/-0$/, ""));
    let expected = bounds(item.quad);
    const flipped = item.quad[1] > item.quad[5];
    let span: { top: number; height: number } | undefined;
    if (item.clip) {
      // Hold bodies and tails show through the hold note's mask.
      const clip = bounds(item.clip),
        top = Math.max(expected.y, clip.y),
        bottom = Math.min(expected.y + expected.height, clip.y + clip.height);
      // Until a hold's tail is alive (shortly before it scrolls in) lazer
      // positions the body as if the tail had no height; that end is off the
      // stage then, so only on-stage texture spans are compared.
      if (
        item.kind === "LegacyBodyPiece" &&
        expected.y >= 0 &&
        expected.y + expected.height <= STAGE
      )
        span = { top: expected.y, height: expected.height };
      expected = { ...expected, y: top, height: bottom - top };
    }
    // LegacyBarLine's box inflates its quad by its 0.3-unit edge smoothing.
    if (item.kind === "LegacyBarLine")
      expected = {
        x: expected.x + 0.3,
        y: expected.y + 0.3,
        width: expected.width - 0.6,
        height: expected.height - 0.6,
      };
    // Only what is on the stage: off-screen hold pieces keep stale layout in lazer.
    expected = clampToStage(expected);
    if (expected.width <= 0.001 || expected.height <= 0.001) continue;
    const accepts = candidates(item);
    if (accepts({ motion: 0 } as Placed)) lazerStatic.push(expected);
    const distance = (p: Placed) => {
      const rect = clampToStage(p.rect);
      return Math.max(
        Math.abs(rect.x - expected.x),
        Math.abs(rect.y - expected.y),
        Math.abs(rect.width - expected.width),
        Math.abs(rect.height - expected.height),
      );
    };
    const options = placed
        .filter(accepts)
        .sort((a, b) => distance(a) - distance(b)),
      nearest = options[0];
    if (!nearest || distance(nearest) > tolerance) {
      mismatches.push({ item, expected, nearest, reason: "rectangle" });
      continue;
    }
    // NoteBodyStyle: Stretch clamps the texture (ClampToEdge = 1), every
    // other style repeats it (Repeat = 3) over a 32800-unit sprite.
    if (
      item.kind === "LegacyBodyPiece" &&
      /:wrap-3-3$/.test(item.asset ?? "") !== (nearest.motion === 14)
    )
      mismatches.push({ item, expected, nearest, reason: "body style" });
    if (item.type === "Sprite" && nearest.flipped !== flipped)
      mismatches.push({ item, expected, nearest, reason: "flip" });
    if (
      span &&
      nearest.span &&
      (Math.abs(nearest.span.top - span.top) > tolerance ||
        Math.abs(nearest.span.height - span.height) > tolerance)
    )
      mismatches.push({ item, expected, nearest, reason: "body texture span" });
    if (item.type === "Box") {
      const [r, g, b] = nearest.colour;
      if (
        Math.max(
          Math.abs(r - item.colour[0]),
          Math.abs(g - item.colour[1]),
          Math.abs(b - item.colour[2]),
          Math.abs(nearest.colour[3] - item.alpha),
        ) > 0.01
      )
        mismatches.push({ item, expected, nearest, reason: "colour" });
    }
  }
  for (const p of placed) {
    const rect = clampToStage(p.rect);
    if (rect.width <= 0.001 || rect.height <= 0.001) continue;
    // A hold body lazer could not draw (its texture failed to load) must not
    // appear either.
    if ((p.motion === 2 || p.motion === 14) && p.asset) {
      const asset = p.asset.toLowerCase().replace(/-0$/, "");
      if (own(p.asset.toLowerCase()) && !lazerBodies.has(asset))
        mismatches.push({
          expected: rect,
          nearest: p,
          reason: "extra hold body",
        });
      continue;
    }
    if (p.motion !== 0) continue;
    if (p.asset && !own(p.asset.toLowerCase())) continue;
    const found = lazerStatic.some(
      (e) =>
        Math.max(
          Math.abs(rect.x - e.x),
          Math.abs(rect.y - e.y),
          Math.abs(rect.width - e.width),
          Math.abs(rect.height - e.height),
        ) <= tolerance,
    );
    if (!found)
      mismatches.push({
        expected: rect,
        nearest: p,
        reason: "extra stage element",
      });
  }
  return mismatches;
}
