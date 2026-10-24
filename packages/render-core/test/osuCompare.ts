/**
 * CPU evaluation of osu!'s legacy spinner, follow circle and slider ball
 * instances (src/osu.ts), with the same arithmetic as their WGSL vertex
 * stage, for the layout goldens (test/layoutCompare.ts).
 */
import {
  FOLLOW_CIRCLE,
  SLIDER_BALL,
  SPINNER_PART,
  SpinnerRole,
  spinnerTurn,
} from "../src/osu";

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const clamp = (t: number) => Math.max(0, Math.min(1, t));
const lin = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const srgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

export interface Evaluated {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians. */
  angle: number;
  alpha: number;
  colour: number[];
}

/** The osu! kinds of src/osu.ts, or null for any other instance. */
export function evaluateOsu(
  d: Float32Array,
  now: number,
  preempt: number,
): Evaluated | null {
  const kind = d[12];
  if (
    kind !== 5 &&
    kind !== SPINNER_PART &&
    kind !== FOLLOW_CIRCLE &&
    kind !== SLIDER_BALL
  )
    return null;
  const [x0, y0, w0, h0, start, end, from] = d,
    [a, b, c] = [d[13], d[14], d[15]];
  let x = x0,
    y = y0,
    w = w0,
    h = h0,
    angle = 0,
    alpha = d[11],
    colour = [d[8], d[9], d[10]];
  if (kind === 5 || kind === FOLLOW_CIRCLE || kind === SLIDER_BALL) {
    const f = clamp((now - start) / Math.max(0.01, end - start));
    x = x0 + (a - x0) * f;
    y = y0 + (b - y0) * f;
  }
  if (kind === SLIDER_BALL && Math.hypot(a - x0, b - y0) > 0.01)
    angle = Math.atan2(b - y0, a - x0);
  if (kind === FOLLOW_CIRCLE) {
    const dt = now - d[8],
      phase = Math.round(d[9]),
      parameter = d[10];
    let k = 2;
    if (phase === 0) {
      k = 1 + easeOut(clamp(dt / Math.max(0.001, Math.min(180, parameter))));
      alpha *= clamp(dt / Math.max(0.001, Math.min(60, parameter)));
    } else if (phase === 1) k = 2.2 - 0.2 * clamp(dt / 200);
    else {
      const u = clamp(dt / 200);
      k = parameter + (1.6 - parameter) * easeOut(u);
      alpha *= (1 - u * u) * clamp(1 - dt / 240);
    }
    w *= k;
    h *= k;
    colour = [1, 1, 1];
  }
  if (kind === SPINNER_PART) {
    const fi = 400 * Math.min(1, preempt / 450),
      role = Math.round(a),
      progress = clamp((now - start) / Math.max(0.01, b - start));
    let scale = 1;
    alpha *= clamp((now - (start - fi)) / fi);
    if (now > end) alpha *= clamp(1 - (now - end) / 240);
    if (role === SpinnerRole.turn || role === SpinnerRole.scaled)
      angle = ((spinnerTurn(now, start, end) * Math.PI) / 180) * c;
    if (role === SpinnerRole.approach)
      scale =
        1 +
        (0.0625 / 1.1625 - 1) * clamp((now - start) / Math.max(1, end - start));
    if (role === SpinnerRole.clear) {
      const dt = now - from;
      alpha *= easeOut(clamp(dt / 400));
      if (now > end - 50) alpha *= clamp((end - now) / 50);
      scale =
        dt < 240
          ? 2 - 1.2 * easeOut(clamp(dt / 240))
          : 0.8 + 0.2 * clamp((dt - 240) / 160);
    }
    if (role === SpinnerRole.spinIn)
      alpha *= clamp((now - (start - fi / 2)) / (fi / 2));
    if (role === SpinnerRole.spinOut) alpha *= clamp(1 - (now - c) / 300);
    if (role === SpinnerRole.rpm)
      y += 50 * (1 - easeOut(clamp((now - (start - fi)) / fi)));
    if (role >= SpinnerRole.scaled) scale *= 0.8 + 0.2 * easeOut(progress);
    // FadeColour / FlashColour in linear light.
    let fromRgb = colour,
      toRgb = colour,
      mix = 0;
    if (role === SpinnerRole.glow) {
      alpha *= progress;
      if (now > end) alpha *= clamp(1 - (now - end) / 300);
      fromRgb = [1, 1, 1];
      mix = clamp((now - c) / 200);
    }
    if (role === SpinnerRole.middle) {
      toRgb = [1, 0, 0];
      mix = clamp((now - start) / Math.max(1, end - start));
    }
    colour = fromRgb.map((v, i) =>
      srgb(lin(v) + (lin(toRgb[i]) - lin(v)) * mix),
    );
    w *= scale;
    h *= scale;
  }
  return { x, y, w, h, angle, alpha, colour };
}
