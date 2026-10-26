/**
 * Compares render-core's osu! slider bodies with osu!lazer's, pixel by pixel
 * on the CPU.
 *
 * lazer: test/reference/VosuLayout.cs dumps every visible slider path (its
 * vertices and radius in lazer's game space, its composite alpha and the
 * texels of its SmoothPath texture). osu!framework draws a path in two
 * passes: sh_PathPrepass.fs keeps, per pixel, the largest
 * `1 - distance / radius` over all segments (MAX blending into an R16F
 * buffer), then sh_Path.fs samples the texture there (linear filtering), with
 * alpha where that value is above 0. `lazerPixel` does the same.
 *
 * render-core: the scene's slider body instances (shape 12, one capsule per
 * path segment) evaluated with the arithmetic of shader.ts (`bodyColour`,
 * `bodyTexel`, the capsule distance) and the backends' pass semantics: in
 * `bodies` chunks each pixel is shaded once, by the capsule with the least
 * depth (fs_slider: later sliders, then the segment nearest the pixel);
 * anything else blends in draw order.
 */
import { parseOsu } from "@vosu-tools/osu-parse";
import {
  compileScene,
  sliderBodyRange,
  type RenderOptions,
} from "../src/scene";
import type { AtlasRegion, Skin } from "../src/skin";

export interface SliderPath {
  type: string;
  alpha: number;
  radius: number;
  /** x, y pairs in game space. */
  vertices: number[];
  /** RGBA bytes, edge to centre. */
  texels: number[][];
}

export interface SliderBodyCase {
  name: string;
  /** Map key (fixtures) or .osu text. */
  map: string;
  skin: string;
  time: number;
  /** Game space size (lazer's draw-size-preserving container). */
  size: [number, number];
  /** The playfield's TL, TR, BL, BR in game space. */
  playfield: number[];
  paths: SliderPath[];
}

export interface BodyComparison {
  /** Pixels either side drew. */
  pixels: number;
  /** Mean and largest absolute channel error, 0-255 (premultiplied over black). */
  mean: number;
  max: number;
  /** Share of pixels off by more than 8/255. */
  over8: number;
}

const half = new Float32Array(1),
  halfBits = new Uint32Array(half.buffer);
/** Rounds to the nearest half float (lazer's R16F prepass buffer). */
function toHalf(value: number): number {
  if (value === 0) return 0;
  half[0] = value;
  const exponent = ((halfBits[0] >>> 23) & 0xff) - 127,
    step = 2 ** (Math.max(exponent, -14) - 10);
  return Math.round(value / step) * step;
}

/** lazer's pixel at game-space point (x, y): premultiplied RGB over black, 0-1. */
export function lazerPixel(
  paths: readonly SliderPath[],
  x: number,
  y: number,
  out: number[],
): void {
  out[0] = out[1] = out[2] = 0;
  for (const path of paths) {
    const v = path.vertices;
    let best = 0;
    for (let i = 2; i < v.length; i += 2) {
      const ax = v[i - 2],
        ay = v[i - 1],
        dx = v[i] - ax,
        dy = v[i + 1] - ay,
        length = dx * dx + dy * dy || 1e-12,
        t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
      best = Math.max(
        best,
        1 - Math.hypot(x - ax - t * dx, y - ay - t * dy) / path.radius,
      );
    }
    if (v.length === 2) best = 1 - Math.hypot(x - v[0], y - v[1]) / path.radius;
    best = toHalf(Math.max(0, Math.min(1, best)));
    if (best <= 0) continue;
    const texels = path.texels,
      width = texels.length,
      position = Math.max(0, Math.min(width - 1, best * width - 0.5)),
      i0 = Math.floor(position),
      i1 = Math.min(i0 + 1, width - 1),
      f = position - i0,
      c = [0, 1, 2, 3].map(
        (k) => (texels[i0][k] * (1 - f) + texels[i1][k] * f) / 255,
      ),
      a = c[3] * path.alpha;
    for (let k = 0; k < 3; k++) out[k] = out[k] * (1 - a) + c[k] * a;
  }
}

/** shader.ts `bodyColour`: straight RGBA at `p` from the edge. */
function bodyColour(
  p: number,
  profile: number,
  border: number,
  bodyAlpha: number,
  accent: readonly number[],
  edge: readonly number[],
): number[] {
  const f = Math.max(
    0,
    Math.min(1, (p - border) / Math.max(0.0001, 1 - border)),
  );
  if (profile < 1.5) {
    if (p <= 0.078125) return [0, 0, 0, (0.25 * p) / 0.078125];
    if (p <= border) return [...edge, 1];
    return [
      ...accent.map((c) => {
        const outer = c / 1.1,
          inner = Math.min(1, c * 1.125 + 0.25);
        return outer + (inner - outer) * f;
      }),
      bodyAlpha,
    ];
  }
  if (p <= border) return [...edge, 1];
  if (profile < 2.5) return [...accent, (0.8 - 0.5 * f) * bodyAlpha];
  return [...accent.map((c) => c / 5), bodyAlpha];
}

/** shader.ts `bodyTexel`. */
function bodyTexel(
  i: number,
  width: number,
  ...rest: Parameters<typeof bodyColour> extends [number, ...infer R]
    ? R
    : never
): number[] {
  const p = i / (width - 1),
    c = bodyColour(p, ...rest);
  c[3] *= Math.min(p / 0.02, 1);
  return c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255) / 255);
}

interface Capsule {
  x: number;
  y: number;
  /** Half the straight part, along `ux, uy`. */
  half: number;
  ux: number;
  uy: number;
  radius: number;
  width: number;
  start: number;
  border: number;
  profile: number;
  bodyAlpha: number;
  accent: number[];
  edge: number[];
  alpha: number;
  bodies: boolean;
}

/** render-core's slider body capsules visible at `time`, in draw order. */
export function sliderCapsules(
  mapText: string,
  skin: Skin | undefined,
  time: number,
  options: RenderOptions = {},
): Capsule[] {
  const map = parseOsu(mapText),
    scene = compileScene(
      map,
      { beatmapColours: true, comboColourNormalisation: 0.2, ...options },
      new Map<string, AtlasRegion>(),
      skin,
    ),
    out: Capsule[] = [];
  for (const chunk of scene.chunks)
    for (let i = chunk.first; i < chunk.first + chunk.count; i++) {
      const d = scene.data.subarray(i * 24, i * 24 + 24);
      if (d[20] !== 12) continue;
      // Lifetimes are float32 in the instance data, as the shader compares them.
      if (Math.fround(time) < d[6] || Math.fround(time) > d[7]) continue;
      const profileCode = d[19],
        profile = Math.floor(profileCode / 10 + 0.0001),
        // The part of the segment lazer shows now (shader.ts kind 42).
        { lo, hi, alpha } = sliderBodyRange(
          d[4],
          d[5],
          d[11],
          scene.preempt,
          Math.fround(time),
          options.snakingIn !== false,
          options.snakingOut !== false,
        ),
        [s0, s1] = [d[22], d[23]],
        a = Math.max(s0, lo),
        b = Math.min(s1, hi);
      if (a > b || alpha <= 0) continue;
      const half = (d[2] - d[3]) / 2,
        span = Math.max(s1 - s0, 1e-6),
        from = -half + 2 * half * Math.min(1, Math.max(0, (a - s0) / span)),
        to = -half + 2 * half * Math.min(1, Math.max(0, (b - s0) / span)),
        ux = Math.cos(d[13]),
        uy = Math.sin(d[13]);
      out.push({
        x: d[0] + ((from + to) / 2) * ux,
        y: d[1] + ((from + to) / 2) * uy,
        half: (to - from) / 2,
        ux,
        uy,
        radius: d[3] / 2,
        width: Math.max(2, Math.floor(d[3] * 0.5) * 2),
        start: d[4],
        border: d[21],
        profile,
        bodyAlpha: profileCode - profile * 10,
        accent: [d[8], d[9], d[10]],
        edge: [d[16], d[17], d[18]],
        alpha,
        bodies: chunk.bodies === true,
      });
    }
  return out;
}

/** `1 - distance / radius` from a capsule's segment (shader.ts capsuleR). */
function capsuleT(c: Capsule, x: number, y: number): number {
  const dx = x - c.x,
    dy = y - c.y,
    along = dx * c.ux + dy * c.uy,
    across = -dx * c.uy + dy * c.ux,
    beyond = Math.max(0, Math.abs(along) - c.half);
  return 1 - Math.hypot(beyond, across) / c.radius;
}

/** A capsule's premultiplied RGBA at `t` (shader.ts shape 12). */
function capsulePixel(c: Capsule, t: number): number[] {
  const x = Math.max(0, Math.min(c.width - 1, t * c.width - 0.5)),
    i = Math.floor(x),
    args = [c.profile, c.border, c.bodyAlpha, c.accent, c.edge] as const,
    a = bodyTexel(i, c.width, ...args),
    b = bodyTexel(Math.min(i + 1, c.width - 1), c.width, ...args),
    rgba = a.map((v, k) => v + (b[k] - v) * (x - i)),
    alpha = c.alpha * rgba[3];
  return [rgba[0] * alpha, rgba[1] * alpha, rgba[2] * alpha, alpha];
}

/** render-core's pixel at osu! point (x, y) (stack offsets included). */
export function renderCorePixel(
  capsules: readonly Capsule[],
  x: number,
  y: number,
  out: number[],
): void {
  out[0] = out[1] = out[2] = 0;
  let winner: Capsule | undefined,
    winnerT = 0,
    key = -Infinity;
  const flush = () => {
    if (!winner) return;
    const p = capsulePixel(winner, winnerT);
    for (let k = 0; k < 3; k++) out[k] = out[k] * (1 - p[3]) + p[k];
    winner = undefined;
    key = -Infinity;
  };
  for (const c of capsules) {
    const t = capsuleT(c, x, y);
    if (!c.bodies) {
      flush();
      if (t > 0) {
        const p = capsulePixel(c, t);
        for (let k = 0; k < 3; k++) out[k] = out[k] * (1 - p[3]) + p[k];
      }
      continue;
    }
    if (t <= 0 || capsulePixel(c, t)[3] < 0.002) continue;
    // fs_slider's depth: later sliders above, then the nearest segment.
    const k = c.start + 0.5 * Math.min(1, t);
    if (k > key) {
      key = k;
      winner = c;
      winnerT = t;
    }
  }
  flush();
}

/**
 * Both sides over the case's bodies on a pixel grid `scale` pixels per
 * game-space unit (1.40625 for 1920×1080), every `step` pixels.
 */
export function compareBodies(
  c: SliderBodyCase,
  mapText: string,
  skin: Skin | undefined,
  scale = 1080 / 768,
  step = 2,
): BodyComparison {
  const capsules = sliderCapsules(mapText, skin, c.time),
    [x0, y0] = c.playfield,
    unit = (c.playfield[2] - x0) / 512,
    vertices = c.paths.flatMap((p) => p.vertices),
    reach = Math.max(...c.paths.map((p) => p.radius)) + 2;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (let i = 0; i < vertices.length; i += 2) {
    left = Math.min(left, vertices[i] - reach);
    right = Math.max(right, vertices[i] + reach);
    top = Math.min(top, vertices[i + 1] - reach);
    bottom = Math.max(bottom, vertices[i + 1] + reach);
  }
  const lazer = [0, 0, 0],
    ours = [0, 0, 0];
  let pixels = 0,
    sum = 0,
    max = 0,
    over8 = 0;
  for (let py = Math.floor(top * scale); py < bottom * scale; py += step)
    for (let px = Math.floor(left * scale); px < right * scale; px += step) {
      const gx = (px + 0.5) / scale,
        gy = (py + 0.5) / scale;
      lazerPixel(c.paths, gx, gy, lazer);
      renderCorePixel(capsules, (gx - x0) / unit, (gy - y0) / unit, ours);
      if (Math.max(...lazer, ...ours) <= 0) continue;
      pixels++;
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(lazer[k] - ours[k]) * 255;
        sum += e / 3;
        max = Math.max(max, e);
      }
      if (lazer.some((v, k) => Math.abs(v - ours[k]) * 255 > 8)) over8++;
    }
  return { pixels, mean: sum / pixels, max, over8: over8 / pixels };
}
