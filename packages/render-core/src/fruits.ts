/**
 * osu!catch with legacy skins, laid out as osu!lazer lays it out. Ported from
 * ppy/osu at 2026.1005.0-lazer (MIT): `CatchPlayfieldAdjustmentContainer`,
 * `CatchPlayfield`, `Catcher` (scale, plate, hyper-dash tint),
 * `DrawablePalpableCatchHitObject` and its fruit/droplet/banana subclasses,
 * osu.Game.Rulesets.Catch/Skinning/Legacy (`LegacyCatchHitObjectPiece`,
 * `LegacyFruitPiece`, `LegacyDropletPiece`, `LegacyBananaPiece`,
 * `LegacyCatcherNew`/`Old`) and osu.Game/Utils/StatelessRNG.
 *
 * The playfield's own units map to render-core's world by a fixed offset:
 * lazer scales the 512-wide playfield by 1.6 and centres it, so world x is
 * playfield x and world y is playfield y - 76. Objects land at the
 * catcher's top, playfield y 440.
 */
import type { Beatmap } from "@vosu-tools/osu-parse";
import { catchObjects, type CatchObject } from "@vosu-tools/ruleset-convert";
import { normaliseComboColour } from "./colour";
import type { AtlasRegion, Skin } from "./skin";
import { capped, type Emit } from "./taiko";
import {
  catcherStates,
  catchJudgements,
  type JudgementEvent,
  type Marks,
} from "./judgements";

/** Playfield y of the catcher's top (where objects are caught), in world units. */
export const CATCHER_Y = 440 - 76;
const PLAYFIELD_HEIGHT = 440,
  OBJECT_RADIUS = 64,
  MAX_PIECE_SIZE = 160,
  FRUITS = ["pear", "grapes", "apple", "orange"] as const;

/** osu.Game.Utils.StatelessRNG. */
export function statelessSingle(seed: number, series = 0): number {
  return Number(nextULong(seed, series) & 0xffffffn) / (1 << 24);
}
export function statelessInt(
  maxValue: number,
  seed: number,
  series = 0,
): number {
  return Number(nextULong(seed, series) % BigInt(maxValue));
}
function nextULong(seed: number, series: number): bigint {
  const mask = (1n << 64n) - 1n;
  let x =
    (((BigInt(series >>> 0) << 32n) | BigInt(seed >>> 0)) ^ 0x12345678n) & mask;
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & mask;
  x ^= x >> 33n;
  x = (x * 0xc4ceb9fe1a85ec53n) & mask;
  x ^= x >> 33n;
  return x;
}

/** CatchAutoGenerator's replay frames (time, catcher x), in order. */
export function autoplayFrames(
  objects: readonly CatchObject[],
  cs: number,
): { time: number; x: number }[] {
  const frames: { time: number; x: number }[] = [],
    half = Math.fround(106.75 * Math.abs(objectScale(cs) * 2) * 0.8) * 0.5;
  let lastPosition = 256,
    lastTime = 0;
  for (const h of objects) {
    const change = Math.abs(lastPosition - h.x),
      available = h.time - lastTime;
    if (available < 0) continue;
    const speed = change === 0 ? 0 : change / available;
    if (lastPosition - half < h.x && lastPosition + half > h.x) {
      lastTime = h.time;
      frames.push({ time: h.time, x: lastPosition });
      continue;
    }
    if (speed > 1) frames.push({ time: h.time, x: h.x });
    else if (h.hyper)
      frames.push(
        { time: h.time - available, x: lastPosition },
        { time: h.time, x: h.x },
      );
    else if (speed > 0.5) {
      const atDash = (change / 0.5 - available) / 2,
        mid =
          lastPosition + (h.x - lastPosition) * Math.fround(atDash / available);
      frames.push(
        { time: h.time - available + 1, x: lastPosition },
        { time: h.time - available + atDash, x: mid },
        { time: h.time, x: h.x },
      );
    } else
      frames.push(
        { time: h.time - change / 0.5, x: lastPosition },
        { time: h.time, x: h.x },
      );
    lastTime = h.time;
    lastPosition = h.x;
  }
  return frames;
}

/** `LegacyRulesetExtensions.CalculateScaleFromCircleSize`. */
export const objectScale = (cs: number) =>
  Math.fround(
    Math.fround(1 - Math.fround(0.7) * ((Math.fround(cs) - 5) / 5)) / 2,
  );

/** `IBeatmapDifficultyInfo.DifficultyRangeInt(AR, 1800, 1200, 450)`. */
export const catchPreempt = (ar: number) =>
  Math.trunc(
    ar > 5
      ? 1200 + ((450 - 1200) * (ar - 5)) / 5
      : ar < 5
        ? 1200 - ((1200 - 1800) * (5 - ar)) / 5
        : 1200,
  );

export interface CatchScene {
  /** Where the (auto)catcher is at each catch, for the shader's catcher x. */
  catcher: { time: number; x: number }[];
  /** Hyper-dashes: from the catch that starts one to its target's time. */
  hyper: { start: number; end: number }[];
  /** With a replay's results: the catcher's state from each result on. */
  states?: { time: number; state: number }[];
}

interface Layer {
  asset: string;
  tint: readonly number[];
  size: number;
  additive?: boolean;
  /** Untextured hyper marker. */
  ring?: boolean;
  crop?: [number, number];
  w: number;
  h: number;
}
/** Untextured shape code for a layer (textured layers pick 10/13 from the asset). */
const shapeOf = (layer: Layer) => (layer.ring ? 1 : layer.additive ? 13 : 0);
const size = (uv: AtlasRegion | undefined): [number, number] => [
  uv?.width ?? 0,
  uv?.height ?? 0,
];

const hex = (value: string | undefined) => {
  const parts = value?.split(",").map((c) => Number(c.trim()) / 255);
  return parts && parts.length >= 3 && parts.every(Number.isFinite)
    ? parts.slice(0, 3)
    : undefined;
};

export function compileCatch(
  map: Beatmap,
  options: {
    comboColourNormalisation?: number;
    hitLighting?: boolean;
    judgements?: readonly JudgementEvent[];
  },
  regions: Map<string, AtlasRegion>,
  skin: Skin | undefined,
  add: Emit,
  /** Combo colours in use (beatmap or skin, as the client picks them). */
  colours: readonly (readonly number[])[],
  marks?: Marks,
): CatchScene {
  const generated = catchObjects(map),
    objects = [...generated].sort((a, b) => a.time - b.time),
    preempt = catchPreempt(map.difficulty.ar),
    scale = objectScale(map.difficulty.cs),
    catcherScale = scale * 2,
    speed = PLAYFIELD_HEIGHT / preempt,
    amount = options.comboColourNormalisation ?? 0;
  const config = {
    ...(skin?.sections.get("Colours")?.[0] ?? {}),
    ...(skin?.sections.get("CatchTheBeat")?.[0] ?? {}),
  };
  const hyperDash = hex(config.HyperDash) ?? [1, 0, 0],
    hyperFruit = hex(config.HyperDashFruit) ?? hyperDash;
  const accent = (o: CatchObject): readonly number[] => {
    let colour: readonly number[];
    if (o.kind === "banana")
      colour = [
        [255, 240, 0],
        [255, 192, 0],
        [214, 221, 28],
      ][statelessInt(3, Math.trunc(o.time))].map((c) => c / 255);
    else
      colour = colours.length
        ? colours[(o.index + 1) % colours.length]
        : [1, 1, 1];
    return normaliseComboColour(colour, amount);
  };

  // CatchAutoGenerator: replay frames in the beatmap's object order; the
  // catcher's x interpolates linearly between them.
  const catcher = autoplayFrames(generated, map.difficulty.cs).sort(
    (a, b) => a.time - b.time,
  );
  const catcherAt = (time: number) => {
    let lo = 0,
      hi = catcher.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (catcher[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    const p = catcher[Math.max(0, lo - 1)] ?? { time, x: 256 },
      q = catcher[Math.min(catcher.length - 1, lo)] ?? p,
      f =
        q.time === p.time
          ? 1
          : Math.max(0, Math.min(1, (time - p.time) / (q.time - p.time)));
    return p.x + (q.x - p.x) * f;
  };

  /** One object's look: layers, size at its catch time and rotation. */
  const look = (o: CatchObject) => {
    const r1 = statelessSingle(Math.trunc(o.time), 1);
    let name: string,
      factor = 1,
      angle = 0,
      rate = 0,
      grow = 0;
    if (o.kind === "fruit") {
      name = `fruit-${FRUITS[o.index % 4]}`;
      angle = (r1 - 0.5) * 40;
    } else if (o.kind === "banana") {
      name = "fruit-bananas";
      const start = 0.6 + 1.6 * statelessSingle(Math.trunc(o.time), 3),
        a1 = 180 * (r1 * 2 - 1),
        a2 = 180 * (statelessSingle(Math.trunc(o.time), 2) * 2 - 1);
      factor = 0.6;
      angle = a2;
      rate = (a2 - a1) / preempt;
      grow = -(start / 0.6 - 1) / preempt;
    } else {
      name = "fruit-drop";
      factor = 0.8 * (o.kind === "tiny" ? 0.5 : 1);
      const start = r1 * 20;
      rate = 720 / (preempt + 2000);
      angle = start + rate * preempt;
    }
    const layers: {
      asset: string;
      tint: readonly number[];
      size: number;
      additive?: boolean;
    }[] = [];
    if (!regions.has(name)) {
      // No skin image: a plain disc the size of the object's area.
      const d =
          2 * OBJECT_RADIUS * scale * factor * (o.kind === "fruit" ? 0.8 : 0.5),
        disc: Layer[] = [{ asset: "", tint: accent(o), size: 1, w: d, h: d }];
      if (o.hyper)
        disc.unshift({
          asset: "",
          tint: hyperFruit,
          size: 1.2,
          w: d * 1.3,
          h: d * 1.3,
          ring: true,
        });
      return { layers: disc, angle, rate, grow };
    }
    if (o.hyper)
      layers.push({
        asset: name,
        tint: [...hyperFruit, 0.7],
        size: 1.2,
        additive: true,
      });
    layers.push({ asset: name, tint: accent(o), size: 1 });
    if (regions.has(`${name}-overlay`))
      layers.push({ asset: `${name}-overlay`, tint: [1, 1, 1], size: 1 });
    return {
      layers: layers.map((layer): Layer => {
        // Pieces are cropped to 160 units around their centre (WithMaximumSize).
        const { w, h, crop } = capped(regions.get(layer.asset), MAX_PIECE_SIZE),
          k = scale * factor * layer.size;
        return { ...layer, w: w * k, h: h * k, crop };
      }),
      angle,
      rate,
      grow,
    };
  };
  const deg = Math.PI / 180;
  const looks = objects.map(look);

  // The plate: caught fruits and droplets (bananas explode at once) ride on
  // the catcher at half size until the combo ends, behind everything else.
  // With a replay's results only what it caught goes on the plate (objects
  // are told apart by their top-level object and time).
  const judgements = options.judgements;
  const caught = judgements
    ? new Set(
        judgements
          .filter((e) => !/miss/.test(e.result) && e.object !== undefined)
          .map((e) => `${e.note}@${e.time}`),
      )
    : undefined;
  let clearAt = Infinity;
  const clears = objects.map((o) => o.lastInCombo);
  for (let i = objects.length - 1; i >= 0; i--) {
    if (clears[i]) clearAt = objects[i].time;
    const o = objects[i];
    if (o.kind === "banana" || clears[i] || clearAt <= o.time) continue;
    if (caught && !caught.has(`${o.index}@${o.time}`)) continue;
    const dx = o.x - catcherAt(o.time);
    for (const layer of looks[i].layers)
      add(
        0,
        CATCHER_Y - 5 * catcherScale,
        layer.w * 0.5,
        layer.h * 0.5,
        o.time,
        clearAt,
        o.time,
        clearAt,
        layer.tint,
        shapeOf(layer),
        30,
        dx,
        looks[i].angle * deg,
        0,
        layer.asset,
        0,
        0,
        0,
        undefined,
        true,
        layer.crop,
      );
  }

  // Falling objects, landing on the catcher's top at their time.
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i],
      { layers, angle, rate, grow } = looks[i];
    for (const layer of layers)
      add(
        o.x,
        CATCHER_Y,
        layer.w,
        layer.h,
        o.time,
        o.time,
        o.time - preempt,
        o.time - 0.5,
        layer.tint,
        shapeOf(layer),
        24,
        angle * deg,
        rate * deg,
        grow,
        layer.asset,
        0,
        0,
        0,
        undefined,
        true,
        layer.crop,
      );
  }

  // The catcher: LegacyCatcherNew (idle/kiai/fail) or the old single
  // sprite at 0.35 × catcher scale, its top 16 image units above the catch line.
  const states = ["idle", "kiai", "fail"] as const,
    old =
      regions.has("fruit-ryuuta") &&
      !regions.has("fruit-catcher-idle") &&
      Number(skin?.sections.get("General")?.[0]?.Version ?? 1) < 2.3;
  for (let state = 0; state < 3; state++) {
    const asset = old
      ? "fruit-ryuuta"
      : regions.has(`fruit-catcher-${states[state]}`)
        ? `fruit-catcher-${states[state]}`
        : "fruit-catcher-idle";
    if (!regions.has(asset)) {
      // No skin image: the catcher's plate as a bar as wide as its catch range.
      const w = 106.75 * catcherScale * 0.8,
        h = 12 * catcherScale;
      add(
        256,
        CATCHER_Y + h / 2,
        w,
        h,
        0,
        0,
        -1e9,
        1e9,
        hyperDash,
        4,
        15 + state,
      );
      continue;
    }
    const k = 0.35 * catcherScale,
      [iw, ih] = size(regions.get(asset)),
      w = iw * k,
      h = ih * k;
    add(
      256,
      CATCHER_Y - 16 * k + h / 2,
      w,
      h,
      0,
      0,
      -1e9,
      1e9,
      hyperDash,
      4,
      15 + state,
      0,
      0,
      0,
      asset,
    );
  }

  // Catcher.OnNewResult: catching a hyper fruit hyper-dashes when the target
  // needs more than dash speed from where the catcher is; any later catch
  // other than a tiny droplet ends it.
  const hyper: CatchScene["hyper"] = [],
    catches = objects.filter((o) => o.kind !== "tiny");
  for (let i = 0; i < catches.length - 1; i++) {
    const o = catches[i];
    if (!o.hyper) continue;
    const target = objects.find(
      (t) => t.time > o.time && (t.kind === "fruit" || t.kind === "droplet"),
    );
    if (!target) continue;
    const velocity =
      Math.abs(target.x - catcherAt(o.time)) /
      Math.max(1, target.time - o.time - 1000 / 60);
    if (velocity <= 1) continue;
    // A hyper-dash caught while already hyper-dashing just continues.
    const previous = hyper[hyper.length - 1];
    if (previous && previous.end >= o.time) previous.end = catches[i + 1].time;
    else hyper.push({ start: o.time, end: catches[i + 1].time });
  }
  if (!judgements || !marks) return { catcher, hyper };
  // Lighting and the combo counter on the catcher, from the replay's results.
  const colourOf = (note: number) =>
    normaliseComboColour(
      colours.length ? colours[(note + 1) % colours.length] : [1, 1, 1],
      amount,
    );
  catchJudgements({
    events: judgements,
    marks,
    skin,
    catcherY: CATCHER_Y,
    catcherScale,
    colour: colourOf,
    hitLighting: options.hitLighting !== false,
  });
  const kiai = (time: number) => {
    let effects = 0;
    for (const point of map.timing) {
      if (point.time > time) break;
      effects = point.effects;
    }
    return (effects & 1) !== 0;
  };
  return { catcher, hyper, states: catcherStates(judgements, kiai) };
}
