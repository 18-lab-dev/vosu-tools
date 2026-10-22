import codec from "lzma/src/lzma-d.js";

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
}
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
  if (compressed.length < 13)
    throw new Error("Replay has no LZMA frame stream");
  if (compressed.length > 16 * 1024 * 1024)
    throw new Error("Compressed replay exceeds 16 MiB");
  const sizeView = new DataView(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength,
  );
  if (sizeView.getUint32(1, true) > 64 * 1024 * 1024)
    throw new Error("Replay LZMA dictionary exceeds 64 MiB");
  const decodedSize = sizeView.getBigUint64(5, true);
  if (decodedSize === 0xffffffffffffffffn)
    throw new Error("Unbounded LZMA streams are not accepted");
  if (decodedSize > 128n * 1024n * 1024n)
    throw new Error("Replay frame stream exceeds 128 MiB");
  const text = await new Promise<string>((resolve, reject) =>
    codec.LZMA.decompress(Array.from(compressed), (result, error) => {
      if (error) reject(error);
      else if (typeof result === "string") resolve(result);
      else reject(new Error("Replay stream is not UTF-8 text"));
    }),
  );
  const onlineId = bytes.length - r.offset >= 8 ? r.i64() : 0n;
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
    rate: mods & (64 | 512) ? 1.5 : mods & 256 ? 0.75 : 1,
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
