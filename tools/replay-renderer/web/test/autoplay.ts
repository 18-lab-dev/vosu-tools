#!/usr/bin/env bun
/**
 * Autoplay-style osu! replays with a deliberate, per-player aim error: the
 * fixtures for Overlap. No real osu! replays of one map by several players
 * exist on the test machines, so the overlap tests and the evidence renders
 * use these instead: every object is hit (or missed) by a cursor that follows
 * the map like autoplay, moved by a constant offset, a slow wobble and a
 * timing error. Real players' aim is therefore not what these show.
 *
 *   bun test/autoplay.ts <map.osu> <out dir> <name:dx:dy:lateMs[:wobble]>...
 *
 * writes `<out dir>/<name>.osr` per player (osu!stable format; needs `xz`),
 * with header counts, max combo and score taken from the renderer's own
 * judgement simulation, so the HUD counters verify.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseOsu, type Beatmap, type HitObject } from "@vosu-tools/osu-parse";
import { judgeReplay, parseReplay, playableMap, type Replay, type ReplayFrame } from "@vosu-tools/replay";

/** One player's aim: a constant offset (osu! pixels), a lateness (ms) and a
 *  circular wobble of `wobble` pixels with a 1.7 s period. */
export interface Aim {
  player: string;
  dx: number;
  dy: number;
  lateMs: number;
  wobble?: number;
}

/** osu! pixels per stack step for circle size `cs` (`OsuHitObject.StackOffset`). */
const stackStep = (cs: number) => ((1 - (0.7 * (cs - 5)) / 5) / 2) * -6.4;

/** A slider's ball at `time`: along its path, back and forth over its spans. */
function ballAt(o: HitObject, time: number, offset: number) {
  const spans = o.repeats || 1,
    progress = Math.min(spans, Math.max(0, (time - o.time) / Math.max(1, o.span)));
  let p = progress % 1;
  if (Math.floor(progress) % 2 === 1) p = 1 - p;
  if (progress >= spans) p = spans % 2 === 1 ? 1 : 0;
  const path = o.path.length ? o.path : [{ x: o.x, y: o.y }];
  const lengths = [0];
  for (let i = 1; i < path.length; i++)
    lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const target = p * lengths[lengths.length - 1];
  let i = 1;
  while (i < path.length - 1 && lengths[i] < target) i++;
  const a = path[i - 1] ?? path[0],
    b = path[i] ?? a,
    span = lengths[i] - lengths[i - 1] || 1,
    f = Math.min(1, Math.max(0, (target - lengths[i - 1]) / span));
  return { x: a.x + (b.x - a.x) * f + offset, y: a.y + (b.y - a.y) * f + offset };
}

/**
 * Replay frames for `map` (playable: mods applied, stacked) played with `aim`:
 * K1/K2 alternate, circles held 50 ms, sliders followed and held to their
 * end, spinners spun at 8 turns a second. Frames every 1000/60 ms plus every
 * press and release, in whole milliseconds.
 */
export function autoplayFrames(map: Beatmap, aim: Aim): ReplayFrame[] {
  const step = stackStep(map.difficulty.cs);
  const wobble = (t: number) => {
    const amount = aim.wobble ?? 0,
      angle = (t / 1700) * Math.PI * 2;
    return { x: aim.dx + Math.cos(angle) * amount, y: aim.dy + Math.sin(angle) * amount };
  };
  // Where the cursor is (before the aim error) at each moment an object needs it.
  const spans = map.objects.map((o, index) => {
    const offset = o.stack * step,
      start = Math.round(o.time + aim.lateMs),
      held = o.type & 2 || o.type & 8;
    const end = held ? Math.max(start + 1, Math.round(o.endTime + aim.lateMs)) : start;
    const at = (t: number) => {
      if (o.type & 8) {
        const angle = ((t - start) / 125) * Math.PI * 2;
        return { x: 256 + Math.cos(angle) * 60, y: 192 + Math.sin(angle) * 60 };
      }
      if (o.type & 2) return ballAt(o, t - aim.lateMs, offset);
      return { x: o.x + offset, y: o.y + offset };
    };
    return { start, end, release: held ? end : start + 50, key: index % 2 ? 10 : 5, at };
  });
  // Releases come before the next press, so alternating keys never overlap.
  spans.forEach((span, i) => {
    const next = spans[i + 1];
    if (next && span.release >= next.start) span.release = Math.max(span.start, next.start - 1);
  });
  const first = spans[0]?.start ?? 0,
    last = spans.length ? spans[spans.length - 1].release : 0;
  const times = new Set<number>();
  for (let t = first - 1000; t <= last + 1000; t += 1000 / 60) times.add(Math.round(t));
  for (const span of spans) for (const t of [span.start, span.release, span.release + 1]) times.add(t);
  let index = 0;
  return [...times]
    .sort((a, b) => a - b)
    .map((time) => {
      while (index + 1 < spans.length && spans[index + 1].start <= time) index++;
      const span = spans[index],
        next = spans[index + 1];
      let point: { x: number; y: number };
      if (!span || time < span.start) point = (span ?? next)?.at(time) ?? { x: 256, y: 192 };
      else if (time <= span.end) point = span.at(time);
      else if (next) {
        // Between objects: straight towards the next one, arriving on time.
        const from = span.at(span.end),
          to = next.at(next.start),
          f = Math.min(1, (time - span.end) / Math.max(1, next.start - span.end));
        point = { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
      } else point = span.at(span.end);
      const error = wobble(time);
      const pressed = span && time >= span.start && time < span.release;
      return {
        time,
        x: Math.round((point.x + error.x) * 100) / 100,
        y: Math.round((point.y + error.y) * 100) / 100,
        keys: pressed ? span.key : 0,
      };
    });
}

const uleb = (n: number) => {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
};
const text = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return [0x0b, ...uleb(bytes.length), ...bytes];
};

/** An osu!stable `.osr`: header fields from `replay`, frames LZMA-compressed by `compress`. */
export function encodeReplay(
  replay: Pick<Replay, "beatmapHash" | "player" | "counts" | "score" | "maxCombo" | "perfect" | "frames" | "seed">,
  compress: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  let time = 0;
  const parts = ["0|256|-500|0", "-1|256|-500|0"];
  for (const frame of replay.frames) {
    parts.push(`${frame.time - time}|${frame.x}|${frame.y}|${frame.keys}`);
    time = frame.time;
  }
  parts.push(`-12345|0|0|${replay.seed ?? 0}`);
  const data = compress(new TextEncoder().encode(parts.join(",") + ","));
  const out: number[] = [];
  const int = (n: number, size: number) => {
    let v = BigInt.asUintN(size * 8, BigInt(n));
    for (let i = 0; i < size; i++) {
      out.push(Number(v & 0xffn));
      v >>= 8n;
    }
  };
  out.push(0);
  int(20240212, 4);
  out.push(...text(replay.beatmapHash), ...text(replay.player));
  out.push(...text(createHash("md5").update(replay.player + replay.beatmapHash).digest("hex")));
  const c = replay.counts;
  for (const n of [c.n300, c.n100, c.n50, c.geki, c.katu, c.miss]) int(n, 2);
  int(replay.score, 4);
  int(replay.maxCombo, 2);
  out.push(replay.perfect ? 1 : 0);
  int(0, 4);
  out.push(...text(""));
  int(638650000000000000, 8);
  int(data.length, 4);
  out.push(...data);
  int(0, 8);
  return new Uint8Array(out);
}

/** `xz --format=lzma`: the LZMA "alone" stream `.osr` files use. xz streams
 *  from a pipe, so it writes an unknown size; the size is filled in. */
function xz(data: Uint8Array): Uint8Array {
  const run = Bun.spawnSync(["xz", "--format=lzma", "-c"], { stdin: data });
  if (!run.success) throw new Error(`xz failed: ${run.stderr.toString()}`);
  const out = new Uint8Array(run.stdout);
  new DataView(out.buffer, out.byteOffset).setBigUint64(5, BigInt(data.length), true);
  return out;
}

/** Writes a player's replay of `osu` (the `.osu` file's bytes), with header
 *  counts from the renderer's own simulation of it. */
export async function writeAutoplay(osu: Uint8Array, aim: Aim, compress = xz): Promise<Uint8Array> {
  const raw = parseOsu(new TextDecoder().decode(osu));
  const hash = createHash("md5").update(osu).digest("hex");
  const map = playableMap({ mode: 0, mods: 0, lazer: null }, raw);
  const header = {
    beatmapHash: hash,
    player: aim.player,
    counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 },
    score: 0,
    maxCombo: 0,
    perfect: false,
    frames: autoplayFrames(map, aim),
    seed: 0,
  };
  // Judge what the renderer will read, then record its results in the header.
  const parsed = await parseReplay(encodeReplay(header, compress));
  const { simulation } = judgeReplay(parsed, raw);
  const last = simulation.events.at(-1);
  const counts = { ...simulation.counts };
  const maxCombo = Math.max(0, ...simulation.events.map((event) => event.combo ?? 0));
  return encodeReplay(
    {
      ...header,
      counts,
      maxCombo,
      score: last?.score ?? 0,
      perfect: counts.miss === 0 && maxCombo > 0,
    },
    compress,
  );
}

if (import.meta.main) {
  const [osuPath, outDir, ...players] = Bun.argv.slice(2);
  if (!osuPath || !outDir || !players.length) {
    console.error("usage: bun test/autoplay.ts <map.osu> <out dir> <name:dx:dy:lateMs[:wobble]>...");
    process.exit(2);
  }
  const osu = new Uint8Array(readFileSync(osuPath));
  mkdirSync(outDir, { recursive: true });
  for (const spec of players) {
    const [player, dx, dy, lateMs, wobble] = spec.split(":");
    const bytes = await writeAutoplay(osu, {
      player,
      dx: Number(dx),
      dy: Number(dy),
      lateMs: Number(lateMs),
      wobble: Number(wobble ?? 0),
    });
    const replay = await parseReplay(bytes);
    const { simulation } = judgeReplay(replay, parseOsu(new TextDecoder().decode(osu)));
    writeFileSync(join(outDir, `${player}.osr`), bytes);
    console.log(player, JSON.stringify(replay.counts), `max combo ${replay.maxCombo}`, `verified ${simulation.verified}`);
  }
  // The LZMA decoder keeps the event loop alive.
  process.exit(0);
}
