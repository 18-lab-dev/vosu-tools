// Short looping demo maps for skin previews, one per ruleset (mania in every
// key count from 1K to 10K, generated in ./mania). Each `.osu` file holds one period; `demoLoop` repeats it three times
// and returns the middle copy's window, so a renderer that draws absolute
// beatmap times shows the same picture at both ends of the window.

import { parseOsu, type Beatmap, type Ruleset } from "@vosu-tools/osu-parse";
import osuText from "../maps/osu.osu?raw";
import taikoText from "../maps/taiko.osu?raw";
import catchText from "../maps/catch.osu?raw";
import { MANIA_KEYS, MANIA_PERIOD, maniaOsu, maniaStillNotes } from "./mania";

export { MANIA_KEYS } from "./mania";
export type DemoId = "osu" | "taiko" | "fruits" | `mania-${number}k`;

export interface Demo {
  id: DemoId;
  ruleset: Ruleset;
  /** Mania key count. */
  keys?: number;
  /** Loop length in ms; the file's objects lie in [0, period). */
  period: number;
  /** The `.osu` text of one period. */
  osu: string;
}

export const demos: readonly Demo[] = [
  { id: "osu", ruleset: 0, period: 10000, osu: osuText },
  { id: "taiko", ruleset: 1, period: 10000, osu: taikoText },
  // Catch objects lie in [750, 9000]: nothing is on screen at the loop seam,
  // so the catcher, plate and randomised droplet/banana offsets never jump.
  { id: "fruits", ruleset: 2, period: 10000, osu: catchText },
  ...MANIA_KEYS.map((keys): Demo => ({
    id: `mania-${keys}k`,
    ruleset: 3,
    keys,
    period: MANIA_PERIOD,
    osu: maniaOsu(keys),
  })),
];

/** The mania demo for a key count, if there is one (1K–10K). */
export const maniaDemo = (keys: number): DemoId | undefined =>
  (MANIA_KEYS as readonly number[]).includes(keys)
    ? `mania-${keys}k`
    : undefined;

export function demo(id: DemoId): Demo {
  const found = demos.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown demo map ${id}`);
  return found;
}

const shift = (value: string, by: number) => String(Number(value) + by);

/**
 * Repeats the timing points and hit objects of `text` `copies` times, each
 * `period` ms later (spinner/hold end times included).
 */
export function repeatOsu(
  text: string,
  period: number,
  copies: number,
): string {
  const out: string[] = [];
  let section = "",
    block: string[] = [];
  const flush = () => {
    if (section === "TimingPoints" || section === "HitObjects")
      for (let copy = 0; copy < copies; copy++)
        for (const line of block) out.push(shiftLine(line, copy * period));
    else out.push(...block);
    block = [];
  };
  const shiftLine = (line: string, by: number) => {
    if (!by || !line.trim() || line.trim().startsWith("//")) return line;
    const fields = line.split(",");
    if (section === "TimingPoints") {
      fields[0] = shift(fields[0], by);
      return fields.join(",");
    }
    fields[2] = shift(fields[2], by);
    const type = Number(fields[3]);
    if (type & 8) fields[5] = shift(fields[5], by);
    if (type & 128) {
      const [end, ...rest] = fields[5].split(":");
      fields[5] = [shift(end, by), ...rest].join(":");
    }
    return fields.join(",");
  };
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (header) {
      flush();
      section = header[1];
      out.push(raw);
      continue;
    }
    // Blank lines between sections stay outside the repeated block.
    if (!raw.trim() && (section === "TimingPoints" || section === "HitObjects"))
      continue;
    block.push(raw);
  }
  flush();
  return out.join("\r\n") + "\r\n";
}

export interface DemoLoop {
  demo: Demo;
  beatmap: Beatmap;
  /** First beatmap time of the loop window. */
  start: number;
  /** Window length; draw `start + (elapsed % length)`. */
  length: number;
}

/**
 * The demo as a beatmap with three periods and the middle period as the loop
 * window. Combo colour indices and numbers repeat per period, so colours match
 * across the seam whatever the skin's combo colour count.
 */
export function demoLoop(id: DemoId): DemoLoop {
  const d = demo(id);
  const beatmap = parseOsu(repeatOsu(d.osu, d.period, 3));
  const perPeriod = beatmap.objects.filter((o) => o.time < d.period).length;
  for (let i = perPeriod; i < beatmap.objects.length; i++) {
    const first = beatmap.objects[i % perPeriod];
    beatmap.objects[i].combo = first.combo;
    beatmap.objects[i].number = first.number;
  }
  return { demo: d, beatmap, start: d.period, length: d.period };
}

/**
 * A still mania stage of `keys` columns to draw at time 0 with no key held:
 * every column shows its key, a hold (head, body, tail) and a note.
 */
export const maniaStill = (
  keys: number,
  times?: Parameters<typeof maniaStillNotes>[1],
): Beatmap => parseOsu(maniaOsu(keys, maniaStillNotes(keys, times)));
