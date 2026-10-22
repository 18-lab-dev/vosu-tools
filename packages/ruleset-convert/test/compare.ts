import { applyMods, parseOsu, type Mod } from "@vosu-tools/osu-parse";
import {
  convertToCatch,
  convertToMania,
  convertToTaiko,
  legacyBeatmap,
} from "../src/index";
import { pointAt } from "../src/legacy";

/**
 * Shared by the fixture tests and the real-map golden script: runs our port
 * the way the C# reference oracle (test/reference) runs lazer, and reports
 * every difference against the oracle's JSON.
 */

export type Target = "taiko" | "mania" | "fruits";

/** The oracle's output shape (test/reference/Program.cs). */
export type OracleOutput =
  | {
      columns: number;
      stages: number;
      objects: { t: number; e: number; c: number; k: "note" | "hold" }[];
    }
  | {
      objects: {
        t: number;
        e: number;
        k: "hit" | "drumroll" | "swell";
        rim: boolean;
        strong: boolean;
      }[];
      scroll: { t: number; v: number }[];
    }
  | {
      objects: {
        t: number;
        x: number;
        k: "fruit" | "droplet" | "tiny" | "banana";
        hyper: boolean;
      }[];
    };

/** Our port, shaped like the oracle's output. */
export function portOutput(
  osuText: string,
  target: Target,
  modAcronyms: readonly string[] = [],
): OracleOutput {
  const source = parseOsu(osuText),
    mods: Mod[] = modAcronyms.map((acronym) => ({ acronym })),
    legacy = legacyBeatmap(source);
  if (target === "mania") {
    const result = convertToMania(legacy, mods);
    return {
      columns: result.columns * result.stages,
      stages: result.stages,
      objects: result.notes.map((n) => ({
        t: n.time,
        e: n.endTime,
        c: n.column,
        k: n.hold ? "hold" : "note",
      })),
    };
  }
  if (target === "taiko") {
    const result = convertToTaiko(legacy);
    return {
      objects: result.objects.map((o) => ({
        t: o.time,
        e: o.endTime,
        k: o.kind,
        rim: o.rim,
        strong: o.strong,
      })),
      scroll: result.effects.map((e) => ({ t: e.time, v: e.scrollSpeed })),
    };
  }
  // Catch: difficulty mods change the catcher width before processing.
  const modded = applyMods({ ...source, mode: 2 }, mods);
  return {
    objects: convertToCatch(legacyBeatmap(modded), {
      circleSize: modded.difficulty.cs,
      hardRock: modded.visualMods.includes("HR"),
    }).map((o) => ({ t: o.time, x: o.x, k: o.kind, hyper: o.hyper })),
  };
}

export interface Comparison {
  objects: [expected: number, actual: number];
  mismatches: string[];
  /** Largest |Δx| between matching catch objects (path flattening differs slightly). */
  maxDx?: number;
}

const near = (a: number, b: number, epsilon: number) =>
  Math.abs(a - b) <= epsilon;

/** Scroll speed at `time` from a list of {t, v} points (default 1). */
const speedAt = (points: readonly { t: number; v: number }[], time: number) =>
  pointAt(
    points.map((p) => ({ time: p.t, v: p.v })),
    time,
    { time: 0, v: 1 },
  ).v;

/**
 * Exact for mania and taiko; catch x positions may differ by `catchTolerance`
 * pixels because osu-parse flattens curves with its own subdivision.
 */
export function compare(
  target: Target,
  expected: OracleOutput,
  actual: OracleOutput,
  catchTolerance = 0.05,
): Comparison {
  const mismatches: string[] = [];
  const e = expected.objects as Record<string, unknown>[],
    a = actual.objects as Record<string, unknown>[];
  const result: Comparison = { objects: [e.length, a.length], mismatches };
  if ("columns" in expected && "columns" in actual) {
    if (expected.columns !== actual.columns)
      mismatches.push(`columns ${expected.columns} ≠ ${actual.columns}`);
    if (expected.stages !== actual.stages)
      mismatches.push(`stages ${expected.stages} ≠ ${actual.stages}`);
  }
  if (e.length !== a.length)
    mismatches.push(`object count ${e.length} ≠ ${a.length}`);
  let maxDx = 0;
  for (let i = 0; i < Math.min(e.length, a.length); i++) {
    const x = e[i],
      y = a[i];
    const keys = Object.keys(x).filter((k) => k !== "hits");
    for (const key of keys) {
      const u = x[key],
        v = y[key];
      if (key === "x" && typeof u === "number" && typeof v === "number") {
        maxDx = Math.max(maxDx, Math.abs(u - v));
        if (!near(u, v, catchTolerance))
          mismatches.push(`#${i} t=${x.t} x ${u} ≠ ${v}`);
      } else if (typeof u === "number" && typeof v === "number") {
        if (!near(u, v, 1e-6))
          mismatches.push(`#${i} t=${x.t} ${key} ${u} ≠ ${v}`);
      } else if (u !== v) mismatches.push(`#${i} t=${x.t} ${key} ${u} ≠ ${v}`);
    }
    if (mismatches.length > 20) break;
  }
  if (target === "taiko" && "scroll" in expected && "scroll" in actual) {
    for (const o of e as { t: number }[]) {
      const want = speedAt(expected.scroll, o.t),
        got = speedAt(actual.scroll, o.t);
      if (!near(want, got, 1e-9)) {
        mismatches.push(`scroll speed at ${o.t}: ${want} ≠ ${got}`);
        break;
      }
    }
  }
  if (target === "fruits") result.maxDx = maxDx;
  return result;
}
