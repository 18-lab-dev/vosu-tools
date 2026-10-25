/**
 * Overlap: several osu! replays of one map on a single playfield, to compare
 * aim. Hit objects are drawn once; each player has a cursor in their own
 * colour, judgements are filtered and coloured per player, and a compact
 * legend replaces the per-player HUD.
 */
import { replayMods, replayRate, type Replay, type ReplayMod } from "@vosu-tools/replay";
import type { JudgementEvent } from "@vosu-tools/render-core";

/** Players one overlap shows at most. */
export const MAX_OVERLAP = 8;
export type OverlapJudgements = "misses" | "all" | "none";
export const OVERLAP_JUDGEMENTS: readonly OverlapJudgements[] = ["misses", "all", "none"];
export interface OverlapOptions {
  /** Index of the track whose state overlays follow (and whose skin, background
   *  and playfield placement the overlap uses). */
  focus: number;
  /** Which judgements are drawn, each in its player's colour. */
  judgements: OverlapJudgements;
  /** Name tags beside the cursors. */
  names: boolean;
  /** The focus player's health bar. */
  health: boolean;
}
export const DEFAULT_OVERLAP: OverlapOptions = { focus: 0, judgements: "misses", names: true, health: false };

/** Reads options from untrusted JSON (a render spec, stored choices), with defaults. */
export function overlapOptions(value: unknown, players: number): OverlapOptions {
  const input = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof OverlapOptions, unknown>>;
  const focus = Number(input.focus);
  return {
    focus: Number.isInteger(focus) && focus >= 0 && focus < Math.max(1, players) ? focus : 0,
    judgements: OVERLAP_JUDGEMENTS.includes(input.judgements as OverlapJudgements)
      ? (input.judgements as OverlapJudgements)
      : DEFAULT_OVERLAP.judgements,
    names: typeof input.names === "boolean" ? input.names : DEFAULT_OVERLAP.names,
    health: typeof input.health === "boolean" ? input.health : DEFAULT_OVERLAP.health,
  };
}

/**
 * Player colours: the Okabe–Ito palette, distinguishable with the common
 * colour-vision deficiencies, with its black swapped for a light grey that
 * shows on a dimmed background. Player i always gets colour i.
 */
export const OVERLAP_COLOURS: readonly string[] = [
  "#E69F00",
  "#56B4E9",
  "#009E73",
  "#F0E442",
  "#CC79A7",
  "#D55E00",
  "#0072B2",
  "#D9D9D9",
];
export const overlapColour = (index: number) => OVERLAP_COLOURS[index % OVERLAP_COLOURS.length];
/** A player's colour as RGB in 0-1, render-core's tint. */
export function overlapTint(index: number): [number, number, number] {
  const hex = overlapColour(index);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Mods that change nothing about where and when objects are: players with
 *  different ones still share a playfield. Visual ones (HD, FL, …) are drawn
 *  only when every player has them. */
const MIXABLE = new Set([
  "NM", "NF", "SD", "PF", "HD", "FL", "BL", "TC", "NS", "SO", "TD", "CL", "SV2", "AC", "MU",
  "RX", "AP", "AL", "SG", "AT", "CN",
]);
/** Visual mods, drawn only when every player has them. */
const VISUAL = new Set(["HD", "FL", "BL", "TC", "NS"]);
/** Rate mods: compared by the rate they give, so DT and NC at 1.5× may mix. */
const RATE = new Set(["DT", "NC", "HT", "DC"]);
/** Settings that do not move or time objects (EZ's extra lives). */
const IGNORED_SETTINGS: Record<string, readonly string[]> = { EZ: ["retries"] };

function settingsKey(mod: ReplayMod): string {
  const ignored = IGNORED_SETTINGS[mod.acronym] ?? [];
  const entries = Object.entries(mod.settings ?? {})
    .filter(([key]) => !ignored.includes(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length ? `${mod.acronym}(${entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")})` : mod.acronym;
}
/** The mods that set a replay's playfield geometry and timing, e.g. `HR`,
 *  `DA(circle_size=5)`; empty when there are none. */
export function playfieldMods(replay: Pick<Replay, "mods" | "lazer">): string[] {
  return replayMods(replay)
    .filter((mod) => !MIXABLE.has(mod.acronym) && !RATE.has(mod.acronym))
    .map(settingsKey)
    .sort();
}

export type OverlapPlayer = Pick<Replay, "mode" | "beatmapHash" | "mods" | "lazer" | "player">;
export type Eligibility =
  | { ok: true; notes: string[]; mods: string[] }
  | { ok: false; reason: string };

const rateLabel = (rate: number) => `${Number(rate.toFixed(3))}×`;
const modsLabel = (mods: readonly string[]) => (mods.length ? mods.join(" ") : "no mods");

/**
 * Whether these replays can share one playfield: osu!, 2 to 8 players, the
 * same beatmap (MD5), the same clock rate and the same playfield mods
 * (HR/EZ/DA/MR and any lazer mod that moves or resizes objects, with its
 * settings). `notes` say what is drawn differently from a player's own game
 * (visual mods that not everyone has); `mods` are the visual mods drawn.
 */
export function overlapEligibility(replays: readonly OverlapPlayer[]): Eligibility {
  if (replays.length < 2) return { ok: false, reason: "Overlap needs at least 2 replays" };
  if (replays.length > MAX_OVERLAP)
    return { ok: false, reason: `Overlap shows at most ${MAX_OVERLAP} players; remove ${replays.length - MAX_OVERLAP}` };
  const other = replays.find((r) => r.mode !== 0);
  if (other) return { ok: false, reason: `Overlap is for osu! only; ${other.player} played another ruleset` };
  const [first] = replays;
  const map = replays.find((r) => r.beatmapHash !== first.beatmapHash);
  if (map) return { ok: false, reason: `Overlap needs one beatmap; ${map.player} played a different one (MD5)` };
  const rate = replayRate(first);
  const faster = replays.find((r) => Math.abs(replayRate(r) - rate) > 1e-9);
  if (faster)
    return {
      ok: false,
      reason: `Overlap needs one speed; ${first.player} plays at ${rateLabel(rate)}, ${faster.player} at ${rateLabel(replayRate(faster))}`,
    };
  const mods = playfieldMods(first).join(" ");
  const moved = replays.find((r) => playfieldMods(r).join(" ") !== mods);
  if (moved)
    return {
      ok: false,
      reason: `Overlap needs the same playfield mods; ${first.player} has ${modsLabel(playfieldMods(first))}, ${moved.player} ${modsLabel(playfieldMods(moved))}`,
    };
  const visual = (r: OverlapPlayer) => replayMods(r).map((m) => m.acronym).filter((a) => VISUAL.has(a));
  const shared = visual(first).filter((a) => replays.every((r) => visual(r).includes(a)));
  const dropped = [...new Set(replays.flatMap(visual))].filter((a) => !shared.includes(a)).sort();
  return {
    ok: true,
    mods: shared,
    notes: dropped.length ? [`Not every player has ${dropped.join(", ")}: objects are drawn without it`] : [],
  };
}

/** The mods the shared playfield is drawn with: the focus player's, without
 *  visual mods that not every player has. */
export function overlapMods(replays: readonly OverlapPlayer[], focus: number): ReplayMod[] {
  const eligibility = overlapEligibility(replays);
  const shared = eligibility.ok ? eligibility.mods : [];
  return replayMods(replays[focus]).filter((m) => !VISUAL.has(m.acronym) || shared.includes(m.acronym));
}

/** Every player's judgements over the shared playfield, filtered by `shown`
 *  and tinted in the player's colour, in time order. */
export function overlapJudgements(
  players: readonly (readonly JudgementEvent[] | null | undefined)[],
  shown: OverlapJudgements,
): JudgementEvent[] {
  if (shown === "none") return [];
  const out: JudgementEvent[] = [];
  players.forEach((events, index) => {
    const tint = overlapTint(index);
    for (const event of events ?? [])
      if (shown === "all" || event.result === "miss") out.push({ ...event, tint });
  });
  return out.sort((a, b) => a.time - b.time);
}

/** The render request's overlay layers in Overlap: there is one cell, so each
 *  layer shows once, following the focus player; a layer switched off for
 *  that player is left out. */
export function focusLayers<T extends { tracks: number[] | null }>(layers: readonly T[], focus: number): T[] {
  return layers
    .filter((layer) => !layer.tracks || layer.tracks.includes(focus))
    .map((layer) => ({ ...layer, tracks: [focus] }));
}

/**
 * Overlap's audio rule on the per-track `audio.mute` setting (the hitsound
 * mixer's own switch): the focus player's hitsounds only, by default. A track
 * entering the overlap is set (focus heard, the others muted) and its own
 * value kept; a new focus player sets every track again; the player's own
 * toggles in between stay. Leaving the overlap restores the kept values.
 */
export class OverlapAudio {
  private saved = new Map<string, number>();
  private focusId: string | null = null;
  /** `focus`: the overlap's focus track index, or null outside the overlap.
   *  Returns whether any track's setting changed. */
  apply(tracks: readonly { id: string; settings: Record<string, number> }[], focus: number | null): boolean {
    let changed = false;
    const set = (settings: Record<string, number>, value: number) => {
      if ((settings["audio.mute"] ?? 0) !== value) changed = true;
      settings["audio.mute"] = value;
    };
    if (focus === null || !tracks[focus]) {
      for (const track of tracks) {
        const value = this.saved.get(track.id);
        if (value !== undefined) set(track.settings, value);
      }
      this.saved.clear();
      this.focusId = null;
      return changed;
    }
    const focusId = tracks[focus].id,
      refocus = focusId !== this.focusId;
    for (const track of tracks) {
      const fresh = !this.saved.has(track.id);
      if (fresh) this.saved.set(track.id, track.settings["audio.mute"] ?? 0);
      if (fresh || refocus) set(track.settings, track.id === focusId ? 0 : 1);
    }
    const present = new Set(tracks.map((track) => track.id));
    for (const id of this.saved.keys()) if (!present.has(id)) this.saved.delete(id);
    this.focusId = focusId;
    return changed;
  }
}
