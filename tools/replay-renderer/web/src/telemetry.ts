import { frameAt, columnKeys, stateAt, healthAt } from "@vosu-tools/replay";
import { csv } from "@vosu-tools/osu-parse";
import type { Track } from "./studio";
/** Synthetic subset of vosu v2. Unknown/unverified scoring fields stay null. */
export function telemetry(
  track: Pick<Track, "replay" | "map" | "simulation">,
  time: number,
  /** Map time of the video's first frame: the overlay clock starts there. */
  start = 0,
) {
  const { replay, map, simulation } = track,
    frame = frameAt(replay, time),
    verified = simulation?.verified ?? false;
  const state = simulation ? stateAt(replay, simulation, time) : null;
  const events = verified
    ? simulation!.events.filter((event) => event.time <= time)
    : [];
  const press = events
    .filter(
      (event) =>
        event.result !== "miss" && !(map.objects[event.note].type & 128),
    )
    .map((event) => event.offset / replay.rate);
  const release = events
    .filter(
      (event) =>
        event.result !== "miss" && !!(map.objects[event.note].type & 128),
    )
    .map((event) => event.offset / replay.rate);
  const all = events
    .filter((event) => event.result !== "miss")
    .map((event) => event.offset / replay.rate);
  const counts = verified ? state!.counts : null,
    health = healthAt(replay, time);
  const mode = {
    number: replay.mode,
    name: ["osu", "taiko", "fruits", "mania"][replay.mode],
  };
  const keys =
    replay.mode === 3
      ? columnKeys(frame, Math.round(map.difficulty.cs))
      : Array.from({ length: 4 }, (_, i) => !!(frame.keys & (1 << i)));
  const mean = all.length
    ? all.reduce((sum, value) => sum + value, 0) / all.length
    : 0;
  const ur = all.length
    ? Math.sqrt(
        all.reduce((sum, value) => sum + (value - mean) ** 2, 0) / all.length,
      ) * 10
    : 0;
  return {
    state: { number: 2, name: "Playing" },
    beatmap: {
      checksum: replay.beatmapHash,
      mode,
      time: {
        live: time,
        firstObject: map.objects[0]?.time ?? 0,
        lastObject: map.duration,
      },
      artist: map.metadata.Artist,
      title: map.metadata.Title,
      version: map.metadata.Version,
      creator: map.metadata.Creator,
      id: Number(map.metadata.BeatmapID) || 0,
      set: Number(map.metadata.BeatmapSetID) || 0,
      isBreak: map.breaks.some(([start, end]) => time >= start && time < end),
    },
    play: {
      playerName: replay.player,
      mode,
      mods: { number: replay.mods, rate: replay.rate },
      accuracy: verified ? state!.accuracy * 100 : null,
      healthBar: { normal: health, smooth: health },
      hits: counts
        ? {
            "0": counts.miss,
            "50": counts.n50,
            "100": counts.n100,
            "300": counts.n300,
            geki: counts.geki,
            katu: counts.katu,
          }
        : null,
      combo: {
        current: verified ? state!.combo : null,
        max:
          verified && simulation?.comboVerified
            ? events.reduce((max, event) => Math.max(max, event.combo), 0)
            : null,
      },
      hitErrorArray: all,
      pressHitErrors: press,
      releaseHitErrors: release,
      unstableRate: verified ? ur : null,
      pp: { current: null },
    },
    keys: keys.map((isPressed, index) => ({
      name: String(index + 1),
      isPressed,
    })),
    __render: {
      sequence: 0,
      verified,
      counts,
      wallMs: (time - start) / replay.rate,
      time,
      epochMs:
        Number((replay.timestamp - 621355968000000000n) / 10000n) -
        map.duration / replay.rate,
      files: {
        audio: map.general.AudioFilename,
        background:
          map.events
            .map(csv)
            .find((fields) => fields[0] === "0" && fields[2])?.[2] ?? null,
      },
    },
  };
}
