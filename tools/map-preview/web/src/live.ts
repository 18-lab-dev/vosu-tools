/**
 * Following the game through vosu's selected-field v2 subscription.
 *
 * The protocol sends `[0, revision, [[index, value], ...]]` once, then
 * `[1, revision, [[index, value], ...], [removedIndex, ...]]` updates, or
 * `[2, code, message]` on errors. Pointers that a host does not know are
 * simply absent, so the fields added in vosu 1.2 (play source, clock rate and
 * running state, visual settings) are requested from every host.
 */
export interface ModSelection {
  acronym: string;
  settings?: Record<string, unknown>;
}
export interface GameState {
  client: "stable" | "lazer" | null;
  /** v2 state number: 2 is gameplay, 5 song select, 7 results. */
  state: number | null;
  checksum: string | null;
  /** Beatmap ruleset and the ruleset selected for converts. */
  beatmapMode: number | null;
  selectedMode: number | null;
  /** Absolute map milliseconds at the moment the frame arrived. */
  time: number | null;
  /** Track rate and whether it advances, when the client exposes them. */
  rate: number | null;
  running: boolean | null;
  mods: ModSelection[];
  /** null outside gameplay; "player" for the user's own gameplay; undefined when unknown. */
  source: string | null | undefined;
  mania: { scrollSpeed: number | null; scrollUp: boolean };
  visual: {
    hitLighting: boolean | null;
    beatmapColours: boolean | null;
    snakingIn: boolean | null;
  };
  skinFolder: string | null;
}

export const subscriptionPointers = [
  "/client",
  "/state/number",
  "/beatmap/checksum",
  "/beatmap/mode/number",
  "/beatmap/time",
  "/settings/mode/number",
  "/settings/mania",
  "/settings/skin/ignoreBeatmapSkins",
  "/settings/visual",
  "/play/mods/array",
  "/play/source",
  "/folders/skin",
] as const;
type Pointer = (typeof subscriptionPointers)[number];

/** Sources during which the preview stays visible: someone else is playing. */
const watching = new Set(["replay", "spectator", "watching", "autoplay"]);
/**
 * The playfield hides during the user's own gameplay so it cannot act as a
 * second-screen aid. Unknown or missing provenance during play also hides.
 */
export function hiddenForGameplay(state: GameState): boolean {
  return state.state === 2 && !watching.has(String(state.source));
}

const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const record = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export function emptyState(): GameState {
  return {
    client: null,
    state: null,
    checksum: null,
    beatmapMode: null,
    selectedMode: null,
    time: null,
    rate: null,
    running: null,
    mods: [],
    source: undefined,
    mania: { scrollSpeed: null, scrollUp: false },
    visual: { hitLighting: null, beatmapColours: null, snakingIn: null },
    skinFolder: null,
  };
}

/** Applies one pointer's value (undefined when absent or removed). */
export function applyField(
  state: GameState,
  pointer: Pointer,
  value: unknown,
): void {
  switch (pointer) {
    case "/client":
      state.client = value === "stable" || value === "lazer" ? value : null;
      break;
    case "/state/number":
      state.state = number(value);
      break;
    case "/beatmap/checksum":
      state.checksum = typeof value === "string" && value ? value : null;
      break;
    case "/beatmap/mode/number":
      state.beatmapMode = number(value);
      break;
    case "/beatmap/time": {
      const time = record(value);
      state.time = number(time.live);
      state.rate = number(time.rate);
      state.running = bool(time.running);
      break;
    }
    case "/settings/mode/number":
      state.selectedMode = number(value);
      break;
    case "/settings/mania": {
      const mania = record(value),
        legacy = number(mania.scrollSpeed),
        perBeatmap = number(mania.perBeatmapScrollSpeed);
      state.mania.scrollSpeed =
        number(mania.scrollSpeedValue) ??
        (mania.usePerBeatmapSpeedScale === true && perBeatmap
          ? perBeatmap
          : legacy && legacy > 0
            ? legacy
            : null);
      // lazer's ManiaScrollingDirection (vosu's names): 0 = up, 1 = down.
      state.mania.scrollUp = number(record(mania.scrollDirection).number) === 0;
      break;
    }
    case "/settings/skin/ignoreBeatmapSkins":
      state.visual.beatmapColours = bool(value) === null ? null : !value;
      break;
    case "/settings/visual": {
      const visual = record(value);
      state.visual.hitLighting = bool(visual.hitLighting);
      state.visual.snakingIn = bool(visual.snakingInSliders);
      const colours = bool(visual.beatmapColours);
      if (colours !== null) state.visual.beatmapColours = colours;
      break;
    }
    case "/play/mods/array":
      state.mods = Array.isArray(value)
        ? value
            .filter(
              (m): m is ModSelection =>
                !!m && typeof (m as ModSelection).acronym === "string",
            )
            .map((m) => ({ acronym: m.acronym, settings: record(m.settings) }))
        : [];
      break;
    case "/play/source":
      // Absent (older vosu) stays unknown, which hides during gameplay.
      state.source =
        typeof value === "string" ? value : value === null ? null : undefined;
      break;
    case "/folders/skin":
      state.skinFolder = typeof value === "string" ? value : null;
      break;
  }
}

/**
 * Extrapolates the client's clock between frames. With lazer, vosu reports
 * the beatmap track's own clock: its running state and actual playback rate
 * (aggregate tempo × frequency, so DT/NC/HT/DC and custom speed changes, in
 * song select too), which are used as they are. Without a reported clock
 * (stable, whose reported rate is only the selected mods' rate, or older
 * vosu) the rate is measured from how live time advances, seeded with the
 * reported one. Small disagreements between the extrapolation and a new frame
 * are slewed out, so the preview never steps backwards while playing and
 * cannot drift; larger ones (seeks) snap.
 */
export class LiveClock {
  /** Corrections smaller than this are spread over SLEW_MS instead of jumping. */
  static readonly SNAP_MS = 120;
  static readonly SLEW_MS = 200;
  /** Extrapolate at most this long without frames, then hold. */
  static readonly HOLD_MS = 1000;
  private time = 0;
  private at = 0;
  private rate = 1;
  private running = false;
  private known = false;
  private estimatedRate = 1;
  private measured = false;
  /** The furthest reported time and when it was reached (frames can arrive out of order of sampling). */
  private furthest = 0;
  private advancedAt = 0;
  /** Start of the window the rate is estimated over (frames' jitter averages out). */
  private windowTime = 0;
  private windowAt = 0;
  /** Reported minus extrapolated time at the last frame, applied over `slew` ms. */
  private correction = 0;
  private slew = LiveClock.SLEW_MS;

  update(
    time: number | null,
    rate: number | null,
    running: boolean | null,
    now: number,
  ): void {
    if (time === null) {
      this.known = false;
      this.running = false;
      return;
    }
    const predicted = this.known ? this.read(now)! : time,
      error = time - predicted,
      wasRunning = this.running;
    // A seek: backwards past jitter, or ahead of anything playback explains
    // (the extrapolation while playing, the elapsed time while held). Time
    // that stays put while the extrapolation runs on is a pause.
    const seek =
      !this.known ||
      time < this.furthest - LiveClock.SNAP_MS ||
      (wasRunning &&
        Math.abs(error) >= LiveClock.SNAP_MS &&
        time - this.furthest >= LiveClock.SNAP_MS) ||
      (!wasRunning &&
        time - this.furthest > (now - this.advancedAt) * 4 + LiveClock.SNAP_MS);
    if (seek) {
      // Playback state carries over a seek; the first frame starts held.
      this.running = running ?? (this.known && this.running);
      this.furthest = time;
      this.advancedAt = now;
      this.windowTime = time;
      this.windowAt = now;
    } else {
      if (time > this.furthest) {
        this.furthest = time;
        this.advancedAt = now;
      }
      // Without a reported state, no progress for a while means paused.
      this.running = running ?? now - this.advancedAt < 300;
      // Estimate the rate over at least half a second of steady playback.
      const span = now - this.windowAt;
      if (!this.running || !wasRunning) {
        this.windowTime = time;
        this.windowAt = now;
      } else if (span >= 500) {
        const observed = (time - this.windowTime) / span;
        if (observed > 0.2 && observed < 4) {
          this.estimatedRate = observed;
          this.measured = true;
        }
        this.windowTime = time;
        this.windowAt = now;
      }
    }
    this.rate =
      running !== null && rate !== null
        ? rate
        : this.measured
          ? this.estimatedRate
          : (rate ?? this.estimatedRate);
    if (
      this.known &&
      wasRunning &&
      this.running &&
      Math.abs(error) < LiveClock.SNAP_MS
    ) {
      this.time = predicted;
      this.correction = error;
      // Pulling back runs at no more than half the playback rate.
      this.slew = Math.max(LiveClock.SLEW_MS, (-2 * error) / this.rate);
    } else {
      this.time = time;
      this.correction = 0;
    }
    this.at = now;
    this.known = true;
  }

  /** Map milliseconds at `now`; null before the first frame. */
  read(now: number): number | null {
    if (!this.known) return null;
    const elapsed = Math.max(0, now - this.at),
      // Without frames for a while, hold position rather than drift.
      played = this.running ? Math.min(elapsed, LiveClock.HOLD_MS) : 0,
      slewed = this.correction * Math.min(1, elapsed / this.slew);
    return this.time + played * this.rate + slewed;
  }
}

export type LiveStatus = "connecting" | "waiting" | "live" | "lost";
type Subscribe = (
  fields: unknown,
  onFrame: (frame: unknown) => void,
  onStatus?: (state: "connecting" | "open" | "closed") => void,
) => () => void;
/**
 * Follows the game through the bridge's `/websocket/v2/subscribe` helper,
 * which reconnects after vosu restarts (bridges from vosu 1.2 on). `onState`
 * receives the merged state after every frame. "waiting" means connected but
 * vosu has no game state to report yet. Returns the unsubscribe function.
 */
export function followGame(
  subscribe: Subscribe,
  onState: (state: GameState) => void,
  onStatus: (status: LiveStatus) => void,
): () => void {
  let state = emptyState();
  onStatus("connecting");
  return subscribe(
    subscriptionPointers,
    (frame) => {
      if (!Array.isArray(frame) || (frame[0] !== 0 && frame[0] !== 1)) return;
      onStatus("live");
      // Every (re)connection starts with a complete initial frame.
      if (frame[0] === 0) state = emptyState();
      const changed = new Set<number>();
      for (const [index, value] of (frame[2] ?? []) as [number, unknown][])
        if (subscriptionPointers[index]) {
          applyField(state, subscriptionPointers[index], value);
          changed.add(index);
        }
      for (const index of (frame[3] ?? []) as number[])
        if (subscriptionPointers[index])
          applyField(state, subscriptionPointers[index], undefined);
      // Fields missing from the initial frame are absent on this host.
      if (frame[0] === 0)
        subscriptionPointers.forEach((pointer, index) => {
          if (!changed.has(index)) applyField(state, pointer, undefined);
        });
      onState(state);
    },
    (connection) =>
      onStatus(
        connection === "open"
          ? "waiting"
          : connection === "closed"
            ? "lost"
            : "connecting",
      ),
  );
}
