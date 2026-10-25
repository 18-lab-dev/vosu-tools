import {
  frameAt,
  columnKeys,
  stateAt,
  replayHealth,
  replayMods,
  replayRate,
  clientOf,
  type Replay,
  type ReplayFrame,
} from "@vosu-tools/replay";
import { csv, type Beatmap } from "@vosu-tools/osu-parse";
import type { Track } from "./studio";

const MODES = ["osu", "taiko", "fruits", "mania"] as const;

/** One key's presses: start and release times, in map milliseconds. */
interface KeyTrace {
  name: string;
  starts: number[];
  ends: number[];
}
/** Which keys a ruleset reports, and whether a frame holds each. */
function keyLayout(replay: Replay, columns: number): { names: string[]; held: (frame: ReplayFrame) => boolean[] } {
  const lazer = clientOf(replay) === "lazer";
  if (replay.mode === 3) {
    return {
      names: Array.from({ length: columns }, (_, i) => `${lazer ? "B" : "K"}${i + 1}`),
      held: (frame) => columnKeys(frame, columns),
    };
  }
  // osu!stable's key overlay: K1/K2 include their mouse bit; M1/M2 are mouse only.
  return {
    names: lazer ? ["B1", "B2", "B3", "B4"] : ["K1", "K2", "M1", "M2"],
    held: (frame) => {
      const k = frame.keys;
      return [(k & 4) !== 0, (k & 8) !== 0, (k & 1) !== 0 && (k & 4) === 0, (k & 2) !== 0 && (k & 8) === 0];
    },
  };
}
const traces = new WeakMap<Replay, KeyTrace[]>();
function keyTraces(replay: Replay, columns: number): KeyTrace[] {
  let cached = traces.get(replay);
  if (cached) return cached;
  const layout = keyLayout(replay, columns);
  cached = layout.names.map((name) => ({ name, starts: [], ends: [] }));
  let previous = layout.names.map(() => false);
  for (const frame of replay.frames) {
    const held = layout.held(frame);
    held.forEach((down, i) => {
      if (down && !previous[i]) cached![i].starts.push(frame.time);
      if (!down && previous[i]) cached![i].ends.push(frame.time);
    });
    previous = held;
  }
  traces.set(replay, cached);
  return cached;
}
/** How many of the sorted `times` are at or before `time`. */
function countUpTo(times: readonly number[], time: number): number {
  let low = 0,
    high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** vosu's `keys` at `time`: the legacy overlay buttons and every key. */
function keysAt(replay: Replay, columns: number, time: number) {
  const all = keyTraces(replay, columns).map((trace) => {
    const pressed = countUpTo(trace.starts, time),
      released = countUpTo(trace.ends, time);
    return {
      name: trace.name,
      isPressed: pressed > released,
      count: pressed,
      pressedAt: pressed ? trace.starts[pressed - 1] : null,
      releasedAt: released ? trace.ends[released - 1] : null,
    };
  });
  const legacy = (i: number) => ({ isPressed: all[i]?.isPressed ?? false, count: all[i]?.count ?? 0 });
  return { k1: legacy(0), k2: legacy(1), m1: legacy(2), m2: legacy(3), all };
}

/** BPM facts from the uninherited timing points (`common`: the longest-lasting). */
function bpmAt(map: Pick<Beatmap, "timing" | "duration">, time: number) {
  const red = map.timing.filter((point) => point.uninherited && point.beatLength > 0);
  if (!red.length) return { realtime: 0, common: 0, min: 0, max: 0 };
  const bpm = (beatLength: number) => Math.round((60000 / beatLength) * 10000) / 10000;
  const lengths = new Map<number, number>();
  red.forEach((point, i) => {
    const end = red[i + 1]?.time ?? Math.max(map.duration, point.time);
    lengths.set(point.beatLength, (lengths.get(point.beatLength) ?? 0) + Math.max(0, end - point.time));
  });
  const common = [...lengths].sort((a, b) => b[1] - a[1])[0][0];
  const current = [...red].reverse().find((point) => point.time <= time) ?? red[0];
  const all = red.map((point) => bpm(point.beatLength));
  return { realtime: bpm(current.beatLength), common: bpm(common), min: Math.min(...all), max: Math.max(...all) };
}
function kiaiAt(map: Pick<Beatmap, "timing">, time: number): boolean {
  let kiai = false;
  for (const point of map.timing) {
    if (point.time > time) break;
    kiai = (point.effects & 1) !== 0;
  }
  return kiai;
}

/** osu!stable's grade from the counts so far. */
function rankOf(mode: number, accuracy: number, counts: { n300: number; n100: number; n50: number; geki: number; katu: number; miss: number }, silver: boolean) {
  const total = counts.n300 + counts.n100 + counts.n50 + counts.miss + (mode === 3 || mode === 2 ? counts.geki + counts.katu : 0);
  if (!total) return "";
  const s = (letter: string) => (silver && (letter === "S" || letter === "SS") ? `${letter}H` : letter);
  if (accuracy >= 100) return s("SS");
  if (mode === 3 || mode === 2) {
    if (mode === 2) return accuracy > 98 ? s("S") : accuracy > 94 ? "A" : accuracy > 90 ? "B" : accuracy > 85 ? "C" : "D";
    return accuracy > 95 ? s("S") : accuracy > 90 ? "A" : accuracy > 80 ? "B" : accuracy > 70 ? "C" : "D";
  }
  const great = counts.n300 / total;
  if (great > 0.9 && counts.n50 / total < 0.01 && !counts.miss) return s("S");
  if ((great > 0.8 && !counts.miss) || great > 0.9) return "A";
  if ((great > 0.7 && !counts.miss) || great > 0.8) return "B";
  return great > 0.6 ? "C" : "D";
}

/**
 * The partial vosu v2 document an overlay page reads for this replay at map
 * `time` (the service fills in the rest of vosu's shape, the map facts it
 * rates, and pp; see `src/overlays/documents.rs`). Gameplay values come from
 * the studio's judgement simulation, also where it does not reproduce the
 * replay's recorded counts exactly (`__render.verified` false; the track note
 * says so): overlays expect numbers. Without a simulation they stay at vosu's
 * idle values.
 */
export function telemetry(
  track: Pick<Track, "replay" | "map" | "simulation"> &
    Partial<Pick<Track, "original" | "convert" | "skin" | "score">>,
  time: number,
  /** Map time of the video's first frame: the overlay clock starts there. */
  start = 0,
) {
  const { replay, map, simulation } = track;
  const state = simulation ? stateAt(replay, simulation, time) : null;
  const events = simulation ? simulation.events.filter((event) => event.time <= time) : [];
  // Hit errors come from timed hits only (not ticks, catches or spinners), in map milliseconds (as
  // vosu reports them: not divided by the clock rate), early negative, every one since the play began.
  const timed = events.filter((event) => event.timed !== false && event.result !== "miss");
  // Releases: hold tails under lazer's rules, else stable's whole-hold judgements.
  const released = (event: (typeof timed)[number]) =>
    event.object ? event.object === "tail" : !!(map.objects[event.note]?.type & 128);
  const all = timed.map((event) => event.offset);
  const press = timed.filter((event) => !released(event)).map((event) => event.offset);
  const release = timed.filter(released).map((event) => event.offset);
  const counts = state?.counts ?? null;
  const health = replayHealth(replay, simulation, time);
  const mode = { number: replay.mode, name: MODES[replay.mode] };
  const columns = Math.max(1, Math.round(map.difficulty.cs));
  const mean = all.length ? all.reduce((sum, value) => sum + value, 0) / all.length : 0;
  const ur = all.length
    ? Math.sqrt(all.reduce((sum, value) => sum + (value - mean) ** 2, 0) / all.length) * 10
    : 0;
  const mods = replayMods(replay);
  const modName = mods.map((mod) => mod.acronym).join("");
  const accuracy = state ? state.accuracy * 100 : 100;
  const original = track.original ?? map.difficulty;
  const background =
    map.events.map(csv).find((fields) => fields[0] === "0" && fields[2])?.[2]?.replace(/^"|"$/g, "") ?? "";
  const client = clientOf(replay);
  // The client's own score when the simulation reproduced it, else the curve scaled to the recorded total.
  const curve = track.score;
  const score =
    state?.score ??
    (curve && curve.times.length ? curve.scores[Math.max(0, countUpTo(curve.times, time) - 1)] : 0);
  // lazer's result counts so far (osu!/catch rules), for ticks and tails.
  const statistics = simulation?.client
    ? events.reduce<Record<string, number>>((all, event) => {
        if (event.kind) all[event.kind] = (all[event.kind] ?? 0) + 1;
        return all;
      }, {})
    : null;
  return {
    client,
    state: { number: 2, name: "play" },
    game: { paused: false },
    settings: {
      mode,
      mania: { scrollDirection: { number: 1, name: "down" } },
    },
    beatmap: {
      isKiai: kiaiAt(map, time),
      isBreak: map.breaks.some(([from, to]) => time >= from && time < to),
      isConvert: track.convert ?? false,
      time: {
        live: time,
        firstObject: map.objects[0]?.time ?? 0,
        lastObject: map.duration,
        mp3Length: map.duration,
      },
      checksum: replay.beatmapHash,
      id: Number(map.metadata.BeatmapID) || 0,
      set: Number(map.metadata.BeatmapSetID) || 0,
      mode,
      artist: map.metadata.Artist ?? "",
      artistUnicode: map.metadata.ArtistUnicode || map.metadata.Artist || "",
      title: map.metadata.Title ?? "",
      titleUnicode: map.metadata.TitleUnicode || map.metadata.Title || "",
      mapper: map.metadata.Creator ?? "",
      version: map.metadata.Version ?? "",
      source: map.metadata.Source ?? "",
      tags: map.metadata.Tags ?? "",
      stats: {
        ar: { original: original.ar, converted: map.difficulty.ar },
        cs: { original: original.cs, converted: map.difficulty.cs },
        od: { original: original.od, converted: map.difficulty.od },
        hp: { original: original.hp, converted: map.difficulty.hp },
        bpm: bpmAt(map, time),
        hitWindow: simulation?.hitWindow ?? {},
      },
    },
    play: {
      failed: false,
      playerName: replay.player,
      mode,
      score,
      accuracy,
      healthBar: { normal: health === null ? 0 : health * 100, smooth: health === null ? 0 : health * 100 },
      hits: {
        "0": counts?.miss ?? 0,
        "50": counts?.n50 ?? 0,
        "100": counts?.n100 ?? 0,
        "300": counts?.n300 ?? 0,
        geki: counts?.geki ?? 0,
        katu: counts?.katu ?? 0,
        sliderBreaks: 0,
        sliderEndHits: statistics?.slider_tail_hit ?? 0,
        smallTickHits: statistics?.small_tick_hit ?? 0,
        largeTickHits: statistics?.large_tick_hit ?? 0,
      },
      hitErrorArray: all,
      pressHitErrors: press,
      releaseHitErrors: release,
      combo: {
        current: events.at(-1)?.combo ?? 0,
        max: events.reduce((max, event) => Math.max(max, event.combo), 0),
      },
      mods: {
        checksum: modName.toLowerCase(),
        number: replay.mods,
        name: modName,
        array: mods.map((mod) => (mod.settings && Object.keys(mod.settings).length ? mod : { acronym: mod.acronym })),
        rate: replayRate(replay),
      },
      rank: {
        current: counts ? rankOf(replay.mode, accuracy, counts, mods.some((m) => m.acronym === "HD" || m.acronym === "FL")) : "",
        maxThisPlay: "",
      },
      unstableRate: ur,
    },
    keys: keysAt(replay, columns, time),
    resultsScreen: { mode },
    files: { background, audio: map.general.AudioFilename ?? "" },
    __render: {
      sequence: 0,
      verified: simulation?.verified ?? false,
      counts,
      // osu!/catch: whose rules judged the replay, and lazer's result counts so far (pp needs ticks).
      client: simulation?.client ?? client,
      statistics,
      skin: track.skin ?? "",
      wallMs: (time - start) / replay.rate,
      time,
      epochMs: Number((replay.timestamp - 621355968000000000n) / 10000n) - map.duration / replay.rate,
      files: { audio: map.general.AudioFilename, background: background || null },
    },
  };
}

/** lazer's mods for the overlay's pp rating: acronyms (Classic, custom rates) and Difficulty Adjust values. */
export function ratingMods(track: Pick<Track, "replay">) {
  if (!track.replay.lazer) return {};
  const mods = replayMods(track.replay),
    da = mods.find((m) => m.acronym === "DA")?.settings ?? {};
  const value = (key: string) => (typeof da[key] === "number" ? da[key] : undefined);
  return {
    acronyms: mods.map((m) => m.acronym).join("") || "NM",
    overrides: {
      ar: value("approach_rate"),
      cs: value("circle_size"),
      od: value("overall_difficulty"),
      hp: value("drain_rate"),
    },
  };
}
