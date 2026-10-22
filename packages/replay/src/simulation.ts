import { type Replay, type Counts, healthAt } from "./index";

export interface ReplayNote {
  time: number;
  endTime?: number;
  column?: number;
  rim?: boolean;
  kind?: "circle" | "hold" | "slider" | "spinner";
  x?: number;
  y?: number;
}
export type Result = keyof Counts;
export interface Judgement {
  time: number;
  note: number;
  result: Result;
  offset: number;
  x: number;
  y: number;
  combo: number;
  counts: Counts;
  accuracy: number;
}
export interface Simulation {
  events: Judgement[];
  counts: Counts;
  verified: boolean;
  differences: Partial<Record<Result, { expected: number; actual: number }>>;
  warnings: string[];
}
const empty = (): Counts => ({
  n300: 0,
  n100: 0,
  n50: 0,
  geki: 0,
  katu: 0,
  miss: 0,
});
export function accuracy(mode: number, c: Counts): number {
  if (mode === 3) {
    const total = c.geki + c.n300 + c.katu + c.n100 + c.n50 + c.miss;
    return total
      ? (300 * (c.geki + c.n300) + 200 * c.katu + 100 * c.n100 + 50 * c.n50) /
          (300 * total)
      : 1;
  }
  const total = c.n300 + c.n100 + c.miss;
  return total ? (2 * c.n300 + c.n100) / (2 * total) : 1;
}
/** Only publish verified timelines. A mismatch is diagnostic, never silently corrected to the header. */
export function simulate(
  replay: Replay,
  notes: readonly ReplayNote[],
  od: number,
  columns = 4,
): Simulation {
  if (replay.mode !== 1 && replay.mode !== 3)
    throw new Error(
      "Judgement simulation is currently verified only for native mania and taiko",
    );
  if (
    replay.mods &
    (16384 |
      32768 |
      65536 |
      131072 |
      262144 |
      524288 |
      16777216 |
      33554432 |
      67108864)
  )
    throw new Error("Key-count/conversion mods require a converted beatmap");
  const warnings: string[] = [],
    raw: Omit<Judgement, "combo" | "counts" | "accuracy">[] = [];
  let previous = 0;
  const presses: { time: number; key: number; used: boolean }[] = [],
    releases: { time: number; key: number }[] = [];
  for (const frame of replay.frames) {
    const mask = replay.mode === 3 ? Math.trunc(frame.x) : frame.keys;
    for (let key = 0; key < (replay.mode === 3 ? columns : 4); key++) {
      if (mask & (1 << key) && !(previous & (1 << key)))
        presses.push({ time: frame.time, key, used: false });
      if (!(mask & (1 << key)) && previous & (1 << key))
        releases.push({ time: frame.time, key });
    }
    previous = mask;
  }
  const windows =
    replay.mode === 3
      ? [16, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od].map(
          (value) => value * replay.rate,
        )
      : [49.5 - 3 * od, 119.5 - 8 * od].map((value) => value * replay.rate);
  const missWindow =
    replay.mode === 3 ? (188 - 3 * od) * replay.rate : windows[1];
  const results: Result[] =
    replay.mode === 3
      ? ["geki", "n300", "katu", "n100", "n50"]
      : ["n300", "n100"];
  const consumed = new Set<number>();
  notes.forEach((note, index) => {
    if (
      replay.mode === 1 &&
      (note.kind === "slider" || note.kind === "spinner")
    ) {
      warnings.push("Taiko drumroll/spinner bonus combo is not reconstructed");
      return;
    }
    const lateWindow = replay.mode === 3 ? windows[3] : missWindow;
    const candidate = presses.findIndex(
      (p, i) =>
        !p.used &&
        !consumed.has(i) &&
        p.time >= note.time - missWindow &&
        p.time <= note.time + lateWindow &&
        (replay.mode === 3
          ? p.key === note.column
          : (p.key === 1 || p.key === 3) === !!note.rim),
    );
    const press = presses[candidate];
    let offset = press ? press.time - note.time : missWindow;
    let result: Result = "miss",
      time = note.time + missWindow;
    if (press) {
      consumed.add(candidate);
      press.used = true;
      time = press.time;
      const headError =
        replay.mode === 3
          ? Math.round(Math.abs(offset) / replay.rate) * replay.rate
          : Math.abs(offset);
      result =
        results[windows.findIndex((window) => headError <= window)] ?? "miss";
      if (
        note.endTime !== undefined &&
        note.endTime > note.time &&
        replay.mode === 3
      ) {
        const endTime = note.endTime;
        const tailStart = note.endTime - windows[4];
        const release = releases.find(
          (r) =>
            r.key === press.key && r.time > press.time && r.time >= tailStart,
        );
        const firstRelease = releases.find(
          (r) => r.key === press.key && r.time > press.time,
        );
        const broken = !!firstRelease && firstRelease.time < tailStart;
        const lastPress = presses.findLast(
          (p) => p.key === press.key && p.time <= endTime + windows[3],
        );
        const heldToTail =
          release ||
          (lastPress &&
            lastPress.time >= press.time &&
            !releases.some(
              (r) =>
                r.key === press.key &&
                r.time > lastPress.time &&
                r.time < endTime + windows[3],
            ));
        const tailError = release
          ? Math.round(Math.abs(release.time - note.endTime) / replay.rate) *
            replay.rate
          : 0;
        const factors = [1.2, 1.1, 1, 1];
        const rank = windows
          .slice(0, 4)
          .findIndex(
            (window, i) =>
              headError <= window * factors[i] &&
              headError + tailError <= window * factors[i] * 2,
          );
        result =
          !heldToTail || (release && release.time > note.endTime + windows[3])
            ? "miss"
            : broken
              ? "n50"
              : rank < 0
                ? "n50"
                : results[rank];
        time = Math.min(
          release?.time ?? note.endTime,
          note.endTime + windows[3],
        );
        offset = release ? release.time - note.endTime : 0;
      }
    }
    raw.push({
      note: index,
      result,
      time,
      offset,
      x: note.x ?? note.column ?? 0,
      y: note.y ?? 0,
    });
  });
  raw.sort((a, b) => a.time - b.time || a.note - b.note);
  const counts = empty();
  let combo = 0;
  const events = raw.map((event) => {
    counts[event.result]++;
    combo = event.result === "miss" ? 0 : combo + 1;
    return {
      ...event,
      combo,
      counts: { ...counts },
      accuracy: accuracy(replay.mode, counts),
    };
  });
  const differences: Simulation["differences"] = {};
  // Taiko accuracy grades only 300/100/miss; other legacy header counters are auxiliary.
  const gradedKeys: Result[] =
    replay.mode === 1
      ? ["n300", "n100", "miss"]
      : ["geki", "n300", "katu", "n100", "n50", "miss"];
  for (const key of gradedKeys)
    if (counts[key] !== replay.counts[key])
      differences[key] = { expected: replay.counts[key], actual: counts[key] };
  return {
    events,
    counts,
    verified: !Object.keys(differences).length && !warnings.length,
    differences,
    warnings,
  };
}
export function stateAt(replay: Replay, simulation: Simulation, time: number) {
  let low = 0,
    high = simulation.events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (simulation.events[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  const event = simulation.events[low - 1];
  return {
    combo: event?.combo ?? 0,
    counts: event?.counts ?? empty(),
    accuracy: event?.accuracy ?? 1,
    health: healthAt(replay, time),
    verified: simulation.verified,
  };
}
