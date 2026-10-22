/**
 * Original, procedurally drawn reimplementations of the osu! clients' built-in
 * skins, so previews without skin files still look like the client:
 *
 * - "legacy": stable's default skin and lazer's "osu! (classic)" skin.
 * - "triangles": lazer's Triangles skin.
 * - "argon" / "argon-pro": lazer's Argon skins.
 *
 * Geometry and colours follow the MIT-licensed ppy/osu sources at tag
 * 2026.1005.0-lazer (commit 9a10d935b05a3b896f4bd811d620f2023331db93); see
 * PROVENANCE.md. No textures from osu-resources are used: every element is
 * drawn here with Canvas 2D and handed to the regular skin pipeline, so the
 * renderer treats a built-in skin exactly like a skin loaded from files.
 *
 * Mania values from lazer are in lazer stage units; legacy skin.ini units are
 * those divided by 1.6 (lazer's legacy POSITION_SCALE_FACTOR).
 */
import type { Skin, SkinStyle } from "./skin";

export type BuiltinSkinName = "legacy" | "triangles" | "argon" | "argon-pro";
export const builtinSkinNames: readonly BuiltinSkinName[] = [
  "legacy",
  "triangles",
  "argon",
  "argon-pro",
];

type RGB = readonly [number, number, number];
type Context = OffscreenCanvasRenderingContext2D;

/** Pixel density of generated elements; logical sizes are SD (legacy) units. */
const DENSITY = 2;
/** lazer stage units per legacy mania unit. */
const LAZER_TO_LEGACY = 1 / 1.6;

const rgb = (r: number, g: number, b: number): RGB => [
  r / 255,
  g / 255,
  b / 255,
];
const css = (c: RGB, alpha = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha})`;
/** osu!framework Color4 Darken/Lighten: divide/multiply by max(1, 1 + amount). */
const darken = (c: RGB, amount: number): RGB => {
  const s = Math.max(1, 1 + amount);
  return [c[0] / s, c[1] / s, c[2] / s];
};
const lighten = (c: RGB, amount: number): RGB => {
  const s = Math.max(1, 1 + amount);
  return [Math.min(1, c[0] * s), Math.min(1, c[1] * s), Math.min(1, c[2] * s)];
};
const ini = (c: RGB, alpha = 1) =>
  [...c.map((v) => Math.round(v * 255)), Math.round(alpha * 255)].join(",");
const WHITE: RGB = [1, 1, 1];

/** Draws one element at DENSITY× its logical size. */
function draw(w: number, h: number, paint: (g: Context) => void): ImageBitmap {
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(w * DENSITY)),
    Math.max(1, Math.ceil(h * DENSITY)),
  );
  // Software-backed 2D: GPU-accelerated canvases created while a WebGPU
  // device starts up can lose their context and yield blank bitmaps.
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.scale(DENSITY, DENSITY);
  paint(g);
  return canvas.transferToImageBitmap();
}
function disc(
  g: Context,
  x: number,
  y: number,
  r: number,
  fill: string | CanvasGradient,
) {
  g.beginPath();
  g.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
}
function ring(
  g: Context,
  x: number,
  y: number,
  r: number,
  thickness: number,
  stroke: string,
) {
  g.beginPath();
  g.arc(x, y, Math.max(0, r - thickness / 2), 0, Math.PI * 2);
  g.lineWidth = thickness;
  g.strokeStyle = stroke;
  g.stroke();
}
function roundRect(
  g: Context,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | CanvasGradient,
) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  g.fillStyle = fill;
  g.fill();
}
function vertical(
  g: Context,
  y0: number,
  y1: number,
  stops: [number, string][],
) {
  const gradient = g.createLinearGradient(0, y0, 0, y1);
  for (const [at, colour] of stops) gradient.addColorStop(at, colour);
  return gradient;
}
/** Deterministic pseudo-random triangles (lazer's Triangles background), in a unit box. */
function triangles(
  g: Context,
  w: number,
  h: number,
  seed: number,
  light: string,
  dark: string,
) {
  let s = seed;
  const random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 26; i++) {
    const size = (0.18 + random() * 0.32) * w,
      x = random() * w,
      y = random() * h * 1.2;
    g.beginPath();
    g.moveTo(x, y - size * 0.866 * 0.66);
    g.lineTo(x - size / 2, y + size * 0.866 * 0.33);
    g.lineTo(x + size / 2, y + size * 0.866 * 0.33);
    g.closePath();
    g.fillStyle = random() < 0.5 ? light : dark;
    g.fill();
  }
}
const DIGIT_FONT =
  '700 {size}px "Helvetica Neue", Arial, system-ui, sans-serif';

interface Builder {
  skin: Skin;
  set(name: string, bitmap: ImageBitmap): void;
}
function builder(
  name: string,
  style: SkinStyle,
  general: Record<string, string>,
): Builder {
  const skin: Skin = {
    name,
    assets: new Map(),
    sections: new Map([
      ["General", [{ Name: name, Version: "2.7", ...general }]],
    ]),
    pixelScale: new Map(),
    animations: new Map(),
    frameRate: -1,
    version: 2.7,
    style,
  };
  return {
    skin,
    set(asset, bitmap) {
      skin.assets.set(asset, bitmap);
      skin.pixelScale!.set(asset, DENSITY);
    },
  };
}
function comboColours(
  b: Builder,
  colours: readonly RGB[],
  extra: Record<string, string> = {},
) {
  const section: Record<string, string> = { ...extra };
  colours.forEach(
    (c, i) =>
      (section[`Combo${i + 1}`] = ini(c).split(",").slice(0, 3).join(",")),
  );
  b.skin.sections.set("Colours", [section]);
}
function digitImages(
  b: Builder,
  paint: (g: Context, digit: string, w: number, h: number) => void,
  height: number,
  size: number,
) {
  const probe = new OffscreenCanvas(8, 8).getContext("2d")!;
  probe.font = DIGIT_FONT.replace("{size}", String(size));
  for (let d = 0; d < 10; d++) {
    const w = Math.ceil(probe.measureText(String(d)).width + size * 0.18);
    b.set(
      `default-${d}`,
      draw(w, height, (g) => {
        g.font = DIGIT_FONT.replace("{size}", String(size));
        g.textAlign = "center";
        g.textBaseline = "middle";
        paint(g, String(d), w, height);
      }),
    );
  }
}

/* ----------------------------------------------------------------- osu! */

function osuLegacy(b: Builder) {
  comboColours(
    b,
    [rgb(255, 192, 0), rgb(0, 202, 0), rgb(18, 124, 255), rgb(242, 24, 57)],
    {
      SliderBorder: "255,255,255",
      SliderBall: "2,170,255",
    },
  );
  // hitcircle: a softly shaded disc, tinted by the combo colour.
  b.set(
    "hitcircle",
    draw(128, 128, (g) => {
      const shade = g.createRadialGradient(64, 50, 6, 64, 64, 59);
      shade.addColorStop(0, "#ffffff");
      shade.addColorStop(0.7, "#d9d9d9");
      shade.addColorStop(1, "#b3b3b3");
      disc(g, 64, 64, 59, shade);
    }),
  );
  // hitcircleoverlay: white rim with a thin dark outline, untinted.
  b.set(
    "hitcircleoverlay",
    draw(128, 128, (g) => {
      ring(g, 64, 64, 61, 3, "rgba(0,0,0,0.55)");
      ring(g, 64, 64, 59, 8, "#ffffff");
      ring(g, 64, 64, 51.5, 1.5, "rgba(0,0,0,0.25)");
    }),
  );
  b.set(
    "approachcircle",
    draw(128, 128, (g) => ring(g, 64, 64, 63, 4.5, "#ffffff")),
  );
  digitImages(
    b,
    (g, d, w, h) => {
      g.lineWidth = 4;
      g.lineJoin = "round";
      g.strokeStyle = "rgba(30,30,30,0.9)";
      g.strokeText(d, w / 2, h / 2 + 1);
      g.fillStyle = "#ffffff";
      g.fillText(d, w / 2, h / 2 + 1);
    },
    52,
    44,
  );
  const ball = rgb(2, 170, 255);
  b.set(
    "sliderb",
    draw(128, 128, (g) => {
      const fill = g.createRadialGradient(56, 48, 4, 64, 64, 58);
      fill.addColorStop(0, css(lighten(ball, 0.8)));
      fill.addColorStop(1, css(darken(ball, 0.4)));
      disc(g, 64, 64, 56, fill);
      ring(g, 64, 64, 59, 6, "#ffffff");
    }),
  );
  b.set(
    "sliderfollowcircle",
    draw(294, 294, (g) => {
      ring(g, 147, 147, 128, 8, "rgba(255,204,34,0.95)");
      ring(g, 147, 147, 121, 3, "rgba(255,170,0,0.45)");
    }),
  );
  b.set(
    "reversearrow",
    draw(128, 128, (g) => {
      g.beginPath();
      g.moveTo(98, 64);
      g.lineTo(40, 26);
      g.lineTo(40, 46);
      g.lineTo(18, 46);
      g.lineTo(18, 82);
      g.lineTo(40, 82);
      g.lineTo(40, 102);
      g.closePath();
      g.fillStyle = "#ffffff";
      g.fill();
    }),
  );
  b.set(
    "sliderscorepoint",
    draw(16, 16, (g) => disc(g, 8, 8, 6, "#ffe9a8")),
  );
  spinnerImages(b, "#ffffff", "rgba(255,255,255,0.35)");
}

function osuTriangles(b: Builder) {
  comboColours(
    b,
    [rgb(255, 192, 0), rgb(0, 202, 0), rgb(18, 124, 255), rgb(242, 24, 57)],
    {
      SliderBorder: "255,255,255",
    },
  );
  // CirclePiece: a disc with additive triangles at 50 % opacity, tinted.
  b.set(
    "hitcircle",
    draw(128, 128, (g) => {
      g.save();
      g.beginPath();
      g.arc(64, 64, 64, 0, Math.PI * 2);
      g.clip();
      disc(g, 64, 64, 64, "#cfcfcf");
      triangles(
        g,
        128,
        128,
        7,
        "rgba(255,255,255,0.5)",
        "rgba(255,255,255,0.28)",
      );
      g.restore();
    }),
  );
  // RingPiece: a 9 px white ring, untinted.
  b.set(
    "hitcircleoverlay",
    draw(128, 128, (g) => ring(g, 64, 64, 64, 9, "#ffffff")),
  );
  b.set(
    "approachcircle",
    draw(128, 128, (g) => ring(g, 64, 64, 63, 4, "#ffffff")),
  );
  // NumberPiece: white numbers with a soft shadow.
  digitImages(
    b,
    (g, d, w, h) => {
      g.shadowColor = "rgba(0,0,0,0.5)";
      g.shadowBlur = 6;
      g.fillStyle = "#ffffff";
      g.fillText(d, w / 2, h / 2 + 1);
    },
    48,
    40,
  );
  b.set(
    "sliderb",
    draw(128, 128, (g) => {
      ring(g, 64, 64, 64, 9, "#ffffff");
      disc(g, 64, 64, 48, "rgba(255,255,255,0.25)");
    }),
  );
  b.set(
    "sliderfollowcircle",
    draw(294, 294, (g) => ring(g, 147, 147, 147, 5, "rgba(255,255,255,0.8)")),
  );
  b.set(
    "reversearrow",
    draw(128, 128, (g) => chevron(g, 64, 64, 34, 9, "#ffffff")),
  );
  b.set(
    "sliderscorepoint",
    draw(16, 16, (g) => {
      ring(g, 8, 8, 7, 2.5, "#ffffff");
    }),
  );
  spinnerImages(b, "#ffffff", "rgba(255,255,255,0.25)");
}

function osuArgon(b: Builder, pro: boolean) {
  comboColours(b, [
    rgb(241, 116, 0),
    rgb(0, 241, 53),
    rgb(0, 82, 241),
    rgb(241, 0, 0),
    rgb(232, 235, 0),
    rgb(92, 0, 241),
  ]);
  // ArgonMainCirclePiece at OBJECT_RADIUS 64; luminance layers multiply the
  // combo colour exactly like the client's Darken() factors.
  const border = 128 * (2 / 58),
    gradient = border * 2.5,
    outer = 128 - border * 4,
    inner = outer - gradient * 2,
    fill = inner - gradient * 2;
  const grey = (v: number) => css([v, v, v]);
  b.set(
    "hitcircle",
    draw(128, 128, (g) => {
      disc(g, 64, 64, 63.5, grey(1 / 5));
      disc(
        g,
        64,
        64,
        outer / 2,
        vertical(g, 64 - outer / 2, 64 + outer / 2, [
          [0, grey(1)],
          [1, grey(1 / 1.1)],
        ]),
      );
      disc(
        g,
        64,
        64,
        inner / 2,
        vertical(g, 64 - inner / 2, 64 + inner / 2, [
          [0, grey(1 / 1.5)],
          [1, grey(1 / 1.6)],
        ]),
      );
      disc(g, 64, 64, fill / 2, grey(1 / 5));
    }),
  );
  b.set(
    "hitcircleoverlay",
    draw(128, 128, (g) => ring(g, 64, 64, 64, border, "#ffffff")),
  );
  b.set(
    "approachcircle",
    draw(128, 128, (g) => ring(g, 64, 64, 63, 4, "#ffffff")),
  );
  digitImages(
    b,
    (g, d, w, h) => {
      g.fillStyle = "#ffffff";
      g.fillText(d, w / 2, h / 2 - 2);
    },
    52,
    46,
  );
  // ArgonSliderBall: a white ring with a dark centre and a direction notch.
  b.set(
    "sliderb",
    draw(128, 128, (g) => {
      disc(g, 64, 64, outer / 2, "rgba(0,0,0,0.35)");
      ring(g, 64, 64, outer / 2, border * 1.6, "#ffffff");
    }),
  );
  // ArgonFollowCircle: a soft white ring.
  b.set(
    "sliderfollowcircle",
    draw(294, 294, (g) => {
      ring(g, 147, 147, 147, 4, "rgba(255,255,255,0.9)");
      disc(g, 147, 147, 140, "rgba(255,255,255,0.06)");
    }),
  );
  b.set(
    "reversearrow",
    draw(128, 128, (g) => {
      chevron(g, 58, 64, 26, 8, "#ffffff");
      chevron(g, 78, 64, 26, 8, "#ffffff");
    }),
  );
  b.set(
    "sliderscorepoint",
    draw(16, 16, (g) => {
      roundRect(g, 3, 3, 10, 10, 2, "#ffffff");
    }),
  );
  spinnerImages(
    b,
    pro ? "#ffffff" : "rgba(220,240,255,1)",
    "rgba(255,255,255,0.18)",
  );
}

function chevron(
  g: Context,
  x: number,
  y: number,
  size: number,
  thickness: number,
  colour: string,
) {
  g.beginPath();
  g.moveTo(x - size / 2, y - size);
  g.lineTo(x + size / 2, y);
  g.lineTo(x - size / 2, y + size);
  g.lineWidth = thickness;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = colour;
  g.stroke();
}

function spinnerImages(b: Builder, main: string, ticks: string) {
  b.set(
    "spinner-circle",
    draw(300, 300, (g) => {
      ring(g, 150, 150, 148, 6, main);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        g.beginPath();
        g.moveTo(150 + Math.cos(a) * 118, 150 + Math.sin(a) * 118);
        g.lineTo(150 + Math.cos(a) * 136, 150 + Math.sin(a) * 136);
        g.lineWidth = 4;
        g.lineCap = "round";
        g.strokeStyle = ticks;
        g.stroke();
      }
    }),
  );
  b.set(
    "spinner-approachcircle",
    draw(300, 300, (g) => ring(g, 150, 150, 148, 5, main)),
  );
}

/* ----------------------------------------------------------------- mania */

interface ManiaFamily {
  /** Column width in legacy units, per column of a stage with `keys` columns. */
  width(keys: number, column: number): number;
  hitPosition: number;
  spacing: number;
  /** Column accent colour. */
  colour(keys: number, column: number): RGB;
  /** Column background colour and alpha (skin.ini Colour#). */
  background(accent: RGB): [RGB, number];
  note(accent: RGB, kind: "note" | "head" | "tail"): ImageBitmap;
  body(accent: RGB): ImageBitmap;
  key(accent: RGB, pressed: boolean): ImageBitmap;
  hint: ImageBitmap;
  light?: (accent: RGB) => RGB;
}
const special = (keys: number, column: number) =>
  keys % 2 === 1 && column === (keys - 1) / 2;

const argonColours = {
  special: rgb(169, 106, 255),
  yellow: rgb(255, 197, 40),
  orange: rgb(252, 109, 1),
  pink: rgb(213, 35, 90),
  purple: rgb(203, 60, 236),
  cyan: rgb(72, 198, 255),
  green: rgb(100, 192, 92),
};
/** ManiaArgonSkinTransformer.getColourForLayout. */
const argonLayouts: Record<number, (keyof typeof argonColours)[]> = {
  1: ["yellow"],
  2: ["green", "cyan"],
  3: ["green", "special", "cyan"],
  4: ["yellow", "orange", "pink", "purple"],
  5: ["pink", "orange", "yellow", "green", "cyan"],
  6: ["pink", "orange", "green", "cyan", "orange", "pink"],
  7: ["pink", "orange", "pink", "special", "pink", "orange", "pink"],
  8: ["purple", "pink", "orange", "green", "cyan", "orange", "pink", "purple"],
  9: [
    "purple",
    "pink",
    "orange",
    "yellow",
    "special",
    "yellow",
    "orange",
    "pink",
    "purple",
  ],
  10: [
    "purple",
    "pink",
    "orange",
    "yellow",
    "cyan",
    "green",
    "yellow",
    "orange",
    "pink",
    "purple",
  ],
};
const argonCycle: (keyof typeof argonColours)[] = [
  "yellow",
  "orange",
  "pink",
  "purple",
  "cyan",
  "green",
];

function argonMania(): ManiaFamily {
  // ArgonNotePiece: NOTE_HEIGHT 42, NOTE_ACCENT_RATIO 0.82, CORNER_RADIUS 3.4 (lazer units, 60 wide).
  const W = 60,
    H = 42,
    R = 3.4;
  return {
    width: (keys, column) =>
      (special(keys, column) ? 120 : 60) * LAZER_TO_LEGACY,
    hitPosition: 480 - 110 * LAZER_TO_LEGACY,
    spacing: 1 * LAZER_TO_LEGACY,
    colour: (keys, column) =>
      special(keys, column)
        ? argonColours.special
        : argonColours[
            (argonLayouts[keys] ?? [])[column] ??
              argonCycle[column % argonCycle.length]
          ],
    background: (accent) => [darken(accent, 3), 0.8],
    note: (accent, kind) =>
      draw(W, H, (g) => {
        roundRect(
          g,
          0,
          0,
          W,
          H,
          R,
          vertical(g, 0, H, [
            [0, "rgba(0,0,0,0)"],
            [1, "rgba(0,0,0,1)"],
          ]),
        );
        roundRect(
          g,
          0,
          H * (1 - 0.82),
          W,
          H * 0.82,
          R,
          vertical(g, H * 0.18, H, [
            [0, css(lighten(accent, 0.1))],
            [1, css(accent)],
          ]),
        );
        roundRect(g, 0, H - R * 2, W, R * 2, R, "#ffffff");
        if (kind !== "tail") {
          g.save();
          g.translate(W / 2, H / 2 + 4);
          g.scale(1, 0.7);
          chevronDown(g, 0, 0, 9, 3.2, "#ffffff");
          g.restore();
        }
      }),
    body: (accent) =>
      draw(W, W, (g) => roundRect(g, 0, 0, W, W, 0, css(darken(accent, 0.6)))),
    // ArgonKeyArea spans HIT_TARGET_POSITION (110) below the hit target.
    key: (accent, pressed) =>
      draw(W, 110, (g) => {
        roundRect(
          g,
          0,
          0,
          W,
          110,
          R,
          pressed ? css(darken(accent, 0.2), 0.85) : "rgba(20,20,22,0.92)",
        );
        roundRect(
          g,
          0,
          0,
          W,
          R * 2,
          R,
          pressed ? css(accent) : css([196 / 255, 196 / 255, 196 / 255]),
        );
        for (const dx of [-7, 0, 7])
          disc(g, W / 2 + dx, 46, 3, pressed ? "#ffffff" : css(accent, 0.6));
      }),
    hint: draw(W * 4, H * 0.82, (g) =>
      roundRect(g, 0, 0, W * 4, H * 0.82, R, "rgba(255,255,255,0.3)"),
    ),
    light: (accent) => accent,
  };
}

function chevronDown(
  g: Context,
  x: number,
  y: number,
  size: number,
  thickness: number,
  colour: string,
) {
  g.beginPath();
  g.moveTo(x - size, y - size / 2);
  g.lineTo(x, y + size / 2);
  g.lineTo(x + size, y - size / 2);
  g.lineWidth = thickness;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = colour;
  g.stroke();
}

function trianglesMania(): ManiaFamily {
  // DefaultNotePiece: NOTE_HEIGHT 12, corner radius 5; Column.COLUMN_WIDTH 80 / SPECIAL 70.
  const odd = rgb(94, 0, 57),
    even = rgb(6, 84, 0),
    specialColour = rgb(0, 48, 63);
  return {
    width: (keys, column) =>
      (special(keys, column) ? 70 : 80) * LAZER_TO_LEGACY,
    hitPosition: 480 - 110 * LAZER_TO_LEGACY,
    spacing: 1 * LAZER_TO_LEGACY,
    colour: (keys, column) => {
      if (special(keys, column)) return specialColour;
      const edge = Math.min(column, keys - 1 - column);
      return edge % 2 === 0 ? odd : even;
    },
    background: (accent) => [accent, 0.35],
    note: (accent, kind) =>
      draw(80, 12, (g) => {
        roundRect(g, 0, 0, 80, 12, 5, css(lighten(accent, 0.9)));
        if (kind !== "tail")
          roundRect(g, 0, 0, 80, 6, 5, css(lighten(accent, 1), 0.2));
      }),
    body: (accent) =>
      draw(80, 80, (g) => {
        roundRect(g, 0, 0, 80, 80, 0, css(accent, 0.7));
        roundRect(g, 37.5, 0, 5, 80, 0, "rgba(255,255,255,0.12)");
      }),
    key: (accent, pressed) =>
      draw(80, 110, (g) => {
        roundRect(
          g,
          0,
          0,
          80,
          110,
          0,
          vertical(g, 0, 110, [
            [0, css(accent, pressed ? 0.9 : 0.5)],
            [1, "rgba(0,0,0,0.9)"],
          ]),
        );
        roundRect(
          g,
          0,
          0,
          80,
          3,
          0,
          css(lighten(accent, 0.9), pressed ? 1 : 0.6),
        );
      }),
    hint: draw(320, 8, (g) =>
      roundRect(g, 0, 2, 320, 4, 0, "rgba(255,255,255,0.6)"),
    ),
    light: (accent) => lighten(accent, 0.9),
  };
}

function legacyMania(): ManiaFamily {
  // stable's default mania look: white / blue note pairs, a yellow centre note,
  // black columns, grey keys. Legacy skin.ini defaults: width 30, HitPosition 402.
  const white = rgb(236, 236, 236),
    blue = rgb(84, 156, 255),
    yellow = rgb(255, 212, 64);
  return {
    width: () => 30,
    hitPosition: 402,
    spacing: 0,
    colour: (keys, column) =>
      special(keys, column) ? yellow : column % 2 ? blue : white,
    background: () => [rgb(0, 0, 0), 1],
    note: (accent, kind) =>
      draw(30, 10, (g) => {
        roundRect(
          g,
          0.5,
          0.5,
          29,
          9,
          2,
          vertical(g, 0, 10, [
            [0, css(lighten(accent, 0.4))],
            [0.5, css(accent)],
            [1, css(darken(accent, 0.5))],
          ]),
        );
        if (kind === "tail")
          roundRect(g, 0.5, 0.5, 29, 2, 1, "rgba(255,255,255,0.5)");
      }),
    body: (accent) =>
      draw(30, 30, (g) => roundRect(g, 3, 0, 24, 30, 0, css(accent, 0.75))),
    // From HitPosition 402 to the stage's bottom edge (78 legacy units).
    key: (accent, pressed) =>
      draw(30, 78, (g) => {
        roundRect(
          g,
          1,
          2,
          28,
          74,
          3,
          vertical(
            g,
            0,
            78,
            pressed
              ? [
                  [0, css(lighten(accent, 0.2))],
                  [1, css(darken(accent, 0.6))],
                ]
              : [
                  [0, "#5b5b60"],
                  [1, "#2a2a2e"],
                ],
          ),
        );
        roundRect(g, 4, 6, 22, 4, 2, "rgba(255,255,255,0.35)");
      }),
    hint: draw(120, 6, (g) =>
      roundRect(g, 0, 2, 120, 2, 0, "rgba(255,255,255,0.9)"),
    ),
  };
}

function maniaSkin(b: Builder, family: ManiaFamily) {
  const notes = new Map<string, string>();
  const asset = (prefix: string, accent: RGB, make: () => ImageBitmap) => {
    const name = `builtin-${prefix}-${ini(accent)}`;
    if (!notes.has(name)) {
      notes.set(name, name);
      b.set(name, make());
    }
    return name;
  };
  b.set("mania-stage-hint", family.hint);
  const blocks: Record<string, string>[] = [];
  for (let keys = 1; keys <= 18; keys++) {
    const section: Record<string, string> = {
      Keys: String(keys),
      HitPosition: String(family.hitPosition),
      NoteBodyStyle: "0",
      KeysUnderNotes: "0",
      ColumnWidth: Array.from({ length: keys }, (_, c) =>
        family.width(keys, c).toFixed(3),
      ).join(","),
      ColumnSpacing: Array.from({ length: keys - 1 }, () =>
        family.spacing.toFixed(3),
      ).join(","),
    };
    for (let c = 0; c < keys; c++) {
      const accent = family.colour(keys, c),
        [background, alpha] = family.background(accent);
      section[`Colour${c + 1}`] = ini(background, alpha);
      if (family.light)
        section[`ColourLight${c + 1}`] = ini(family.light(accent))
          .split(",")
          .slice(0, 3)
          .join(",");
      section[`NoteImage${c}`] = asset("note", accent, () =>
        family.note(accent, "note"),
      );
      section[`NoteImage${c}H`] = asset("head", accent, () =>
        family.note(accent, "head"),
      );
      section[`NoteImage${c}T`] = asset("tail", accent, () =>
        family.note(accent, "tail"),
      );
      section[`NoteImage${c}L`] = asset("body", accent, () =>
        family.body(accent),
      );
      section[`KeyImage${c}`] = asset("key", accent, () =>
        family.key(accent, false),
      );
      section[`KeyImage${c}D`] = asset("keyd", accent, () =>
        family.key(accent, true),
      );
    }
    blocks.push(section);
  }
  b.skin.sections.set("Mania", blocks);
}

/* ----------------------------------------------------------------- taiko */

function taikoSkin(b: Builder, family: "legacy" | "triangles" | "argon") {
  const big = (name: string, paint: (g: Context, r: number) => void) => {
    b.set(
      name,
      draw(128, 128, (g) => paint(g, 64)),
    );
    b.set(
      name.replace("taiko", "taikobig").replace("hitcircle", "circle"),
      draw(128, 128, (g) => paint(g, 64)),
    );
  };
  if (family === "argon") {
    // ArgonCirclePiece: dark centre, a 20/70 ring at half alpha and a 5/70 ring.
    big("taikohitcircle", (g, r) => {
      disc(g, r, r, r, "rgba(0,0,0,0.745)");
      ring(g, r, r, r, (r * 2 * 20) / 70, "rgba(255,255,255,0.5)");
      ring(g, r, r, r, (r * 2 * 5) / 70, "#ffffff");
    });
    big("taikohitcircleoverlay", () => {});
  } else if (family === "triangles") {
    big("taikohitcircle", (g, r) => {
      g.save();
      g.beginPath();
      g.arc(r, r, r, 0, Math.PI * 2);
      g.clip();
      disc(g, r, r, r, "#ffffff");
      triangles(
        g,
        r * 2,
        r * 2,
        11,
        "rgba(255,255,255,0.25)",
        "rgba(0,0,0,0.1)",
      );
      g.restore();
    });
    big("taikohitcircleoverlay", (g, r) => ring(g, r, r, r, 8, "#ffffff"));
  } else {
    big("taikohitcircle", (g, r) => {
      const shade = g.createRadialGradient(r, r * 0.8, 4, r, r, r);
      shade.addColorStop(0, "#ffffff");
      shade.addColorStop(1, "#c8c8c8");
      disc(g, r, r, r * 0.92, shade);
    });
    big("taikohitcircleoverlay", (g, r) =>
      ring(g, r, r, r * 0.95, 7, "#ffffff"),
    );
  }
}

/* ----------------------------------------------------------------- catch */

function catchSkin(b: Builder, family: "legacy" | "triangles" | "argon") {
  const fruit = (name: string, paint: (g: Context) => void) =>
    b.set(name, draw(128, 128, paint));
  const shapes: Record<string, (g: Context) => void> = {
    "fruit-apple": (g) => disc(g, 64, 66, 50, "#ffffff"),
    "fruit-grapes": (g) => {
      for (const [x, y] of [
        [44, 50],
        [84, 50],
        [64, 50],
        [54, 74],
        [74, 74],
        [64, 96],
      ])
        disc(g, x, y, 20, "#ffffff");
    },
    "fruit-orange": (g) => disc(g, 64, 64, 52, "#ffffff"),
    "fruit-pear": (g) => {
      disc(g, 64, 80, 40, "#ffffff");
      disc(g, 64, 44, 26, "#ffffff");
    },
    "fruit-drop": (g) => disc(g, 64, 64, 30, "#ffffff"),
    "fruit-bananas": (g) => {
      g.beginPath();
      g.arc(64, 30, 70, Math.PI * 0.3, Math.PI * 0.7);
      g.lineWidth = 22;
      g.lineCap = "round";
      g.strokeStyle = "#ffffff";
      g.stroke();
    },
  };
  for (const [name, paint] of Object.entries(shapes)) {
    if (family === "argon")
      fruit(name, (g) => {
        disc(g, 64, 64, name === "fruit-drop" ? 30 : 50, "#ffffff");
        disc(g, 64, 64, name === "fruit-drop" ? 12 : 22, "rgba(0,0,0,0.35)");
      });
    else if (family === "triangles")
      fruit(name, (g) => {
        // FruitPulpFormation: a few pulp discs on a dark base.
        disc(
          g,
          64,
          64,
          name === "fruit-drop" ? 30 : 50,
          "rgba(255,255,255,0.75)",
        );
        if (name !== "fruit-drop")
          for (const [x, y] of [
            [64, 40],
            [42, 74],
            [86, 74],
          ])
            disc(g, x, y, 16, "#ffffff");
      });
    else fruit(name, paint);
    fruit(`${name}-overlay`, (g) =>
      family === "legacy" && name !== "fruit-drop"
        ? ring(g, 64, 64, 54, 4, "rgba(255,255,255,0.8)")
        : undefined,
    );
  }
  const plate = (accent: string) =>
    draw(200, 60, (g) => {
      roundRect(g, 10, 22, 180, 16, 8, accent);
      roundRect(g, 30, 38, 140, 8, 4, "rgba(255,255,255,0.45)");
    });
  const main =
    family === "argon"
      ? "#ffffff"
      : family === "triangles"
        ? "#e8e8f0"
        : "#f4e7c8";
  b.set("fruit-catcher-idle", plate(main));
  b.set("fruit-catcher-kiai", plate("#ffd166"));
  b.set("fruit-catcher-fail", plate("#ff6b6b"));
}

/* ----------------------------------------------------------------- entry */

/** Builds a client built-in skin from original drawings; synchronous Canvas 2D work only. */
export function builtinSkin(name: BuiltinSkinName): Skin {
  const family = name === "argon-pro" ? "argon" : name;
  const label = {
    legacy: "osu! (classic)",
    triangles: "osu! (triangles)",
    argon: "osu! (argon)",
    "argon-pro": "osu! (argon pro)",
  }[name];
  const style: SkinStyle = {
    builtin: name,
    slider:
      family === "argon"
        ? {
            profile: "argon",
            radius: (128 - (128 * 4 * 2) / 58) / 128,
            border: 0.2,
            alpha: name === "argon-pro" ? 0.92 : 0.98,
          }
        : family === "triangles"
          ? { profile: "triangles", radius: 1, border: 0.128, alpha: 1 }
          : { profile: "legacy", radius: 1, border: 0.1875, alpha: 0.7 },
    taiko:
      family === "argon"
        ? { centre: [241 / 255, 0, 0], rim: [0, 161 / 255, 241 / 255] }
        : family === "triangles"
          ? {
              centre: [...rgb(0xbb, 0x11, 0x77)],
              rim: [...rgb(0x22, 0x99, 0xbb)],
            }
          : {
              centre: [235 / 255, 69 / 255, 44 / 255],
              rim: [67 / 255, 142 / 255, 172 / 255],
            },
  };
  const b = builder(
    label,
    style,
    family === "legacy" ? { AnimationFramerate: "-1" } : {},
  );
  if (family === "argon") {
    osuArgon(b, name === "argon-pro");
    maniaSkin(b, argonMania());
  } else if (family === "triangles") {
    osuTriangles(b);
    maniaSkin(b, trianglesMania());
  } else {
    osuLegacy(b);
    maniaSkin(b, legacyMania());
  }
  taikoSkin(b, family);
  catchSkin(b, family);
  return b.skin;
}

/**
 * Layers a skin over a built-in fallback the way the clients resolve missing
 * elements: the skin's own images and configuration win, anything it lacks
 * comes from the fallback. Bitmaps are shared, not copied; the result keeps
 * the skin's slider look (legacy unless the skin says otherwise).
 */
export function withFallback(skin: Skin, fallback: Skin): Skin {
  const assets = new Map(fallback.assets),
    pixelScale = new Map(fallback.pixelScale ?? []);
  for (const [name, bitmap] of skin.assets) {
    assets.set(name, bitmap);
    pixelScale.set(name, skin.pixelScale?.get(name) ?? 1);
  }
  const sections = new Map(skin.sections);
  // A skin with no mania configuration or elements uses the fallback's stage.
  const ownsMania =
    skin.sections.has("Mania") ||
    [...skin.assets.keys()].some((name) => name.startsWith("mania-"));
  if (!ownsMania && fallback.sections.has("Mania"))
    sections.set("Mania", fallback.sections.get("Mania")!);
  return {
    ...skin,
    assets,
    pixelScale,
    sections,
    style: { taiko: fallback.style?.taiko, ...skin.style },
  };
}
