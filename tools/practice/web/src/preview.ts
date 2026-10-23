// Playfield preview of the generated map, drawn by render-core. Time is the
// output map's own clock; the source audio is played at the chosen rate and
// re-seeked into each trimmed section (silent in the gaps between them).
import { parseOsu, type Beatmap } from '@vosu-tools/osu-parse';
import { createRenderer, type Renderer } from '@vosu-tools/render-core';
import { sourceTime, type Window } from './time';

export type PreviewMap = { osu: string; rate: number; windows: Window[]; pitch: boolean };

export class Preview {
  private renderer: Renderer | null = null;
  private creating: Promise<Renderer> | null = null;
  private map: Beatmap | null = null;
  private current: PreviewMap | null = null;
  private time = 0;
  private playing = false;
  private startedAt = 0;
  private startTime = 0;
  private frame = 0;
  readonly audio = new Audio();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onTick: (outputMs: number, durationMs: number, playing: boolean) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.audio.preload = 'auto';
    new ResizeObserver(() => this.resize()).observe(canvas);
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
    if (!('gpu' in navigator)) throw new Error('Preview needs WebGPU.');
    const renderer = await this.ensureRenderer();
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

  private draw(): void {
    if (this.renderer && this.map) this.renderer.renderAt(this.time);
    this.onTick(this.time, this.duration, this.playing);
  }

  private resize(): void {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer?.resize(width, height);
    this.draw();
  }

  private ensureRenderer(): Promise<Renderer> {
    if (this.renderer) return Promise.resolve(this.renderer);
    this.resize();
    // `?presentation=bitmap` (as in Map preview) copies frames into a bitmap
    // canvas so headless captures can see them; normal use presents directly.
    const presentation = new URLSearchParams(location.search).get('presentation') === 'bitmap' ? 'bitmap' : 'direct';
    this.creating ??= createRenderer({ canvas: this.canvas, clearColour: stageColour(this.canvas), presentation }).then((renderer) => {
      this.renderer = renderer;
      this.resize();
      return renderer;
    });
    return this.creating;
  }
}

/** The stage's CSS background as the renderer's (opaque) clear colour. */
function stageColour(canvas: HTMLCanvasElement): GPUColor {
  const parent = canvas.parentElement ?? canvas;
  const [r, g, b] = (getComputedStyle(parent).backgroundColor.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number);
  return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
}
