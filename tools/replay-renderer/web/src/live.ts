import type { Rect } from "./layout";
import type { OverlayLayer } from "./overlay-layout";
import type { Track } from "./studio";
import { ratingMods, telemetry } from "./telemetry";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
/** Where one overlay page shows: its layer and track (by index) and its box in output pixels. */
export interface Placement {
  overlay: number;
  track: number;
  box: Rect;
}
/** States go out at most this often while the clock moves. */
const STATE_INTERVAL = 33;
/** A still preview repeats its state this often (pages that reconnected catch up). */
const IDLE_INTERVAL = 1000;
/**
 * Pages load one after another, this long apart after each `load`: Chrome
 * opens WebSockets to one address one handshake at a time, and every page
 * opening its sockets at once can keep some connecting for seconds, longer
 * than tosu's command helper retries `getSettings`.
 */
const LOAD_GAP = 120;
/** A page that never fires `load` holds the queue at most this long. */
const LOAD_LIMIT = 3000;

/**
 * The overlays drawn live over the preview: the same pages a render captures,
 * served by the renderer's private overlay server with the replay's state for
 * the time on screen (see `src/preview.rs`). Each page is an iframe at its
 * box, scaled like the export composites it; pages run on real time.
 */
export class LivePages {
  readonly root = document.createElement("div");
  private frames = new Map<string, HTMLIFrameElement>();
  private session: string | null = null;
  private key = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private sending = false;
  private sent = { at: 0, time: Number.NaN, playing: false };
  private placements: Placement[] = [];
  private zoom = 1;
  private layers: OverlayLayer[] = [];
  /** Overlays (by layer index) whose pages created a WebGPU canvas. */
  readonly webgpu = new Set<number>();
  /** Called when `webgpu` changes. */
  onWebGpu: () => void = () => {};
  constructor(
    private fetcher: Fetcher,
    private report: (error: unknown) => void,
  ) {
    this.root.className = "live-pages";
    this.root.setAttribute("aria-hidden", "true");
    // Preview pages report their first WebGPU canvas (see the overlay server).
    addEventListener("message", (event) => {
      if (!(event.data as { vosuWebGpu?: unknown } | null)?.vosuWebGpu) return;
      for (const frame of this.frames.values()) {
        if (frame.contentWindow !== event.source) continue;
        const overlay = Number(frame.dataset.overlay);
        if (this.webgpu.has(overlay)) return;
        this.webgpu.add(overlay);
        this.onWebGpu();
        return;
      }
    });
  }
  /**
   * Starts a preview for `tracks` and `layers` (null: no valid overlay setup)
   * when either changed since the last one; quick successive edits start one.
   */
  update(tracks: readonly Track[], layers: OverlayLayer[] | null, start: number) {
    const key = JSON.stringify({
      tracks: tracks.map((t) => [t.id, t.skin ?? "", t.replay.mods]),
      layers: layers?.map(({ folder, width, height, settings, tracks }) => ({ folder, width, height, settings, tracks })),
    });
    if (key === this.key) return;
    this.key = key;
    this.layers = layers ?? [];
    clearTimeout(this.timer);
    this.end();
    if (!layers?.length || !tracks.length) return;
    this.timer = setTimeout(() => void this.begin([...tracks], layers, start).catch(this.report), 400);
  }
  private end() {
    this.generation++;
    if (this.session) {
      const ended = this.session;
      void this.fetcher(`v1/preview/${ended}`, { method: "DELETE" }).catch(() => undefined);
    }
    this.session = null;
    this.frames.clear();
    this.root.replaceChildren();
    if (this.webgpu.size) {
      this.webgpu.clear();
      this.onWebGpu();
    }
  }
  private async begin(tracks: Track[], layers: OverlayLayer[], start: number) {
    const generation = this.generation;
    const response = await this.fetcher("v1/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        overlays: layers,
        tracks: tracks.map((track) => ({
          hash: track.replay.beatmapHash,
          mods: track.replay.mods,
          rate: track.replay.rate,
          skin: track.skin ?? "",
          ...ratingMods(track),
          initial: telemetry(track, start, start),
        })),
      }),
    });
    const { session, pages } = (await response.json()) as {
      session: string;
      pages: { track: number; overlay: number; url: string }[];
    };
    if (generation !== this.generation) {
      void this.fetcher(`v1/preview/${session}`, { method: "DELETE" }).catch(() => undefined);
      return;
    }
    this.session = session;
    this.sent = { at: 0, time: Number.NaN, playing: false };
    const frames: HTMLIFrameElement[] = [];
    for (const page of pages) {
      const frame = document.createElement("iframe");
      frame.className = "live-page";
      frame.dataset.src = page.url;
      frame.title = "";
      frame.tabIndex = -1;
      frame.referrerPolicy = "no-referrer";
      frame.dataset.track = String(page.track);
      frame.dataset.overlay = String(page.overlay);
      this.frames.set(`${page.track}:${page.overlay}`, frame);
      this.root.append(frame);
      frames.push(frame);
    }
    this.place(this.placements, this.zoom);
    for (const frame of frames) {
      if (generation !== this.generation) return;
      await new Promise<void>((loaded) => {
        const limit = setTimeout(loaded, LOAD_LIMIT);
        frame.addEventListener("load", () => {
          clearTimeout(limit);
          setTimeout(loaded, LOAD_GAP);
        }, { once: true });
        frame.src = frame.dataset.src!;
      });
    }
  }
  /** Moves every page to its box; `zoom` is screen pixels per output pixel. */
  place(placements: Placement[], zoom: number) {
    this.placements = placements;
    this.zoom = zoom;
    const shown = new Set<string>();
    for (const { overlay, track, box } of placements) {
      const key = `${track}:${overlay}`,
        frame = this.frames.get(key),
        layer = this.layers[overlay];
      if (!frame || !layer) continue;
      shown.add(key);
      Object.assign(frame.style, {
        left: `${box.x * zoom}px`,
        top: `${box.y * zoom}px`,
        width: `${layer.width}px`,
        height: `${layer.height}px`,
        transform: `scale(${zoom * layer.scale})`,
        opacity: String(layer.opacity),
      });
    }
    for (const [key, frame] of this.frames) frame.hidden = !shown.has(key);
  }
  /**
   * Sends the replay state at map `time` to the pages, throttled. A preview
   * that is not playing reports the game paused, as vosu does for a paused
   * play: pages stop their clocks, and the still time before playback is not
   * a frame of their animation.
   */
  tick(tracks: readonly Track[], time: number, start: number, playing: boolean) {
    if (!this.session || this.sending) return;
    const now = performance.now();
    const moved = time !== this.sent.time || playing !== this.sent.playing;
    if (now - this.sent.at < (moved ? STATE_INTERVAL : IDLE_INTERVAL)) return;
    const session = this.session;
    const shown = new Set(this.placements.map((p) => p.track));
    this.sending = true;
    this.sent = { at: now, time, playing };
    const states = tracks.map((track, index) =>
      shown.has(index) ? { ...telemetry(track, time, start), game: { paused: !playing } } : null,
    );
    this.fetcher(`v1/preview/${session}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(states),
    })
      .catch((error) => {
        // A preview the service ended (idle, restarted) starts again on the next change.
        if (session === this.session) {
          this.key = "";
          this.report(error);
        }
      })
      .finally(() => {
        this.sending = false;
      });
  }
}
