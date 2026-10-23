import codec from "lzma/src/lzma-d.js";
import { replayRate } from "./mods";

export type Mode = 0 | 1 | 2 | 3;
export interface Counts {
  n300: number;
  n100: number;
  n50: number;
  geki: number;
  katu: number;
  miss: number;
}
export interface ReplayFrame {
  time: number;
  x: number;
  y: number;
  keys: number;
}
export interface Replay {
  mode: Mode;
  version: number;
  beatmapHash: string;
  player: string;
  replayHash: string;
  counts: Counts;
  score: number;
  maxCombo: number;
  perfect: boolean;
  mods: number;
  life: { time: number; health: number }[];
  timestamp: bigint;
  onlineId: bigint;
  frames: ReplayFrame[];
  seed: number | null;
  rate: number;
  /** The score lazer stored after the frames (lazer-written replays only). */
  lazer: LazerScoreInfo | null;
}
/** `LegacyReplaySoloScoreInfo`: lazer's own statistics, as set during play. */
export interface LazerScoreInfo {
  mods: { acronym: string; settings?: Record<string, unknown> }[];
  /** lazer `HitResult` names (`great`, `large_tick_hit`, ...) to counts. */
  statistics: Record<string, number>;
  maximumStatistics: Record<string, number>;
  clientVersion: string;
  totalScoreWithoutMods: number | null;
}
/** First replay version written by lazer (`LegacyScoreEncoder.FIRST_LAZER_VERSION`). */
export const FIRST_LAZER_VERSION = 30000000;
class Reader {
  offset = 0;
  view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  take(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.length
    )
      throw new Error("Truncated replay");
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u16(): number {
    const p = this.offset;
    this.take(2);
    return this.view.getUint16(p, true);
  }
  i32(): number {
    const p = this.offset;
    this.take(4);
    return this.view.getInt32(p, true);
  }
  i64(): bigint {
    const p = this.offset;
    this.take(8);
    return this.view.getBigInt64(p, true);
  }
  string(): string {
    const marker = this.u8();
    if (marker === 0) return "";
    if (marker !== 11) throw new Error("Invalid osu string marker");
    let length = 0,
      shift = 0,
      part: number;
    do {
      if (shift > 28) throw new Error("Oversized osu string");
      part = this.u8();
      length += (part & 127) * 2 ** shift;
      shift += 7;
    } while (part & 128);
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
  }
}
export function parseFrames(text: string): {
  frames: ReplayFrame[];
  seed: number | null;
} {
  const frames: ReplayFrame[] = [];
  let time = 0,
    seed: number | null = null;
  for (const entry of text.split(",")) {
    if (!entry.trim()) continue;
    const fields = entry.split("|");
    if (fields.length !== 4) throw new Error("Invalid replay frame");
    const [delta, x, y, keys] = fields.map(Number);
    if (![delta, x, y, keys].every(Number.isFinite) || !Number.isInteger(keys))
      throw new Error("Non-numeric replay frame");
    if (delta === -12345) {
      seed = keys;
      continue;
    }
    time += delta;
    // Stable includes a negative initial positioning frame. Keep it for cursor interpolation.
    if (frames.length && time < frames[frames.length - 1].time && time > 0)
      throw new Error("Replay frames are not chronological");
    frames.push({ time, x, y, keys });
  }
  frames.sort((a, b) => a.time - b.time);
  return { frames, seed };
}
export async function parseReplay(bytes: Uint8Array): Promise<Replay> {
  const r = new Reader(bytes),
    mode = r.u8();
  if (mode > 3) throw new Error("Unknown replay ruleset");
  const version = r.i32(),
    beatmapHash = r.string(),
    player = r.string(),
    replayHash = r.string();
  const counts = {
    n300: r.u16(),
    n100: r.u16(),
    n50: r.u16(),
    geki: r.u16(),
    katu: r.u16(),
    miss: r.u16(),
  };
  const score = r.i32(),
    maxCombo = r.u16(),
    perfect = r.u8() !== 0,
    mods = r.i32();
  const life = r
    .string()
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [time, health] = entry.split("|").map(Number);
      if (
        !Number.isFinite(time) ||
        !Number.isFinite(health) ||
        health < 0 ||
        health > 1
      )
        throw new Error("Invalid replay health graph");
      return { time, health };
    });
  const timestamp = r.i64(),
    compressed = r.take(r.i32());
  const text = await decompress(compressed, "Replay frame stream");
  const onlineId = bytes.length - r.offset >= 8 ? r.i64() : 0n;
  // lazer appends its own score (statistics, mods with settings) as LZMA JSON.
  // It only feeds verification: an unreadable block leaves the replay playable.
  let lazer: LazerScoreInfo | null = null;
  if (version >= 30000001 && bytes.length - r.offset >= 4) {
    try {
      const info = r.take(r.i32());
      if (info.length) lazer = lazerScoreInfo(await decompress(info, "Score info"));
    } catch {
      lazer = null;
    }
  }
  return {
    mode: mode as Mode,
    version,
    beatmapHash,
    player,
    replayHash,
    counts,
    score,
    maxCombo,
    perfect,
    mods,
    life,
    timestamp,
    onlineId,
    ...parseFrames(text),
    // lazer's custom speeds (e.g. DT 1.25×) win over the legacy bits.
    rate: replayRate({ mods, lazer }),
    lazer,
  };
}
async function decompress(data: Uint8Array, what: string): Promise<string> {
  if (data.length < 13) throw new Error(`${what} has no LZMA stream`);
  if (data.length > 16 * 1024 * 1024)
    throw new Error(`Compressed ${what.toLowerCase()} exceeds 16 MiB`);
  const sizeView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (sizeView.getUint32(1, true) > 64 * 1024 * 1024)
    throw new Error(`${what} LZMA dictionary exceeds 64 MiB`);
  const decodedSize = sizeView.getBigUint64(5, true);
  if (decodedSize === 0xffffffffffffffffn)
    throw new Error("Unbounded LZMA streams are not accepted");
  if (decodedSize > 128n * 1024n * 1024n)
    throw new Error(`${what} exceeds 128 MiB`);
  return new Promise<string>((resolve, reject) =>
    codec.LZMA.decompress(Array.from(data), (result, error) => {
      if (error) reject(error);
      else if (typeof result === "string") resolve(result);
      else reject(new Error(`${what} is not UTF-8 text`));
    }),
  );
}
const counter = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (value && typeof value === "object")
    for (const [key, n] of Object.entries(value))
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) out[key] = n;
  return out;
};
function lazerMod(m: unknown): LazerScoreInfo["mods"][number] | null {
  if (!m || typeof m !== "object" || !("acronym" in m)) return null;
  if (typeof m.acronym !== "string") return null;
  const settings =
    "settings" in m && m.settings && typeof m.settings === "object"
      ? Object.fromEntries(Object.entries(m.settings))
      : undefined;
  return { acronym: m.acronym.toUpperCase(), ...(settings ? { settings } : {}) };
}
function lazerScoreInfo(text: string): LazerScoreInfo {
  const json: unknown = JSON.parse(text);
  if (!json || typeof json !== "object") throw new Error("Score info is not an object");
  const field = (key: string): unknown => (key in json ? Reflect.get(json, key) : undefined);
  const mods = field("mods"),
    total = field("total_score_without_mods"),
    client = field("client_version");
  return {
    mods: (Array.isArray(mods) ? mods : []).flatMap((m) => lazerMod(m) ?? []),
    statistics: counter(field("statistics")),
    maximumStatistics: counter(field("maximum_statistics")),
    clientVersion: typeof client === "string" ? client : "",
    totalScoreWithoutMods:
      typeof total === "number" && Number.isSafeInteger(total) ? total : null,
  };
}
/** Absolute map time, not wall time. Binary search permits both deterministic seeking and export. */
export function frameAt(
  replay: Pick<Replay, "frames" | "mode">,
  time: number,
): ReplayFrame {
  const frames = replay.frames;
  if (!frames.length) return { time, x: 256, y: 192, keys: 0 };
  let low = 0,
    high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return { ...frames[0], time, keys: 0 };
  const a = frames[low - 1],
    b = frames[low];
  if (!b || replay.mode === 3 || a.time === b.time) return { ...a, time };
  const t = (time - a.time) / (b.time - a.time);
  return {
    time,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    keys: a.keys,
  };
}
/** Mania stores its column bitmask in x, not the standard keys field. */
export function columnKeys(frame: ReplayFrame, columns: number): boolean[] {
  return Array.from(
    { length: columns },
    (_, lane) => ((Math.trunc(frame.x) >>> lane) & 1) !== 0,
  );
}
export function healthAt(
  replay: Pick<Replay, "life">,
  time: number,
): number | null {
  const points = replay.life;
  if (!points.length) return null;
  let low = 0,
    high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  const a = points[Math.max(0, low - 1)],
    b = points[low];
  return b && b.time !== a.time
    ? a.health +
        (b.health - a.health) * Math.max(0, (time - a.time) / (b.time - a.time))
    : a.health;
}
export * from "./simulation";
export * from "./scoring";
export * from "./osu";
export * from "./catch";
export * from "./mods";
export * from "./taiko";
export * from "./mania";
export * from "./health";
export * from "./judge";
