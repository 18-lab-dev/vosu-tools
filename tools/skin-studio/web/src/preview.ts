// Gameplay preview: a looping demo map per ruleset drawn by render-core with
// the skin being browsed or the mix draft. Muted: there is no audio clock,
// only the loop's own time.

import {
  builtinSkin,
  createRenderer,
  loadManiaKeys,
  loadSkin,
  withFallback,
  type Renderer,
  type Skin,
} from "@vosu-tools/render-core";
import {
  demo,
  demoLoop,
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
  #renderer?: Renderer;
  #starting?: Promise<Renderer | undefined>;
  #classic = builtinSkin("legacy");
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

  constructor(
    canvas: HTMLCanvasElement,
    stage: HTMLElement,
    onState: (message: string) => void,
  ) {
    this.#canvas = canvas;
    this.#stage = stage;
    this.#onState = onState;
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
    this.#renderer?.setBeatmap(this.#loop.beatmap, this.#options());
    this.#epoch = performance.now();
    this.#pausedAt = 0;
    void this.#reconcile();
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
          keys = stageKeys(this.#demo);
        if (!from || !keys.length || keys.join() === this.#decoded) break;
        this.#onState("Loading stage…");
        const next = await loadManiaKeys(from, keys);
        if (this.#fileSkin !== from) releaseExcept(next, this.#fileSkin);
        else this.#install(next, keys.join());
      }
      this.#onState("");
    } catch (error) {
      this.#onState(error instanceof Error ? error.message : String(error));
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
    this.#onState("Loading skin…");
    try {
      const keys = stageKeys(this.#demo);
      const loaded = await loadSkin(source.resolve, source.name, {
        maniaKeys: keys,
      });
      if (ticket !== this.#loading) {
        releaseExcept(loaded, this.#fileSkin);
        return;
      }
      this.#install(loaded, keys.join());
      this.#onState("");
      void this.#reconcile();
    } catch (error) {
      if (ticket === this.#loading)
        this.#onState(error instanceof Error ? error.message : String(error));
    }
  }

  #install(fileSkin: Skin | undefined, decoded = "") {
    const previous = this.#fileSkin;
    this.#fileSkin = fileSkin;
    this.#decoded = decoded;
    this.#skin = fileSkin
      ? withFallback(fileSkin, this.#classic)
      : this.#classic;
    this.#renderer?.setSkin(this.#skin);
    if (this.#loop)
      this.#renderer?.setBeatmap(this.#loop.beatmap, this.#options());
    // The classic look's bitmaps are shared; only the file skin's own are
    // released, and not those the new file skin still uses.
    if (previous) releaseExcept(previous, fileSkin);
  }

  #options() {
    // Skin combo colours, not the demo map's; a slower mania scroll shows more of the stage.
    return { beatmapColours: false, scrollSpeed: 16 };
  }

  #start(): Promise<Renderer | undefined> {
    this.#starting ??= createRenderer({
      canvas: this.#canvas,
      skin: this.#skin,
      clearColour: playfieldColour(),
      presentation:
        new URLSearchParams(location.search).get("presentation") === "bitmap"
          ? "bitmap"
          : "direct",
    }).then(
      (renderer) => {
        this.#renderer = renderer;
        renderer.setSkin(this.#skin);
        this.#loop ??= demoLoop(this.#demo);
        renderer.setBeatmap(this.#loop.beatmap, this.#options());
        return renderer;
      },
      () => {
        this.#starting = undefined;
        this.#onState("WebGPU unavailable");
        return undefined;
      },
    );
    return this.#starting;
  }

  #resize() {
    const scale = Math.min(window.devicePixelRatio || 1, 2),
      width = Math.max(1, Math.round(this.#stage.clientWidth * scale)),
      height = Math.max(1, Math.round(this.#stage.clientHeight * scale));
    if (this.#renderer) this.#renderer.resize(width, height);
    else {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
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
    if (!this.#renderer || !this.#loop) return;
    try {
      this.#renderer.renderAt(this.time());
    } catch (error) {
      this.#onState(error instanceof Error ? error.message : String(error));
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

/** The playfield colour: the darkest system surface in either scheme. */
function playfieldColour(): GPUColor {
  const root = getComputedStyle(document.documentElement),
    light = document.documentElement.dataset.theme === "light",
    token = root.getPropertyValue(light ? "--fg" : "--bg-sunken").trim(),
    probe = new OffscreenCanvas(1, 1).getContext("2d")!;
  probe.fillStyle = token || "#0b0c0d";
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
}
