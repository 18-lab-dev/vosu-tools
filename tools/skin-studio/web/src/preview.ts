// Gameplay preview: a looping demo map per ruleset drawn by render-core with
// the skin being browsed or the mix draft. Muted: there is no audio clock,
// only the loop's own time.

import {
  builtinLook,
  createPlayfield,
  describeBackend,
  loadScope,
  loadPlayfieldSkin,
  overLook,
  playfieldSize,
  type Playfield,
  type Skin,
} from "@vosu-tools/render-core";
import {
  demo,
  demoLoop,
  maniaStill,
  type DemoId,
  type DemoLoop,
} from "@vosu-tools/demo-maps";

/** Returns a skin file by skin-relative name (any case), or null. */
export type Resolver = (file: string) => Promise<Blob | null>;
export interface PreviewSource {
  /** Identity: the same key with the same `version` is not reloaded. */
  key: string;
  version: number;
  name: string;
  resolve: Resolver | null;
}

/** The mania stage the demo draws; skins decode only that one (holds are large). */
const stageKeys = (id: DemoId) => {
  const keys = demo(id).keys;
  return keys ? [keys] : [];
};

export class Preview {
  #canvas: HTMLCanvasElement;
  #stage: HTMLElement;
  #onState: (message: string) => void;
  /** The status line between messages: the backend drawing the preview. */
  #idle = "";
  #state(message: string): void {
    this.#onState(message || this.#idle);
  }
  #renderer?: Playfield;
  #starting?: Promise<Playfield | undefined>;
  #classic = builtinLook("legacy");
  #fileSkin?: Skin;
  #skin: Skin = this.#classic;
  #source?: PreviewSource;
  #loading = 0;
  /** Mania key counts the installed file skin has decoded (joined). */
  #decoded = "";
  #switching = false;
  #loop?: DemoLoop;
  #demo: DemoId = "osu";
  #playing = true;
  #visible = false;
  #epoch = performance.now();
  #pausedAt = 0;
  #frame = 0;
  /** A still mania stage of this many keys instead of the looping demo. */
  #still: number | null = null;
  #stillMap?: DemoLoop["beatmap"];
  /** Frames a still stage is still drawn after a change (images upload meanwhile). */
  #redraws = 0;

  /** Rulesets whose images skins decode (all when omitted): a mania-only view decodes far less. */
  #rulesets?: readonly number[];

  constructor(
    canvas: HTMLCanvasElement,
    stage: HTMLElement,
    onState: (message: string) => void,
    scope: { rulesets?: readonly number[] } = {},
  ) {
    this.#canvas = canvas;
    this.#stage = stage;
    this.#onState = onState;
    this.#rulesets = scope.rulesets;
    new ResizeObserver(() => this.#resize()).observe(stage);
  }

  get playing() {
    return this.#playing;
  }
  get demo() {
    return this.#demo;
  }

  /** Show or hide the pane; nothing is drawn while hidden. */
  async show(visible: boolean) {
    this.#visible = visible;
    if (!visible) {
      cancelAnimationFrame(this.#frame);
      return;
    }
    if (!(await this.#start())) return;
    this.#resize();
    this.#tick();
  }

  setDemo(id: DemoId) {
    if (id === this.#demo && this.#loop) return;
    this.#demo = id;
    this.#loop = demoLoop(id);
    if (this.#still === null)
      this.#renderer?.setBeatmap(this.#loop.beatmap, this.#options());
    this.#epoch = performance.now();
    this.#pausedAt = 0;
    void this.#reconcile();
  }

  /**
   * Draws a still stage of `keys` columns (keys up, a hold and a note in
   * every column) instead of the demo, or the demo again with `null`.
   */
  setStill(keys: number | null) {
    if (keys === this.#still) return;
    this.#still = keys;
    this.#stillMap = keys === null ? undefined : maniaStill(keys);
    const map = this.#stillMap ?? this.#loop?.beatmap;
    if (map) this.#renderer?.setBeatmap(map, this.#options());
    this.#redraws = 30;
    void this.#reconcile();
  }

  /** The mania stage drawn now; skins decode only that one (holds are large). */
  #stageKeys() {
    return this.#still === null ? stageKeys(this.#demo) : [this.#still];
  }

  /**
   * Decodes the demo's mania stage into the file skin (sharing everything
   * else) until the installed skin has it; one run at a time, re-checking
   * after each step since the demo or the source may change meanwhile.
   */
  async #reconcile() {
    if (this.#switching) return;
    this.#switching = true;
    try {
      for (;;) {
        const from = this.#fileSkin,
          keys = this.#stageKeys();
        if (!from || !keys.length || keys.join() === this.#decoded) break;
        this.#state("Loading stage…");
        const next = await loadScope(from, {
          maniaKeys: keys,
          rulesets: this.#rulesets,
        });
        if (this.#fileSkin !== from) releaseExcept(next, this.#fileSkin);
        else this.#install(next, keys.join());
      }
      this.#state("");
    } catch (error) {
      this.#state(error instanceof Error ? error.message : String(error));
    } finally {
      this.#switching = false;
    }
  }

  setPlaying(playing: boolean) {
    if (playing === this.#playing) return;
    const now = performance.now();
    if (playing) this.#epoch = now - this.#pausedAt;
    else this.#pausedAt = now - this.#epoch;
    this.#playing = playing;
  }

  /** Loads the source's skin (unless it is the one shown) over the classic look. */
  async setSource(source: PreviewSource) {
    const same =
      this.#source?.key === source.key &&
      this.#source.version === source.version;
    this.#source = source;
    if (same) return;
    const ticket = ++this.#loading;
    if (!source.resolve) {
      this.#install(undefined);
      return;
    }
    this.#state("Loading skin…");
    try {
      const keys = this.#stageKeys();
      const { files: loaded } = await loadPlayfieldSkin(
        source.resolve,
        source.name,
        { maniaKeys: keys, rulesets: this.#rulesets },
      );
      if (ticket !== this.#loading) {
        releaseExcept(loaded, this.#fileSkin);
        return;
      }
      this.#install(loaded, keys.join());
      this.#state("");
      void this.#reconcile();
    } catch (error) {
      if (ticket === this.#loading)
        this.#state(error instanceof Error ? error.message : String(error));
    }
  }

  #install(fileSkin: Skin | undefined, decoded = "") {
    const previous = this.#fileSkin;
    this.#fileSkin = fileSkin;
    this.#decoded = decoded;
    this.#skin = fileSkin ? overLook(fileSkin) : this.#classic;
    this.#renderer?.setSkin(this.#skin);
    const map = this.#stillMap ?? this.#loop?.beatmap;
    if (map) this.#renderer?.setBeatmap(map, this.#options());
    this.#redraws = 30;
    // The classic look's bitmaps are shared; only the file skin's own are
    // released, and not those the new file skin still uses.
    if (previous) releaseExcept(previous, fileSkin);
  }

  #options() {
    // Product: the skin's combo colours, not the demo map's (the skin is what
    // is being browsed), and a slower mania scroll that shows more of the
    // stage. Everything else is the shared playfield default.
    return { beatmapColours: false, scrollSpeed: 16 };
  }

  /** The status line between messages names the backend drawing. */
  #showBackend(playfield: Playfield): void {
    const backend = describeBackend(playfield);
    this.#idle = playfield.fallbackReason
      ? `${backend.label} (WebGPU unavailable)`
      : backend.label;
    if (playfield.fallbackReason) console.info(backend.detail);
    this.#state("");
  }

  #start(): Promise<Playfield | undefined> {
    this.#starting ??= createPlayfield({
      canvas: this.#canvas,
      skin: this.#skin,
      // A lost GPU device or context: a new renderer on a fresh canvas.
      onRecover: (playfield, reason) => {
        console.info(`Preview restarted: ${reason}`);
        this.#canvas = playfield.canvas as HTMLCanvasElement;
        this.#showBackend(playfield);
        this.#resize();
      },
    }).then(
      (renderer) => {
        this.#renderer = renderer;
        this.#showBackend(renderer);
        renderer.setSkin(this.#skin);
        this.#loop ??= demoLoop(this.#demo);
        renderer.setBeatmap(
          this.#stillMap ?? this.#loop.beatmap,
          this.#options(),
        );
        return renderer;
      },
      (error: unknown) => {
        this.#starting = undefined;
        this.#state(
          `The preview could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      },
    );
    return this.#starting;
  }

  #resize() {
    const { clientWidth, clientHeight } = this.#stage;
    if (this.#renderer) this.#renderer.fit(clientWidth, clientHeight);
    else
      ({ width: this.#canvas.width, height: this.#canvas.height } =
        playfieldSize(clientWidth, clientHeight));
    this.#redraws = 30;
  }

  /** Beatmap time of the loop now. */
  time(): number {
    const loop = this.#loop;
    if (!loop) return 0;
    const elapsed = this.#playing
      ? performance.now() - this.#epoch
      : this.#pausedAt;
    return loop.start + (((elapsed % loop.length) + loop.length) % loop.length);
  }

  #tick = () => {
    if (!this.#visible) return;
    this.#frame = requestAnimationFrame(this.#tick);
    if (!this.#renderer) return;
    try {
      if (this.#still !== null) {
        // A still stage is drawn for a few frames after each change only.
        if (this.#redraws <= 0) return;
        this.#redraws--;
        this.#renderer.renderAt(0, { keys: [] });
      } else if (this.#loop) this.#renderer.renderAt(this.time());
    } catch (error) {
      this.#state(error instanceof Error ? error.message : String(error));
      cancelAnimationFrame(this.#frame);
    }
  };
}

/** Closes `skin`'s bitmaps that `keep` does not also draw. */
function releaseExcept(skin: Skin, keep: Skin | undefined) {
  const kept = new Set(keep?.assets.values());
  for (const bitmap of new Set(skin.assets.values()))
    if (!kept.has(bitmap)) bitmap.close();
}
