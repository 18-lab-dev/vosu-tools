/**
 * Compares render-core's osu!taiko and osu!catch scenes against osu!lazer's
 * own drawables, as dumped by test/reference/VosuLayout.cs (see
 * test/layoutGolden.ts).
 *
 * The scene's instances are evaluated on the CPU with the same arithmetic as
 * the WGSL vertex stage and converted to lazer's game space. Every legacy skin
 * element lazer drew from the skin must have a counterpart with the same
 * image, centre, size, rotation, colour and opacity, and render-core must not
 * draw skin elements lazer does not. Elements render-core deliberately does
 * not reproduce are listed in `UNMODELLED`.
 */
import { parseOsu } from "@vosu-tools/osu-parse";
import { gameSpace, SPACE_SCALE } from "../src/taiko";
import { compileScene, type RenderOptions } from "../src/scene";
import type { AtlasRegion, Skin } from "../src/skin";
import { caseless, goldenAsset } from "./maniaCompare";
import { evaluateJudgement } from "./judgementCompare";

export interface LayoutCase {
  name: string;
  /** osu! and mania only appear in judgement goldens (judgementCompare.ts). */
  ruleset: "taiko" | "catch" | "osu" | "mania";
  /** Skin name (fixtures) or folder (real runs). */
  skin: string;
  /** The .osu text (fixtures) or path (real runs). */
  map: string;
  width: number;
  height: number;
  time: number;
  mapColours?: boolean;
  normalisation?: number;
}
export interface LayoutItem {
  type: string;
  path: string[];
  texture: {
    name: string | null;
    display: [number, number];
  } | null;
  alpha: number;
  colour: [number, number, number];
  additive: boolean;
  /** TL, TR, BL, BR in game space. */
  quad: number[];
  clip: number[] | null;
}
export interface LayoutResult {
  name: string;
  size: [number, number];
  items: LayoutItem[];
}

/**
 * Drawables these layout cases do not compare: the input drum's key flashes
 * and the mascot (both follow input/animation state), drum roll tick hits
 * flying off the playfield, swell clear text, catcher dash trails and the
 * plate's stacked fruits (positions come from lazer's unseeded RNG).
 * Judgement sprites and catch hit lighting follow replay results, which these
 * cases do not supply; the judgement goldens (judgementCompare.ts) cover them.
 */
const UNMODELLED = [
  /^hit(0|50|100|300)[gk]?$/,
  /^taiko-drum-(inner|outer)$/,
  /^pippidon/,
  /^spinner-osu$/,
  /^scoreboard-explosion/,
];
const unmodelledPath = (path: string[]) =>
  path.some((p) =>
    /^(DrawableFlyingHit|CatcherTrail|CatcherTrailSprite|CaughtFruit|CaughtDroplet|CaughtBanana|LegacyRollingCounter|LegacySpriteText)/.test(
      p,
    ),
  );

export interface PlacedItem {
  index: number;
  asset: string;
  centre: [number, number];
  size: [number, number];
  /** Degrees. */
  angle: number;
  colour: number[];
  alpha: number;
  motion: number;
}

/**
 * Elements render-core's built-in classic look provides beneath a file skin
 * (lazer takes them from its classic skin): the clients pick, for example,
 * the big-note overlay from there before the skin's normal overlay.
 */
const CLASSIC = [
  "taikohitcircle",
  "taikohitcircleoverlay",
  "taikobigcircle",
  "taikobigcircleoverlay",
  "fruit-pear",
  "fruit-grapes",
  "fruit-apple",
  "fruit-orange",
  "fruit-drop",
  "fruit-bananas",
  "fruit-catcher-idle",
  "fruit-catcher-kiai",
  "fruit-catcher-fail",
];
/** The skin's regions layered over the classic look's (dummy regions, never compared). */
export function withClassic(
  regions: Map<string, AtlasRegion>,
): Map<string, AtlasRegion> {
  const out = caseless(regions);
  let first = 100000;
  for (const name of CLASSIC)
    if (!out.has(name))
      out.set(name, {
        u: 0,
        v: 0,
        w: 0.01,
        h: 0.01,
        width: 64,
        height: 64,
        first: first++,
        count: 1,
      });
  return out;
}

/** Every visible textured instance at `c.time`, in lazer game space. */
export function placeLayout(
  c: LayoutCase,
  mapText: string,
  skin: Skin,
  regions: Map<string, AtlasRegion>,
  options: RenderOptions = {},
): PlacedItem[] {
  const map = parseOsu(mapText);
  map.mode = ({ osu: 0, taiko: 1, catch: 2, mania: 3 } as const)[c.ruleset];
  const aspect = c.width / c.height,
    scene = compileScene(
      map,
      {
        beatmapColours: c.mapColours ?? false,
        comboColourNormalisation: c.normalisation ?? 0.2,
        ...options,
      },
      regions,
      skin,
      aspect,
    ),
    space = gameSpace(aspect),
    now = c.time,
    names = new Map([...regions].map(([name, uv]) => [uv.first, name]));
  // The catcher: interpolated between catches, facing its last move.
  let catcherX = 256,
    direction = 1,
    hyper = 0;
  if (scene.catcher.length) {
    const a = scene.catcher;
    let lo = 0;
    while (lo < a.length && a[lo].time < now) lo++;
    const p = a[Math.max(0, lo - 1)],
      q = a[Math.min(a.length - 1, lo)],
      f =
        q.time === p.time
          ? 1
          : Math.max(0, Math.min(1, (now - p.time) / (q.time - p.time)));
    catcherX = p.x + (q.x - p.x) * f;
    for (let i = Math.min(a.length - 1, lo); i > 0; i--)
      if (a[i].x !== a[i - 1].x && a[i - 1].time < now) {
        direction = a[i].x > a[i - 1].x ? 1 : -1;
        break;
      }
  }
  const last = [...scene.hyper].reverse().find((h) => h.start <= now);
  const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 5);
  if (last)
    hyper =
      now <= last.end
        ? ease((now - last.start) / 180)
        : ease((last.end - last.start) / 180) *
          (1 - ease((now - last.end) / 180));
  const out: PlacedItem[] = [];
  for (let i = 0; i < scene.count; i++) {
    const d = scene.data.subarray(i * 24, i * 24 + 24);
    const [x0, y0, w0, h0, start, end, from, until] = d;
    const kind = d[12],
      [a, b, cc] = [d[13], d[14], d[15]],
      code = d[20];
    if (code !== 10 && code !== 13) continue;
    // Lifetimes are float32 in the instance data, as the shader compares them.
    if (Math.fround(now) < from || Math.fround(now) > until) continue;
    let x = x0,
      y = y0,
      w = w0,
      h = h0,
      angle = 0,
      alpha = d[11];
    let colour = [d[8], d[9], d[10]];
    if (kind === 35) {
      const j = evaluateJudgement(d, now, catcherX);
      ({ x, y, w, h, angle } = j);
      alpha = j.alpha;
    } else if (kind === 36) {
      x = x0 + (start - now) * a;
      if (now > start) alpha *= Math.max(0, Math.min(1, 1 - (now - start) / b));
    } else if (kind === 3) {
      x = x0 + (start - now) * a;
      if (map.mode === 1 && now > start) continue;
    } else if (kind === 4) x = x0 + (start - now) * a + w / 2;
    else if (kind === 10) {
      const k = Math.max(
        0,
        Math.min(1, (end - now) / Math.max(1, end - start)),
      );
      w *= k;
      h *= k;
    } else if (kind === 23) {
      const travel = now * a;
      x = x0 - (travel - Math.floor(travel / b) * b);
    } else if (kind === 24) {
      y = y0 - (start - now) * scene.speed;
      angle = a + (now - start) * b;
      const k = Math.max(0, 1 + (now - start) * cc);
      w *= k;
      h *= k;
    } else if (kind === 25) {
      const dt = Math.max(0, now - start),
        rise = 1 - Math.min(dt / 300, 1),
        fall = Math.max(0, Math.min(1, (dt - 300) / 600)),
        shrink = 1 - Math.min(dt / 600, 1),
        k = 1 - 0.2 * (1 - shrink * shrink);
      x = x0 + (start - now) * a;
      y =
        y0 +
        (dt >= 300 ? -200 + 600 * fall * fall : -200 * (1 - rise * rise)) * b;
      w *= k;
      h *= k;
      alpha *= Math.max(0, Math.min(1, 1 - dt / 800));
    } else if (kind === 27) {
      const dt = now - start;
      alpha *=
        dt < 120
          ? Math.max(0, dt / 120)
          : Math.max(0, Math.min(1, 1 - (dt - 120) / 180));
      if (a > 0.5) {
        const k =
          dt < 96
            ? 0.6 + (0.5 * dt) / 96
            : dt < 144
              ? 1.1 - (0.2 * (dt - 96)) / 48
              : dt < 168
                ? 0.9 + (0.1 * (dt - 144)) / 24
                : 1;
        w *= k;
        h *= k;
      }
    } else if (kind === 28)
      alpha *=
        Math.max(0, Math.min(1, (now - a) / 200)) *
        Math.max(0, Math.min(1, 1 - (now - b) / cc));
    else if (kind === 32) {
      x = x0 + (start - now) * a;
      if (now > start) {
        const u = 1 - Math.max(0, Math.min(1, (now - start) / 200)),
          e = 1 - u ** 5;
        w *= 1 + 0.4 * e;
        h *= 1 + 0.4 * e;
        alpha *= 1 - e;
      }
    } else if (kind === 33 || kind === 34) {
      if (kind === 33) angle = d[15];
      if (now < b) alpha *= Math.max(0, Math.min(1, (now - a) / 200));
      else {
        const u = 1 - Math.max(0, Math.min(1, (now - b) / 300));
        alpha *= Math.max(0, Math.min(1, (b - a) / 200)) * u * u;
      }
      if (kind === 34) {
        const k = Math.max(
          0,
          Math.min(1, (end - now) / Math.max(1, end - start)),
        );
        w *= k;
        h *= k;
      }
    } else if (kind === 30) {
      x = catcherX + a;
      angle = b;
    } else if (kind === 31) {
      x = x0 + (start - now) * a + w / 2;
      if (now > start)
        alpha *= Math.max(0, Math.min(1, 1 - (now - start) / 150));
    } else if (kind >= 15 && kind <= 17) {
      // The renderer's catcher state: kiai during kiai time, else idle.
      let state = 0;
      for (const point of map.timing)
        if (point.time <= now) state = point.effects & 1;
      if (kind - 15 !== state) continue;
      x = catcherX;
      w *= direction;
      // FadeColour mixes in linear light.
      const lin = (c: number) =>
          c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
        srgb = (c: number) =>
          c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
      colour = colour.map((t) => srgb(1 + (lin(t) - 1) * hyper));
    }
    if (from > -1e8 && now > end && kind !== 35)
      alpha *= Math.max(0, Math.min(1, 1 - (now - end) / 120));
    if (
      map.mode === 1 &&
      (kind === 3 || kind === 4 || kind === 32) &&
      x + Math.abs(w) / 2 < scene.clipX
    )
      continue;
    if (alpha < 0.02) continue;
    out.push({
      index: i,
      asset: names.get(d[21]) ?? "",
      centre: [
        (x - 256) * SPACE_SCALE + space.width / 2,
        (y - 192) * SPACE_SCALE + space.height / 2,
      ],
      size: [Math.abs(w) * SPACE_SCALE, h * SPACE_SCALE],
      // A mirrored sprite's quad runs right to left, like a half turn.
      angle: (angle * 180) / Math.PI + (w < 0 ? 180 : 0),
      colour,
      alpha,
      motion: kind,
    });
  }
  return out;
}

export interface LayoutMismatch {
  reason: string;
  asset: string;
  expected?: {
    centre: number[];
    size: number[];
    angle: number;
    alpha: number;
    colour: number[];
  };
  nearest?: PlacedItem;
}

/** Centre, size and rotation of a lazer quad. */
function shape(quad: number[]) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
  return {
    centre: [(x0 + x3) / 2, (y0 + y3) / 2],
    size: [Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x0, y2 - y0)],
    angle: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI,
    // A mirrored quad (negative x scale) has its top-right left of its top-left.
    mirrored: (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0) < 0,
  };
}
const angleDelta = (a: number, b: number) =>
  Math.abs(((a - b + 540) % 360) - 180);

/**
 * Lazer's elements against render-core's. `own` limits the comparison to
 * images the skin provides (lazer falls back to its classic skin otherwise).
 */
export function compareLayout(
  c: LayoutCase,
  result: LayoutResult,
  placed: PlacedItem[],
  own: (asset: string) => boolean = () => true,
  tolerance = 1.5,
): LayoutMismatch[] {
  const mismatches: LayoutMismatch[] = [],
    used = new Set<number>(),
    [width, height] = result.size;
  const visible = (centre: number[], size: number[]) =>
    centre[0] + size[0] / 2 > 0 &&
    centre[0] - size[0] / 2 < width &&
    centre[1] + size[1] / 2 > 0 &&
    centre[1] - size[1] / 2 < height;
  for (const item of result.items) {
    if (!item.texture || item.alpha < 0.05) continue;
    // Images over a size cap are cropped copies that lose their name; they
    // are matched by geometry alone.
    const asset = item.texture.name
      ? goldenAsset(item.texture.name).replace(/-0$/, "")
      : null;
    if (
      (asset && (!own(asset) || UNMODELLED.some((r) => r.test(asset)))) ||
      unmodelledPath(item.path)
    )
      continue;
    const s = shape(item.quad);
    if (!visible(s.centre, s.size)) continue;
    // Hit taiko notes are proxied above the playfield, outside its mask.
    if (item.clip && !item.path.includes("ProxiedContentContainer")) {
      const xs = item.clip.filter((_, i) => i % 2 === 0);
      if (s.centre[0] + s.size[0] / 2 <= Math.min(...xs)) continue;
    }
    const expected = {
      centre: s.centre,
      size: s.size,
      angle: s.angle,
      alpha: item.alpha,
      colour: item.colour,
    };
    const candidates = placed.filter(
      (p) =>
        !used.has(p.index) &&
        (asset ? p.asset.replace(/-0$/, "") === asset : own(p.asset)),
    );
    const distance = (p: PlacedItem) =>
      Math.hypot(p.centre[0] - s.centre[0], p.centre[1] - s.centre[1]);
    candidates.sort((p, q) => distance(p) - distance(q));
    const nearest = candidates[0];
    if (!nearest || distance(nearest) > tolerance) {
      mismatches.push({
        reason: "position",
        asset: asset ?? "(cropped image)",
        expected,
        nearest,
      });
      continue;
    }
    used.add(nearest.index);
    // The swell's spinner circle is damped per frame in lazer (scale and
    // turn follow hits with half-lives), so the harness's frame steps decide
    // its exact value: compare it within 3 % and without its turn.
    const damped = nearest.asset === "spinner-circle",
      sizeTolerance = damped ? s.size[0] * 0.03 : tolerance;
    if (
      Math.abs(nearest.size[0] - s.size[0]) > sizeTolerance ||
      Math.abs(nearest.size[1] - s.size[1]) > sizeTolerance
    )
      mismatches.push({
        reason: "size",
        asset: nearest.asset,
        expected,
        nearest,
      });
    else if (!damped && angleDelta(nearest.angle, s.angle) > 1)
      mismatches.push({
        reason: "rotation",
        asset: nearest.asset,
        expected,
        nearest,
      });
    else if (Math.abs(nearest.alpha - item.alpha) > 0.08)
      mismatches.push({
        reason: "alpha",
        asset: nearest.asset,
        expected,
        nearest,
      });
    else if (nearest.colour.some((v, i) => Math.abs(v - item.colour[i]) > 0.02))
      mismatches.push({
        reason: "colour",
        asset: nearest.asset,
        expected,
        nearest,
      });
  }
  // Nothing extra: every visible skin element render-core draws exists in lazer.
  for (const p of placed) {
    if (
      used.has(p.index) ||
      p.motion === 30 ||
      // Plate drops, the kiai glow and the mascot follow results, beats or
      // input (gameplay goldens cover them, not these autoplay layouts).
      p.motion === 35 ||
      !own(p.asset.replace(/-0$/, "")) ||
      !visible(p.centre, p.size)
    )
      continue;
    // The kiai glow follows beats, which the headless harness has no clock for.
    if (p.asset === "taiko-bar-right-glow") continue;
    if (p.alpha < 0.05) continue;
    mismatches.push({ reason: "extra element", asset: p.asset, nearest: p });
  }
  return mismatches;
}
