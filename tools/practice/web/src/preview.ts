// Playfield preview of the generated map, drawn by render-core. Time is the
// output map's own clock; the source audio is played at the chosen rate and
// re-seeked into each trimmed section (silent in the gaps between them).
import { parseOsu, type Beatmap } from '@vosu-tools/osu-parse';
import { createPlayfield, describeBackend, playfieldSize, type Playfield, type Skin } from '@vosu-tools/render-core';
import { sourceTime, type Window } from './time';

export type PreviewMap = { osu: string; rate: number; windows: Window[]; pitch: boolean };

export class Preview {
  private renderer: Playfield | null = null;
  private creating: Promise<Playfield> | null = null;
  private map: Beatmap | null = null;
  private current: PreviewMap | null = null;
  private time = 0;
  private playing = false;
  private startedAt = 0;
  private startTime = 0;
  private frame = 0;
  private skin: Skin | undefined;
  private showing = 0;
  readonly audio = new Audio();
  private readonly observer = new ResizeObserver(() => this.resize());

  constructor(
    private canvas: HTMLCanvasElement,
    private readonly onTick: (outputMs: number, durationMs: number, playing: boolean) => void,
    private readonly onError: (message: string) => void,
    /** Readies the skin for a map (mania images per key count) before it is drawn. */
    private readonly prepare?: (map: Beatmap) => Promise<void>,
    /** The backend drawing the preview, once it has started. */
    private readonly onBackend?: (backend: { label: string; detail: string }) => void,
  ) {
    this.audio.preload = 'auto';
    this.observer.observe(canvas);
  }

  get duration(): number {
    return this.map ? this.map.duration + 1000 : 0;
  }
  get outputTime(): number {
    return this.time;
  }
  get rate(): number {
    return this.current?.rate ?? 1;
  }
  get windows(): Window[] {
    return this.current?.windows ?? [];
  }

  setAudio(url: string | null): void {
    this.pause();
    if (url) this.audio.src = url;
    else this.audio.removeAttribute('src');
  }

  async show(next: PreviewMap): Promise<void> {
    const map = parseOsu(next.osu);
    if (!map.objects.length) throw new Error('The result has no hit objects.');
    const seq = ++this.showing;
    const renderer = await this.ensureRenderer();
    // The previous map stays drawn until the skin has what this one needs.
    await this.prepare?.(map);
    if (seq !== this.showing) return;
    const keepTime = this.current !== null;
    this.current = next;
    this.map = map;
    renderer.setBeatmap(map);
    this.audio.playbackRate = next.rate;
    this.audio.preservesPitch = next.pitch;
    // Open on the first object so the playfield shows notes straight away.
    if (!keepTime || this.time > this.duration) this.time = map.objects[0]?.time ?? 0;
    this.draw();
  }

  clear(): void {
    this.pause();
    this.map = null;
    this.current = null;
    this.time = 0;
    this.renderer?.renderAt(-1e9);
    this.onTick(0, 0, false);
  }

  seek(outputMs: number): void {
    this.time = Math.min(Math.max(0, outputMs), this.duration);
    if (this.playing) {
      this.startedAt = performance.now();
      this.startTime = this.time;
      this.syncAudio(true);
    }
    this.draw();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (!this.map) return;
    if (this.time >= this.duration) this.time = 0;
    this.playing = true;
    this.startedAt = performance.now();
    this.startTime = this.time;
    this.syncAudio(true);
    const loop = () => {
      if (!this.playing) return;
      this.time = this.startTime + (performance.now() - this.startedAt);
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.pause();
        return;
      }
      this.syncAudio(false);
      this.draw();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.audio.pause();
    this.draw();
  }

  private syncAudio(force: boolean): void {
    if (!this.audio.getAttribute('src')) return;
    const source = sourceTime(this.time, this.rate, this.windows);
    if (source === null) {
      if (!this.audio.paused) this.audio.pause();
      return;
    }
    const drift = Math.abs(this.audio.currentTime * 1000 - source);
    if (force || this.audio.paused || drift > 80) {
      this.audio.currentTime = source / 1000;
      if (this.audio.paused) void this.audio.play().catch(() => this.onError('Audio unavailable.'));
    }
  }

  /** Draw with `skin` (the client's current skin, from ClientSkin). */
  setSkin(skin: Skin): void {
    this.skin = skin;
    this.renderer?.setSkin(skin);
    this.draw();
  }

  private draw(): void {
    if (this.renderer && this.map) this.renderer.renderAt(this.time);
    this.onTick(this.time, this.duration, this.playing);
  }

  private resize(): void {
    // The shared playfield resolution (render-core playfieldSize).
    const { width, height } = playfieldSize(this.canvas.clientWidth, this.canvas.clientHeight);
    if (this.canvas.width === width && this.canvas.height === height) return;
    if (this.renderer) this.renderer.resize(width, height);
    else {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.draw();
  }

  private ensureRenderer(): Promise<Playfield> {
    if (this.renderer) return Promise.resolve(this.renderer);
    this.resize();
    this.creating ??= createPlayfield({
      canvas: this.canvas,
      skin: this.skin,
      // A lost GPU device or context: a new renderer on a fresh canvas.
      onRecover: (playfield, reason) => {
        console.info(`Preview restarted: ${reason}`);
        this.observer.unobserve(this.canvas);
        this.canvas = playfield.canvas as HTMLCanvasElement;
        this.observer.observe(this.canvas);
        this.onBackend?.(describeBackend(playfield));
        this.resize();
      },
    }).then((renderer) => {
      this.renderer = renderer;
      this.onBackend?.(describeBackend(renderer));
      // A skin that arrived while the renderer was being created must still reach it.
      if (this.skin) renderer.setSkin(this.skin);
      this.resize();
      return renderer;
    });
    return this.creating;
  }
}
