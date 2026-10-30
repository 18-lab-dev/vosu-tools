/**
 * osu!lazer's legacy HUD components, drawn with Canvas 2D from a skin's
 * images: the score and accuracy counters (LegacyScoreCounter and
 * LegacyAccuracyCounter, whose LegacySpriteText uses the skin's score font)
 * and the health bar (LegacyHealthDisplay). Their animations (RollingCounter,
 * HealthDisplay's initial fill, fill easing, marker bulge and flash) are pure
 * functions of time, so any frame can be drawn on its own.
 *
 * Behaviour follows the MIT-licensed ppy/osu sources at tag 2026.1005.0-lazer
 * (commit 9a10d935b05a3b896f4bd811d620f2023331db93) and osu-framework's
 * TextBuilder; see PROVENANCE.md. Sizes are lazer UI units: osu! lays its
 * HUD out in a 1024×768 minimum-fit scaling container, where one unit holds
 * one SD skin pixel.
 */
import type { Skin } from "./skin";
import { loadImages } from "./skin";
import { classicHud } from "./builtin";

/** A skin image at its display size (SD pixels: @2x images count half). */
export interface HudImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}
/** One LegacySpriteText font: glyphs by character and its overlap. */
export interface HudFont {
  glyphs: ReadonlyMap<string, HudImage>;
  /** ScoreOverlap / ComboOverlap: pixels removed between characters. */
  overlap: number;
}
/** What the HUD draws with: a skin's images, the classic look's where it has none. */
export interface Hud {
  /** LegacyFont.Score (ScorePrefix): the score and accuracy counters. */
  score: HudFont;
  /** LegacyFont.Combo (ComboPrefix): the combo counters. */
  combo: HudFont;
  health: {
    bg?: HudImage;
    /** `scorebar-colour`, or its animation frames. */
    fill: HudImage[];
    frameLength: number;
    /** New style: `scorebar-marker`; old style: the `ki` images. */
    newStyle: boolean;
    marker?: HudImage;
    ki?: HudImage;
    kidanger?: HudImage;
    kidanger2?: HudImage;
  };
  /** Closes the skin's own HUD bitmaps (the classic look's are shared). */
  close(): void;
}

const GLYPH_NAMES: Record<string, string> = { ",": "comma", ".": "dot", "%": "percent" };
const SCORE_CHARACTERS = [..."0123456789,.%x"];
const COMBO_CHARACTERS = [..."0123456789x"];
/** LegacySpriteText's FixedWidthExcludeCharacters: drawn at their own width. */
const PROPORTIONAL: Record<string, true> = { ",": true, ".": true, "%": true, x: true };
const HEALTH_IMAGES = [
  "scorebar-bg",
  "scorebar-colour",
  "scorebar-marker",
  "scorebar-ki",
  "scorebar-kidanger",
  "scorebar-kidanger2",
];
/** LegacyFill: the only animated HUD element (`GetAnimation`, looping). */
const ANIMATED: ReadonlySet<string> = new Set(["scorebar-colour"]);
/** LegacySkin.STABLE_MAGIC_SCALE_FACTOR, which the health pieces' offsets use. */
const STABLE_SCALE = 1.6;
const NEW_FILL = [7.5 * STABLE_SCALE, 7.8 * STABLE_SCALE] as const;
const OLD_FILL = [3 * STABLE_SCALE, 10 * STABLE_SCALE] as const;
/** The counters' own scales (LegacyScoreCounter, LegacyAccuracyCounter). */
export const SCORE_SCALE = 0.96;
export const ACCURACY_SCALE = 0.6 * 0.96;

function fontOf(skin: Pick<Skin, "sections">, font: "Score" | "Combo") {
  const fonts = skin.sections.get("Fonts")?.[0];
  return {
    prefix: fonts?.[`${font}Prefix`] ?? "score",
    overlap: Number(fonts?.[`${font}Overlap`] ?? 0) || 0,
  };
}
const glyphName = (prefix: string, char: string) => `${prefix}-${GLYPH_NAMES[char] ?? char}`;
/** The images the HUD looks up in a skin: its score and combo fonts (ScorePrefix, ComboPrefix) and the health bar's. */
export function hudImageNames(skin: Pick<Skin, "sections">): string[] {
  const score = fontOf(skin, "Score").prefix,
    combo = fontOf(skin, "Combo").prefix;
  return [
    ...new Set([
      ...SCORE_CHARACTERS.map((char) => glyphName(score, char)),
      ...COMBO_CHARACTERS.map((char) => glyphName(combo, char)),
      ...HEALTH_IMAGES,
    ]),
  ];
}
function image(skin: Skin | undefined, name: string): HudImage | undefined {
  const bitmap = skin?.assets.get(name);
  if (!bitmap) return undefined;
  const scale = skin!.pixelScale?.get(name) ?? 1;
  return { bitmap, width: bitmap.width / scale, height: bitmap.height / scale };
}
let classic: Skin | undefined;
/**
 * The HUD for a skin loaded from files (`loadSkin`), or for a built-in look
 * when `files` is null: lazer draws built-ins and skins lacking these images
 * with its classic skin's, here drawn originals (`classicHud`).
 */
export async function loadHud(files: Skin | null): Promise<Hud> {
  const own = files ? await loadImages(files, hudImageNames(files), ANIMATED) : null;
  classic ??= classicHud();
  return hudOf(own, classic);
}
/** A font's glyphs: each falls through the skin chain on its own, under the
 *  skin's prefix, so the classic font fills in only for skins that keep the
 *  default prefix. */
function font(own: Skin | null, fallback: Skin, name: "Score" | "Combo", characters: readonly string[]): HudFont {
  const { prefix, overlap } = fontOf(own ?? fallback, name);
  const glyphs = new Map<string, HudImage>();
  for (const char of characters) {
    const found = image(own ?? undefined, glyphName(prefix, char)) ?? image(fallback, glyphName(prefix, char));
    if (found) glyphs.set(char, found);
  }
  return { glyphs, overlap };
}
/** The HUD from a skin's HUD images (`own`, null for none) over `fallback`. */
export function hudOf(own: Skin | null, fallback: Skin): Hud {
  // LegacyHealthDisplay takes every piece from the first skin with a background.
  const provider = own?.assets.has("scorebar-bg") ? own : fallback;
  const frames = provider.animations?.get("scorebar-colour");
  const fill = (frames ?? ["scorebar-colour"])
    .map((name) => image(provider, name))
    .filter((frame) => !!frame);
  const marker = image(provider, "scorebar-marker");
  return {
    score: font(own, fallback, "Score", SCORE_CHARACTERS),
    combo: font(own, fallback, "Combo", COMBO_CHARACTERS),
    health: {
      bg: image(provider, "scorebar-bg"),
      fill,
      // getFrameLength with applyConfigFrameRate: the ini rate, else the whole loop in a second.
      frameLength: (provider.frameRate ?? -1) > 0 ? 1000 / provider.frameRate! : 1000 / Math.max(1, fill.length),
      newStyle: !!marker,
      marker,
      ki: image(provider, "scorebar-ki"),
      kidanger: image(provider, "scorebar-kidanger"),
      kidanger2: image(provider, "scorebar-kidanger2"),
    },
    close() {
      for (const bitmap of own?.assets.values() ?? []) bitmap.close();
    },
  };
}

/* --------------------------------------------------------------- text */

export interface HudText {
  width: number;
  height: number;
  glyphs: { image: HudImage; x: number }[];
}
/**
 * LegacySpriteText (osu-framework's TextBuilder): glyphs sit on one top line
 * and the font's overlap is negative spacing between characters. With
 * `fixedWidth` (the score and accuracy counters) digits advance by the width
 * of '5' and are centred in it, while `, . % x` keep their own width; combo
 * counters are proportional. Characters the font lacks are skipped.
 */
export function hudText(font: HudFont, text: string, fixedWidth = true): HudText {
  const fixed = font.glyphs.get("5")?.width ?? 0;
  const glyphs: HudText["glyphs"] = [];
  let x = 0,
    width = 0,
    height = 0;
  for (const char of text) {
    const glyph = font.glyphs.get(char);
    if (!glyph) continue;
    if (glyphs.length) x -= font.overlap;
    const own = !fixedWidth || PROPORTIONAL[char] === true;
    glyphs.push({ image: glyph, x: x + (own ? 0 : (fixed - glyph.width) / 2) });
    x += own ? glyph.width : fixed;
    width = Math.max(width, x);
    height = Math.max(height, glyph.height);
  }
  return { width, height, glyphs };
}
/** How `drawHudText` transforms the text around a point of its own. */
export interface HudTextStyle {
  /** The point (text units) that stays put under `stretch`; the top-left corner by default. */
  origin?: readonly [number, number];
  stretch?: readonly [number, number];
  alpha?: number;
  additive?: boolean;
  /** Multiplies the glyphs' colour (RGB, 0-1). */
  tint?: Rgb;
}
/**
 * Draws `text` with its point `origin` at (`x`, `y`), `scale` output px per
 * unit, stretched around that point.
 */
export function drawHudText(
  context: CanvasRenderingContext2D,
  text: HudText,
  x: number,
  y: number,
  scale: number,
  style: HudTextStyle = {},
) {
  const [ox, oy] = style.origin ?? [0, 0],
    [kx, ky] = style.stretch ?? [1, 1],
    alpha = style.alpha ?? 1;
  if (alpha <= 0) return;
  context.save();
  context.globalAlpha *= alpha;
  if (style.additive) context.globalCompositeOperation = "lighter";
  const sx = scale * kx,
    sy = scale * ky;
  for (const { image, x: at } of text.glyphs)
    drawTinted(context, image, 1, x + (at - ox) * sx, y - oy * sy, image.width * sx, image.height * sy, style.tint ?? WHITE);
  context.restore();
}
/** lazer's FormatAccuracy: floored to two decimals of a percent, never rounded up. */
export function formatAccuracy(accuracy: number): string {
  return `${(Math.floor(accuracy * 10000 + 1e-7) / 100).toFixed(2)}%`;
}

/* ------------------------------------------------------------ counters */

const outQuad = (p: number) => p * (2 - p);
const outQuint = (p: number) => 1 - (1 - p) ** 5;
/**
 * A RollingCounter's shown value: each change rolls from the value shown at
 * that moment to the new one over `duration` ms with Easing.Out.
 */
export interface Rolling {
  times: readonly number[];
  values: readonly number[];
  /** The shown value when each change began. */
  from: readonly number[];
  initial: number;
  duration: number;
}
export function rolling(times: readonly number[], values: readonly number[], initial: number, duration: number): Rolling {
  const from: number[] = [];
  const curve = { times, values, from, initial, duration };
  for (let i = 0; i < times.length; i++) from.push(i ? shown(curve, i - 1, times[i]) : initial);
  return curve;
}
function shown(curve: Rolling, i: number, time: number) {
  const p = Math.min(1, Math.max(0, (time - curve.times[i]) / curve.duration));
  return curve.from[i] + (curve.values[i] - curve.from[i]) * outQuad(p);
}
export function rollingAt(curve: Rolling, time: number): number {
  let low = 0,
    high = curve.times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (curve.times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low ? shown(curve, low - 1, time) : curve.initial;
}

/* --------------------------------------------------------------- combo */

/** The combo after each judgement that changed it, in time order. */
export interface ComboChange {
  time: number;
  combo: number;
}
/** A combo counter at one moment: the shown count and the pop-out copy over it. */
export interface ComboFrame {
  count: number;
  alpha: number;
  stretch: readonly [number, number];
  popOut: { count: number; alpha: number; scale: number } | null;
}
/** Changes from per-judgement combo values, dropping judgements that left it alone. */
export function comboChanges(events: readonly { time: number; combo: number }[]): ComboChange[] {
  const changes: ComboChange[] = [];
  let last = 0;
  for (const { time, combo } of events)
    if (combo !== last) changes.push({ time, combo: (last = combo) });
  return changes;
}
/** Index of the last change at or before `time`; -1 before the first. */
function lastChange(changes: readonly ComboChange[], time: number) {
  let low = 0,
    high = changes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (changes[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
const IDLE: ComboFrame = { count: 0, alpha: 0, stretch: [1, 1], popOut: null };
/** Both counters roll a break down to 0 at 20 ms per count, interrupted by the next change. */
const ROLL_MS = 20;
function rolledDown(from: number, age: number) {
  const count = from ? Math.round(from * (1 - Math.min(1, age / (from * ROLL_MS)))) : 0;
  // The rounded count reaches 0 half a step before the roll ends.
  return { count, zeroAge: from ? (from - 0.5) * ROLL_MS : 0 };
}
const POP_MS = 300;
const SMALL_POP_DELAY = POP_MS - 140;
/** transformPopOutSmall: 1 → 1.1 over 50 ms (In), back over 50 ms (Out). */
function smallPop(age: number) {
  if (age < 0 || age >= 100) return 1;
  return age < 50 ? 1 + 0.1 * (age / 50) ** 2 : 1.1 - 0.1 * outQuad((age - 50) / 50);
}
/**
 * LegacyDefaultComboCounter (osu!, taiko): an increment pops the new count
 * out (1.56× shrinking to 1× and 0.6 alpha fading over 300 ms) and the shown
 * count follows 160 ms later with a small pop; a break rolls the shown count
 * down; other jumps show at once. A count of 0 hides.
 */
export function legacyComboFrame(changes: readonly ComboChange[], time: number): ComboFrame {
  const i = lastChange(changes, time);
  if (i < 0) return IDLE;
  const { time: at, combo } = changes[i],
    age = time - at,
    prev = i ? changes[i - 1].combo : 0;
  // The shown count just before this change: an increment shows its count only 160 ms on.
  const previous = changes[i - 1],
    beforePrev = i > 1 ? changes[i - 2].combo : 0;
  const before =
    !previous || previous.combo === 0
      ? 0
      : previous.combo === beforePrev + 1 && at - previous.time < SMALL_POP_DELAY
        ? beforePrev
        : previous.combo;
  // The pop-out belongs to the latest increment and is left alone by other changes.
  let popOut: ComboFrame["popOut"] = null;
  for (let j = i; j >= 0 && time - changes[j].time < POP_MS; j--)
    if (changes[j].combo === (j ? changes[j - 1].combo : 0) + 1) {
      const p = (time - changes[j].time) / POP_MS;
      popOut = { count: changes[j].combo, alpha: 0.6 * (1 - p), scale: 1.56 - 0.56 * p };
      break;
    }
  if (combo === 0) {
    const { count, zeroAge } = rolledDown(before, age);
    return { count, alpha: age < zeroAge ? 1 : Math.max(0, 1 - (age - zeroAge) / 100), stretch: [1, 1], popOut };
  }
  if (combo === prev + 1) {
    const shown = age >= SMALL_POP_DELAY;
    // Catching up to the previous count (set at this change) pops small too.
    const pop = shown ? smallPop(age - SMALL_POP_DELAY) : before === prev - 1 ? smallPop(age) : 1;
    return { count: shown ? combo : prev, alpha: 1, stretch: [pop, pop], popOut };
  }
  return { count: combo, alpha: 1, stretch: [1, 1], popOut };
}
/**
 * LegacyManiaComboCounter: an increment shows the new count stretched to 1.4×
 * tall, settling over 300 ms (Out); a break pops the lost count out in the
 * skin's ColourBreak (4× and fading over 200 ms) while the shown count rolls
 * down; other jumps show at once. A count of 0 hides.
 */
export function maniaComboFrame(changes: readonly ComboChange[], time: number): ComboFrame {
  const i = lastChange(changes, time);
  if (i < 0) return IDLE;
  const { time: at, combo } = changes[i],
    age = time - at,
    prev = i ? changes[i - 1].combo : 0;
  if (combo === 0) {
    const { count } = rolledDown(prev, age);
    return {
      count,
      alpha: count ? 1 : 0,
      stretch: [1, 1],
      popOut: prev && age < 200 ? { count: prev, alpha: 0.8 * (1 - age / 200), scale: 1 + (3 * age) / 200 } : null,
    };
  }
  const stretch = combo === prev + 1 && age < POP_MS ? 1.4 - 0.4 * outQuad(age / POP_MS) : 1;
  return { count: combo, alpha: 1, stretch: [1, stretch], popOut: null };
}

/* -------------------------------------------------------------- health */

/** The health a HUD shows over a play. */
export interface HealthSource {
  /** The health processor's value at a time (0-1). */
  value(time: number): number;
  /** When the HUD appeared (gameplay start): the initial fill runs from here. */
  start: number;
  /** The first time the value differs from `value(start)`; Infinity when it never does. */
  settled: number;
  /** Sorted times of hit judgements, which flash the marker. */
  hits: readonly number[];
}
/** LegacyHealthDisplay's state at one moment. */
export interface HealthFrame {
  /** HealthDisplay.Current: colours and the old style's marker image follow it. */
  current: number;
  /** The fill's eased width, a fraction of its image. */
  fill: number;
  /** The marker's bulge scale. */
  bulge: number;
  /** The marker's flash sprite, while it plays. */
  flash: { age: number; epic: boolean } | null;
  /** Time since the HUD appeared: the fill animation's clock. */
  clock: number;
}
/** lazer's update rate for the frame-dependent fill easing; a fixed grid keeps frames reproducible. */
const UPDATE = 1000 / 60;
const STEP_DELAY = 150;
const STEP = 0.05;
const EPIC = 0.5;
/**
 * HealthDisplay.Current: from the HUD's appearance it rises 0.05 every 150 ms
 * (each step linear over 150 ms, each a flash) until it holds the health it
 * started with, or until the health first changes; then it is the health.
 */
function current(source: HealthSource, initial: number, time: number) {
  if (time >= source.settled) return source.value(time);
  const k = Math.floor((time - source.start) / STEP_DELAY),
    steps = Math.ceil(initial / STEP - 1e-9);
  if (k >= steps) return source.value(time);
  if (k < 1) return 0;
  const from = Math.min(STEP * (k - 1), initial),
    to = Math.min(STEP * k, initial);
  return from + (to - from) * ((time - source.start - STEP_DELAY * k) / STEP_DELAY);
}
export function healthFrame(source: HealthSource, time: number): HealthFrame {
  const initial = source.value(source.start);
  const clock = Math.max(0, time - source.start);
  // The fill eases towards Current every frame (Interpolation.ValueAt with
  // OutQuint over 200 ms); after half a second the start no longer shows.
  const last = Math.floor(clock / UPDATE),
    first = Math.max(0, last - 30);
  const at = (n: number) => source.start + n * UPDATE;
  let fill = first ? current(source, initial, at(first)) : 0,
    previous = current(source, initial, at(first)),
    bulged: number | undefined;
  const ease = outQuint(UPDATE / 200);
  for (let n = first + 1; n <= last; n++) {
    const value = current(source, initial, at(n));
    fill += (value - fill) * ease;
    // HealthChanged(increase): a bulge whenever Current rose by more than 0.001.
    if (Math.abs(value - previous) > 0.001) {
      if (value > previous) bulged = at(n);
      previous = value;
    }
  }
  // Flashes: hit judgements, and each step of the initial fill.
  let low = 0,
    high = source.hits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source.hits[middle] <= time) low = middle + 1;
    else high = middle;
  }
  let flashed = low ? source.hits[low - 1] : undefined;
  // The last step of the initial fill so far, while it still ran (before the health changed).
  const step = Math.min(
    Math.ceil(initial / STEP - 1e-9),
    Math.floor(clock / STEP_DELAY),
    Math.ceil((source.settled - source.start) / STEP_DELAY) - 1,
  );
  if (step >= 1) flashed = Math.max(flashed ?? -Infinity, source.start + step * STEP_DELAY);
  const bulge = Math.max(bulged ?? -Infinity, flashed ?? -Infinity);
  const age = time - bulge;
  return {
    current: current(source, initial, time),
    fill: Math.min(1, Math.max(0, fill)),
    // Bulge: 1.2 at once, then 0.8 over 150 ms, where it stays.
    bulge: bulge === -Infinity ? 1 : age < 150 ? 1.2 - (0.4 * age) / 150 : 0.8,
    flash:
      flashed !== undefined && time - flashed < 120
        ? { age: time - flashed, epic: current(source, initial, flashed) >= EPIC }
        : null,
    clock,
  };
}
/** The health bar's box at scale 1: its background and the full fill. */
export function healthSize(hud: Hud): { width: number; height: number } {
  const { bg, fill, newStyle } = hud.health,
    [fx, fy] = newStyle ? NEW_FILL : OLD_FILL;
  return {
    width: Math.max(bg?.width ?? 0, fill[0] ? fx + fill[0].width : 0),
    height: Math.max(bg?.height ?? 0, fill[0] ? fy + fill[0].height : 0),
  };
}
type Rgb = readonly [number, number, number];
const WHITE: Rgb = [1, 1, 1];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};
/** getFillColour: white, darkening below half health, reddening below a fifth. */
function fillColour(hp: number): Rgb {
  if (hp < 0.2) return mix([0, 0, 0], [1, 0, 0], (0.2 - hp) / 0.2);
  if (hp < EPIC) return mix(WHITE, [0, 0, 0], (EPIC - hp) / 0.5);
  return WHITE;
}
let scratch: OffscreenCanvasRenderingContext2D | undefined;
/** Draws the left `fraction` of `image` tinted by `colour` (osu!framework's multiplicative Colour). */
function drawTinted(
  context: CanvasRenderingContext2D,
  image: HudImage,
  fraction: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: Rgb,
) {
  const sw = Math.max(1, Math.round(image.bitmap.width * fraction)),
    sh = image.bitmap.height;
  if (colour.every((c) => c === 1)) {
    context.drawImage(image.bitmap, 0, 0, sw, sh, x, y, width, height);
    return;
  }
  scratch ??= new OffscreenCanvas(sw, sh).getContext("2d")!;
  const g = scratch,
    canvas = g.canvas;
  if (canvas.width < sw || canvas.height < sh) {
    canvas.width = Math.max(canvas.width, sw);
    canvas.height = Math.max(canvas.height, sh);
  }
  g.globalCompositeOperation = "copy";
  g.drawImage(image.bitmap, 0, 0, sw, sh, 0, 0, sw, sh);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = `rgb(${colour.map((c) => Math.round(c * 255)).join(",")})`;
  g.fillRect(0, 0, sw, sh);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(image.bitmap, 0, 0, sw, sh, 0, 0, sw, sh);
  context.drawImage(canvas, 0, 0, sw, sh, x, y, width, height);
}
/** A marker sprite centred on (`x`, `y`) in the health bar's units. */
function drawMarker(
  context: CanvasRenderingContext2D,
  image: HudImage,
  x: number,
  y: number,
  scale: number,
  colour: Rgb,
  alpha: number,
  additive: boolean,
) {
  if (alpha <= 0) return;
  context.save();
  context.globalAlpha *= alpha;
  if (additive) context.globalCompositeOperation = "lighter";
  const w = image.width * scale,
    h = image.height * scale;
  drawTinted(context, image, 1, x - w / 2, y - h / 2, w, h, colour);
  context.restore();
}
/** Draws LegacyHealthDisplay with its top-left corner at (`x`, `y`), `scale` output px per unit. */
export function drawHealth(
  context: CanvasRenderingContext2D,
  hud: Hud,
  frame: HealthFrame,
  x: number,
  y: number,
  scale: number,
) {
  const h = hud.health;
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  if (h.bg) context.drawImage(h.bg.bitmap, 0, 0, h.bg.width, h.bg.height);
  const [fx, fy] = h.newStyle ? NEW_FILL : OLD_FILL,
    size = h.fill[0],
    width = size ? frame.fill * size.width : 0;
  if (size && width > 0) {
    const index = Math.floor(frame.clock / h.frameLength) % h.fill.length;
    drawTinted(context, h.fill[index], frame.fill, fx, fy, width, size.height, h.newStyle ? fillColour(frame.current) : WHITE);
  }
  const marker = h.newStyle
    ? h.marker
    : frame.current < 0.2
      ? h.kidanger2
      : frame.current < EPIC
        ? h.kidanger
        : h.ki;
  if (marker) {
    const mx = fx + width,
      my = fy + (h.newStyle && size ? size.height / 2 : 0);
    // New style: the marker takes the fill's colour and adds light from half health up.
    drawMarker(
      context,
      marker,
      mx,
      my,
      frame.bulge,
      h.newStyle ? fillColour(frame.current) : WHITE,
      1,
      h.newStyle && frame.current >= EPIC,
    );
    if (frame.flash) {
      const p = outQuad(Math.min(1, frame.flash.age / 120));
      drawMarker(context, marker, mx, my, 1 + ((frame.flash.epic ? 2 : 1.6) - 1) * p, WHITE, 1 - p, frame.flash.epic);
    }
  }
  context.restore();
}
