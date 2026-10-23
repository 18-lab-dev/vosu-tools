/**
 * osu!lazer's "combo colour normalisation" (gameplay setting, default 0.2):
 * `DrawableHitObject.UpdateComboColour` blends each combo colour towards the
 * same hue and saturation at perceived brightness 0.6 (`HSPAColour`, after
 * https://alienryderflex.com/hsp.html), interpolating in linear light like
 * osu!framework's `Interpolation.ValueAt(Color4)`. Ported from ppy/osu at
 * 2026.1005.0-lazer (MIT); single precision as in C#.
 */
const f = Math.fround;
const PR = f(0.299),
  PG = f(0.587),
  PB = f(0.114);

type RGB = readonly [number, number, number];

function toHspa([r, g, b]: RGB): { h: number; s: number; p: number } {
  const p = f(
    Math.sqrt(f(f(f(f(r * r) * PR) + f(f(g * g) * PG)) + f(f(b * b) * PB))),
  );
  if (r === g && r === b) return { h: 0, s: 0, p };
  const sixth = f(1 / 6);
  if (r >= g && r >= b) {
    if (b >= g)
      return {
        h: f(1 - f(f(sixth * f(b - g)) / f(r - g))),
        s: f(1 - f(g / r)),
        p,
      };
    return { h: f(f(sixth * f(g - b)) / f(r - b)), s: f(1 - f(b / r)), p };
  }
  if (g >= r && g >= b) {
    if (r >= b)
      return {
        h: f(f(2 / 6) - f(f(sixth * f(r - b)) / f(g - b))),
        s: f(1 - f(b / g)),
        p,
      };
    return {
      h: f(f(2 / 6) + f(f(sixth * f(b - r)) / f(g - r))),
      s: f(1 - f(r / g)),
      p,
    };
  }
  if (g >= r)
    return {
      h: f(f(4 / 6) - f(f(sixth * f(g - r)) / f(b - r))),
      s: f(1 - f(r / b)),
      p,
    };
  return {
    h: f(f(4 / 6) + f(f(sixth * f(r - g)) / f(b - g))),
    s: f(1 - f(g / b)),
    p,
  };
}

/** `HSPAColour.ToColor4`: one of six hue sectors, with or without a zero channel. */
function fromHspa(H: number, S: number, P: number): [number, number, number] {
  const minOverMax = f(1 - S);
  // [weight of the largest, of the varying, of the smallest channel] and
  // where each lands (r, g, b indices), per sector.
  const sectors: [number, number, number, number, number, number, boolean][] = [
    [PR, PG, PB, 0, 1, 2, false],
    [PG, PR, PB, 1, 0, 2, true],
    [PG, PB, PR, 1, 2, 0, false],
    [PB, PG, PR, 2, 1, 0, true],
    [PB, PR, PG, 2, 0, 1, false],
    [PR, PB, PG, 0, 2, 1, true],
  ];
  const index =
      H < f(1 / 6)
        ? 0
        : H < f(2 / 6)
          ? 1
          : H < f(3 / 6)
            ? 2
            : H < f(4 / 6)
              ? 3
              : H < f(5 / 6)
                ? 4
                : 5,
    [pMax, pMid, pMin, iMax, iMid, iMin, descending] = sectors[index];
  const h = descending
    ? f(6 * f(f(-H) + f((index + 1) / 6)))
    : f(6 * f(H - f(index / 6)));
  const out: [number, number, number] = [0, 0, 0];
  if (minOverMax > 0) {
    const part = f(1 + f(h * f(f(1 / minOverMax) - 1)));
    const min = f(
      P /
        f(
          Math.sqrt(
            f(
              f(
                f(f(pMax / minOverMax) / minOverMax) + f(f(pMid * part) * part),
              ) + pMin,
            ),
          ),
        ),
    );
    out[iMin] = min;
    out[iMax] = f(min / minOverMax);
    out[iMid] = f(min + f(h * f(out[iMax] - min)));
  } else {
    out[iMax] = f(Math.sqrt(f(f(P * P) / f(pMax + f(f(pMid * h) * h)))));
    out[iMid] = f(out[iMax] * h);
    out[iMin] = 0;
  }
  return out;
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** A combo colour as lazer draws it with normalisation `amount` (0 leaves it unchanged). */
export function normaliseComboColour(
  colour: readonly number[],
  amount: number,
): number[] {
  const t = Math.min(1, Math.abs(amount));
  if (!t) return [...colour];
  const rgb: RGB = [f(colour[0]), f(colour[1]), f(colour[2])],
    { h, s } = toHspa(rgb),
    target = fromHspa(h, s, f(0.6));
  if (target.every((c, i) => c === rgb[i])) return [...colour];
  const out = rgb.map((c, i) => {
    const a = toLinear(c),
      b = toLinear(target[i]);
    return toSrgb(a + (b - a) * t);
  });
  return colour.length > 3 ? [...out, colour[3]] : out;
}
