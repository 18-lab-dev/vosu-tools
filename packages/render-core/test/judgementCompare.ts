/**
 * Judgement goldens: render-core's judgement elements (motion kind 35)
 * against osu!lazer's own, as dumped by test/reference/VosuLayout.cs under
 * autoplay (test/judgementGolden.ts writes the fixture, `bun test` replays
 * it).
 *
 * `evaluateJudgement` repeats the WGSL vertex stage's kind-35 arithmetic
 * (shader.ts) on the CPU, so the comparison covers the transform sequences
 * as well as placement.
 */
import { parseOsu } from "@vosu-tools/osu-parse";
import { catchObjects } from "@vosu-tools/ruleset-convert";
import type { JudgementEvent } from "../src/judgements";
import type { LayoutCase, LayoutItem, LayoutResult, PlacedItem } from "./layoutCompare";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeOutQuint = (t: number) => 1 - (1 - t) ** 5;
const outElastic = (t: number) =>
  t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t - 0.075) * Math.PI * 2) / 0.3) + 1;
const chainHit = (dt: number, endScale: number) =>
  dt < 96
    ? 0.6 + (0.5 * Math.max(dt, 0)) / 96
    : dt < 120
      ? 1.1
      : dt < 144
        ? 1.1 - (0.2 * (dt - 120)) / 24
        : dt < 168
          ? 0.95 + ((endScale - 0.95) * (dt - 144)) / 24
          : endScale;

/** One kind-35 instance at `now` (the shader's arithmetic); `cursorX` is the catcher. */
export function evaluateJudgement(
  d: ArrayLike<number>,
  now: number,
  cursorX: number,
): { x: number; y: number; w: number; h: number; angle: number; alpha: number } {
  const start = d[4],
    dt = now - start,
    profile = Math.round(d[13]),
    p1 = d[14],
    p2 = d[15],
    animated = d[22] > 1,
    in120 = clamp01(dt / 120),
    out500 = clamp01(1 - (dt - 500) / 600);
  let x = d[0],
    y = d[1],
    w = d[2],
    h = d[3],
    angle = 0,
    alpha = d[11],
    scale = 1,
    group = 1;
  if (profile === 0 || profile === 4) {
    alpha *= in120 * out500;
    if (!animated || profile === 4) scale *= chainHit(dt, p2);
    if (profile === 4)
      alpha *= Math.max(0, dt < 40 ? 0.5 * easeOut(clamp01((dt + 16) / 56)) : 0.5 * (1 - (dt - 40) / 300));
  } else if (profile === 1) {
    alpha *= in120 * out500;
    if (!animated) {
      const t = clamp01(dt / 100);
      scale *= 1.6 - 0.6 * t * t;
      const late = clamp01((dt - 120) / 980);
      angle = p1 * (dt < 120 ? in120 : 1 + late * late);
      const fall = clamp01(dt / 1100);
      y += p2 * (-5 + 80 * fall * fall);
    }
  } else if (profile === 2) {
    alpha *= in120 * clamp01(1 - (dt - 250) / 600);
    if (!animated) {
      const t = clamp01(dt / 100);
      scale *= 1.2 - 0.2 * t * t;
    }
  } else if (profile === 3) {
    alpha *= in120 * out500;
    if (!animated) scale *= 0.9 + 0.15 * clamp01(dt / 1100);
  } else if (profile === 5) {
    alpha *= dt < 400 ? clamp01(dt / 200) : clamp01(1 - (dt - 400) / 1000);
    scale *= 0.8 + 0.4 * easeOut(clamp01(dt / 600));
  } else if (profile === 6) {
    y -= 10 * p1 * easeOut(clamp01(dt / 300));
    alpha *= clamp01(1 - (dt - 300) / 60);
  } else if (profile === 7 || profile === 8) {
    const late = clamp01((dt - 180) / 40);
    alpha *= easeOut(clamp01(dt / 20)) * (1 - late * late);
    if (profile === 7)
      scale *=
        dt < 40 ? 0.8 + (0.2 * dt) / 40 : dt < 80 ? 0.85 - (0.15 * (dt - 40)) / 40 : dt < 180 ? 0.7 : 0.7 - 0.3 * late * late;
    else {
      const t = easeOut(clamp01(dt / 100));
      scale *= 1.2 - 0.2 * t;
      angle = p1 * t;
    }
  } else if (profile === 9) alpha *= dt < 80 ? clamp01(dt / 80) : clamp01(1 - (dt - 80) / 120);
  else if (profile === 10) {
    alpha *= dt < 120 ? in120 : clamp01(1 - (dt - 120) / 180);
    if (!animated)
      scale *=
        dt < 96 ? 0.6 + (0.5 * dt) / 96 : dt < 144 ? 1.1 - (0.2 * (dt - 96)) / 48 : dt < 168 ? 0.9 + (0.1 * (dt - 144)) / 24 : 1;
    if (p1 > 0) {
      const second = easeOutQuint(clamp01((now - p1) / 50));
      alpha *= p2 > 0.5 ? second : 1 - second;
    }
  } else if (profile === 11 || profile === 12) {
    if (profile === 11) {
      const e = easeOut(clamp01(dt / 160));
      alpha *= clamp01(1 - dt / 300);
      [w, h] = [d[2] * (0.9 + 0.2 * e), d[3] * (1 + (p1 - 1) * e)];
    } else {
      alpha *= clamp01(1 - dt / 700);
      [w, h] = [d[2] * (1 + 0.3 * easeOut(clamp01(dt / 500))), d[3] * 0.9];
    }
    y = d[1] - h / 2;
    if (dt >= 700) alpha = 0;
  } else if (profile >= 13 && profile <= 15) {
    const since = now - p1;
    alpha *= (since > 1000 ? clamp01(1 - (since - 1000) / 300) : 1) * (now > p2 ? 1 - easeOut(clamp01((now - p2) / 400)) : 1);
    if (profile === 13) group = 1.5 - 0.7 * easeOut(clamp01(dt / 250));
    if (profile === 14) group = dt < 60 ? 1 + (0.1 * dt) / 60 : dt < 90 ? 1.1 - (0.1 * (dt - 60)) / 30 : 1;
    if (profile === 15) {
      group = 1.5 + 0.4 * easeOut(clamp01(dt / 400));
      alpha *= clamp01(1 - dt / 400);
    }
    scale *= group;
  }
  if (profile >= 11 && profile <= 15) x = cursorX + d[0] * group;
  if (profile === 18) {
    const pop = 0.8 + 0.2 * outElastic(clamp01(Math.min(dt, 50) / 250));
    scale *= dt > 50 ? pop + (0.75 - pop) * clamp01((dt - 50) / 250) : pop;
    alpha *= clamp01(1 - (dt - 50) / 200);
  }
  if (profile === 17) {
    alpha *= clamp01(1 - dt / 800);
    if (p1 > 1.5) w *= 0.8 + 0.4 * easeOutQuint(clamp01(dt / 1800));
    if (p1 > 0.5 && p1 < 1.5) {
      const t = clamp01(dt / 100),
        quint = clamp01(dt / 800) ** 5;
      scale *= 1.6 - 0.6 * t * t;
      y += 100 * p2 * quint;
      angle = 0.6981317 * quint;
    }
  }
  if (profile === 16) {
    const duration = Math.floor(p1 / 8),
      direction = p1 - duration * 8,
      progress = clamp01((dt + 100) / duration);
    x += p2 * progress * Math.sin(direction);
    y += p2 * progress * Math.cos(direction);
    alpha *= in120 * out500 * clamp01(1 - (dt + 100) / 1600) * (1 - progress);
  }
  // Replay-input profiles (shader.ts 19-27).
  if (profile === 19) {
    const down = 80 * (1 - p1);
    const a = dt < down ? p1 + (1 - p1) * easeOut(dt / down) : 1;
    alpha *= a * clamp01(1 - (dt - 100) / 50);
  }
  if (profile === 20) {
    alpha *= clamp01((now - p1) / 100) * (now > p2 ? clamp01(1 - (now - p2) / 600) : 1);
    if (start > p1 + 0.01) scale *= 1 + 0.1875 * (1 - easeOut(clamp01(dt / 80)));
  }
  if (profile === 22 || profile === 23) {
    angle = p2;
    const f = clamp01(dt / 750);
    alpha *= 1 - f;
    if (profile === 22) y += 75 * (1 - Math.cos((f * Math.PI) / 2));
    else {
      y += dt < 250 ? -50 * Math.sin((clamp01(dt / 250) * Math.PI) / 2) : -50 + 100 * (1 - Math.cos((clamp01((dt - 250) / 500) * Math.PI) / 2));
      x += p1 * clamp01(dt / 1000);
    }
  }
  if (profile === 24) alpha *= 0.4 * (1 - easeOutQuint(clamp01(dt / 800)));
  if (profile === 25) {
    const e = clamp01(dt / 1200),
      q = e * e,
      k = 0.95 + 0.19 * q;
    y = p1 + (d[1] - p1) * k - 10 * q;
    scale *= k;
    alpha *= 1 - e;
  }
  if (profile === 26 && now > p1) {
    const t = clamp01((now - p1) / 250);
    alpha *= 1 - t;
    h *= 1 - t;
    y = d[1] + d[3] / 2 - h / 2;
  }
  if (profile === 27) angle = p1;
  return { x, y, w: w * scale, h: h * scale, angle, alpha };
}

/** A golden case: a tiny map played by lazer's autoplay, dumped at `time`. */
export interface JudgementCase extends LayoutCase {
  ruleset: "osu" | "taiko" | "catch" | "mania";
}

/** The synthetic maps, one per ruleset; autoplay hits every object on time. */
export const JUDGEMENT_MAPS: Record<JudgementCase["ruleset"], string> = {
  osu: "osu file format v14\n[General]\nMode: 0\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:8\nApproachRate:9\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,5,0\n",
  taiko:
    "osu file format v14\n[General]\nMode: 1\n[Difficulty]\nHPDrainRate:5\nCircleSize:5\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,1,0\n256,192,3000,1,4\n",
  catch:
    "osu file format v14\n[General]\nMode: 2\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:5\nApproachRate:8\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,5,0\n256,192,1250,1,0\n",
  mania:
    "osu file format v14\n[General]\nMode: 3\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,1000,1,0\n",
};
/** Moments after the first hit (1000 ms) the cases dump. */
export const JUDGEMENT_TIMES: Record<JudgementCase["ruleset"], number[]> = {
  osu: [1030, 1080, 1110, 1140, 1160, 1300, 1450, 1700, 1900],
  taiko: [1030, 1080, 1110, 1150, 1200, 1260, 3025, 3070],
  catch: [1050, 1120, 1200, 1300, 1450, 1600],
  mania: [1010, 1030, 1060, 1120, 1190, 1210],
};

/** The results lazer's autoplay gives these maps, as render-core events. */
export function autoplayEvents(ruleset: JudgementCase["ruleset"]): JudgementEvent[] {
  const map = parseOsu(JUDGEMENT_MAPS[ruleset]);
  if (ruleset === "catch")
    return catchObjects(map).map((o, i) => ({
      time: o.time,
      result: "great",
      note: o.index,
      object: "fruit",
      x: o.x,
      y: 0,
      combo: i + 1,
      catcher: o.x,
    }));
  return map.objects.flatMap((o, i): JudgementEvent[] => {
    if (ruleset === "osu")
      return [{ time: o.time, result: "great", note: i, object: "circle", x: o.x, y: o.y, combo: i + 1 }];
    if (ruleset === "mania")
      return [{ time: o.time, result: "perfect", note: i, object: "note", x: 0, y: 0, combo: i + 1 }];
    const hit: JudgementEvent = { time: o.time, result: "great", note: i, object: "hit", x: 0, y: 0, combo: i + 1 };
    // Autoplay strikes both drums of a big note in the same frame.
    return o.sound & 4 ? [hit, { ...hit, result: "large_bonus", object: "strong" }] : [hit];
  });
}

/** A lazer texture lookup key (`hit300@2x:wrap-0-0`) as an image name (`hit300`). */
export const textureAsset = (name: string) =>
  name.replace(/:wrap-.*$/, "").replace(/^.*\//, "").replace(/@2x$/, "").replace(/\.png$/, "");
/**
 * Judgement textures lazer draws as sprites (`hit300`, `taiko-hit300k`,
 * `lightingN`, ...). The catch combo counter is sprite text, which the dump
 * does not list, so `bun test` checks it against the transform sequence only.
 */
export const isJudgementTexture = (name: string | null) =>
  !!name &&
  /^(hit(0|50|100|300)|lighting|lightingN|taiko-hit(0|100|300)k?|mania-hit(0|50|100|200|300|300g)|scoreboard-explosion-[12])$/.test(
    textureAsset(name),
  );

const centreOf = (quad: number[]) => [(quad[0] + quad[2] + quad[4] + quad[6]) / 4, (quad[1] + quad[3] + quad[5] + quad[7]) / 4];
const sizeOf = (quad: number[]) => [Math.hypot(quad[2] - quad[0], quad[3] - quad[1]), Math.hypot(quad[4] - quad[0], quad[5] - quad[1])];

export interface JudgementMismatch {
  asset: string;
  reason: string;
  lazer?: { centre: number[]; size: number[]; alpha: number };
  ours?: { centre: number[]; size: number[]; alpha: number };
}

/**
 * Every judgement sprite lazer drew must be matched by one of render-core's
 * (same image, centre within 1.5 units, size within 2 %, opacity within
 * 0.05), and render-core must draw no visible judgement sprite lazer does not.
 * `sizeExempt` images (the classic skin's catch explosions, which render-core
 * draws itself) are compared by place and opacity only.
 */
export function compareJudgements(
  lazer: LayoutResult,
  placed: PlacedItem[],
  sizeExempt: (asset: string) => boolean = () => false,
): JudgementMismatch[] {
  const asset = (item: LayoutItem) => textureAsset(item.texture!.name!);
  const theirs = lazer.items.filter((i) => i.texture && isJudgementTexture(i.texture.name) && i.alpha > 0.02);
  const ours = placed.filter((p) => p.motion === 35 && p.alpha > 0.02 && !/^score(-\d)?$/i.test(p.asset));
  const used = new Set<PlacedItem>();
  const out: JudgementMismatch[] = [];
  for (const item of theirs) {
    const name = asset(item),
      centre = centreOf(item.quad),
      local = sizeOf(item.quad);
    const candidates = ours.filter((p) => !used.has(p) && p.asset.replace(/^vosu-catch-explosion/, "scoreboard-explosion").toLowerCase() === name.toLowerCase());
    const best = candidates.sort(
      (a, b) => Math.hypot(a.centre[0] - centre[0], a.centre[1] - centre[1]) - Math.hypot(b.centre[0] - centre[0], b.centre[1] - centre[1]),
    )[0];
    const view = (p: PlacedItem) => ({ centre: p.centre.map((v) => +v.toFixed(2)), size: p.size.map((v) => +v.toFixed(2)), alpha: +p.alpha.toFixed(3) });
    const theirsView = (size: number[]) => ({ centre: centre.map((v) => +v.toFixed(2)), size: size.map((v) => +v.toFixed(2)), alpha: +item.alpha.toFixed(3) });
    if (!best) {
      out.push({ asset: name, reason: "missing", lazer: theirsView(local) });
      continue;
    }
    used.add(best);
    // A quad turned a quarter from ours (catch's rotated explosions, which
    // render-core draws upright with swapped sides) compares its sides swapped.
    const turn = (((Math.atan2(item.quad[3] - item.quad[1], item.quad[2] - item.quad[0]) * 180) / Math.PI - best.angle) % 180 + 180) % 180,
      size = Math.abs(turn - 90) < 1 ? [local[1], local[0]] : local;
    const exempt = sizeExempt(name);
    const sizeOk =
      exempt ||
      (Math.abs(best.size[0] - size[0]) <= Math.max(0.5, size[0] * 0.02) &&
        Math.abs(best.size[1] - size[1]) <= Math.max(0.5, size[1] * 0.02));
    // Catch lighting sits where the fruit landed on the plate; lazer jitters
    // fruits caught onto a stacked one with its unseeded RNG
    // (Catcher.computePositionInStack), so only the first catch's x is exact.
    const jitter = /^scoreboard-explosion/.test(name);
    const placeOk =
      Math.hypot(best.centre[0] - centre[0], best.centre[1] - centre[1]) <= 1.5 ||
      (exempt && Math.abs(best.centre[0] - centre[0]) <= 1.5) ||
      (jitter && Math.abs(best.centre[1] - centre[1]) <= 1.5);
    if (!placeOk || !sizeOk || Math.abs(best.alpha - item.alpha) > 0.05)
      out.push({ asset: name, reason: !placeOk ? "place" : !sizeOk ? "size" : "opacity", lazer: theirsView(size), ours: view(best) });
  }
  for (const p of ours)
    if (!used.has(p))
      out.push({ asset: p.asset, reason: "extra", ours: { centre: p.centre, size: p.size, alpha: p.alpha } });
  return out;
}

/** The synthetic skin the goldens use: judgement images of distinct sizes. */
export const JUDGEMENT_SKIN = {
  name: "judgements",
  ini: "[General]\nName: judgements\nVersion: 2.7\n[Fonts]\nComboPrefix: score\nComboOverlap: 4\n",
  files: {
    "hit0.png": [80, 80],
    "hit50.png": [100, 50],
    "hit100.png": [110, 55],
    "hit300.png": [120, 60],
    "lighting.png": [128, 128],
    "lightingN.png": [120, 120],
    "taiko-hit0.png": [100, 100],
    "taiko-hit100.png": [120, 120],
    "taiko-hit100k.png": [140, 140],
    "taiko-hit300.png": [150, 150],
    "taiko-hit300k.png": [180, 180],
    "mania-hit0.png": [150, 60],
    "mania-hit50.png": [152, 60],
    "mania-hit100.png": [154, 60],
    "mania-hit200.png": [156, 60],
    "mania-hit300.png": [158, 60],
    "mania-hit300g.png": [160, 60],
    ...Object.fromEntries(Array.from({ length: 10 }, (_, d) => [`score-${d}.png`, [24 + d, 36]])),
  } as Record<string, [number, number]>,
};
