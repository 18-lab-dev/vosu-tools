/**
 * A replay's mods as lazer applies them: lazer replays store their mod list
 * with settings; osu!stable replays only have the legacy bits.
 */
import { applyMods, type Beatmap } from "@vosu-tools/osu-parse";
import type { Replay } from "./index";

export type ReplayMod = { acronym: string; settings?: Record<string, unknown> };

/** osu!stable's mod bits, in lazer's acronyms (`LegacyMods`). */
const LEGACY_MODS: [number, string][] = [
  [1, "NF"],
  [2, "EZ"],
  [4, "TD"],
  [8, "HD"],
  [16, "HR"],
  [32, "SD"],
  [16384, "PF"],
  [512, "NC"],
  [64, "DT"],
  [128, "RX"],
  [256, "HT"],
  [1024, "FL"],
  [4096, "SO"],
  [8192, "AP"],
  [1048576, "FI"],
  [2097152, "RD"],
  [4194304, "CN"],
  [8388608, "TP"],
  [67108864, "1K"],
  [268435456, "2K"],
  [134217728, "3K"],
  [32768, "4K"],
  [65536, "5K"],
  [131072, "6K"],
  [262144, "7K"],
  [524288, "8K"],
  [16777216, "9K"],
  [33554432, "DS"],
  [1 << 29, "SV2"],
  [1073741824, "MR"],
];

/** The replay's mods: lazer's own list (with settings) when stored, else the legacy bits. */
export function replayMods(replay: Pick<Replay, "mods" | "lazer">): ReplayMod[] {
  if (replay.lazer) return replay.lazer.mods;
  const mods: ReplayMod[] = [];
  for (const [bit, acronym] of LEGACY_MODS) {
    if (!(replay.mods & bit)) continue;
    // NC and PF carry DT and SD's bits too.
    if (acronym === "DT" && replay.mods & 512) continue;
    if (acronym === "SD" && replay.mods & 16384) continue;
    mods.push({ acronym });
  }
  return mods;
}

export const speedOf = (mod: ReplayMod): number =>
  Number(mod.settings?.speed_change ?? (mod.acronym === "DT" || mod.acronym === "NC" ? 1.5 : 0.75));
const RATE_MODS = ["DT", "NC", "HT", "DC"];

/** Gameplay rate: lazer's own speed setting when stored, else the legacy DT/HT rate. */
export function replayRate(replay: Pick<Replay, "mods" | "lazer">): number {
  const mod = replayMods(replay).find((m) => RATE_MODS.includes(m.acronym));
  const speed = mod ? speedOf(mod) : 1;
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

/** Whether the song's pitch follows the rate: Nightcore, Daycore, or DT/HT's "adjust pitch". */
export function replayPitched(replay: Pick<Replay, "mods" | "lazer">): boolean {
  return replayMods(replay).some(
    (m) => m.acronym === "NC" || m.acronym === "DC" || (RATE_MODS.includes(m.acronym) && m.settings?.adjust_pitch === true),
  );
}

/** lazer's Classic mod: imported osu!stable replays always play with it. */
export const isClassic = (replay: Pick<Replay, "mods" | "lazer" | "version">): boolean =>
  !replay.lazer && replay.version < 30000000 ? true : replayMods(replay).some((m) => m.acronym === "CL");

/**
 * Mods whose effect on the map or on judgement is not reproduced, so the
 * replay cannot be judged here (empty when everything is).
 */
export function unreproducedMods(replay: Pick<Replay, "mode" | "mods" | "lazer" | "version">): string[] {
  const out: string[] = [];
  for (const m of replayMods(replay)) {
    const a = m.acronym;
    if (a === "RD" && (replay.mode === 0 || m.settings?.seed === undefined))
      out.push(replay.mode === 0 ? "osu! Random positions" : "osu!stable Random (no seed)");
    else if (a === "WU" || a === "WD" || a === "AS") out.push("changing speed (Wind Up/Down, Adaptive Speed)");
    else if (["RX", "AP", "AT", "CN"].includes(a)) out.push("Relax, Autopilot and autoplay");
    else if (a === "TP" || a === "TR" || a === "WG" || a === "MG" || a === "RP" || a === "SI" || a === "FR") out.push(`${a} (object movement)`);
  }
  return [...new Set(out)];
}

/** The playable map for a replay: the parsed `.osu` with the replay's mods and settings. */
export function beatmapForReplay(raw: Beatmap, replay: Pick<Replay, "mods" | "lazer">): Beatmap {
  return applyMods(raw, replayMods(replay));
}
